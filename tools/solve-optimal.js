/*
 * Exact long-game table generator.
 *
 *   node tools/solve-optimal.js
 *   node tools/solve-optimal.js --official   # benchmark check, no files
 *   node tools/solve-optimal.js --strict     # stricter joker reading
 *   node tools/solve-optimal.js --workers=16
 *   node tools/solve-optimal.js --workers=1 --max-pop=2   # smoke, no files
 *
 * The state is (B, u, y):
 *   B  open-box bitmask, 13 bits
 *   u  upper total, capped at 63
 *   y  1 only when the Yahtzee box is closed with 50
 *
 * W(B,u,y) is the expected additional score from the start of a turn.  Valid
 * states are 786,432; the full indexed Float32 table is 1,048,576 entries.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const Engine = require('../src/engine.js');

const TABLE_SIZE = Engine.TABLE_SIZE;
const N_STATES = 252;
const N_CATS = 13;
const FULL_BITS = (1 << N_CATS) - 1;
const YAHTZEE_BIT = 1 << 11;
const LOWER_BITS = ((1 << 13) - 1) & ~((1 << 6) - 1);
const UPPER_TARGET = 63;
const UPPER_BONUS = 35;
const YAHTZEE_BONUS = 100;
const BENCHMARK_EXPECTED = 254.5896;
const TOTAL_STATES = 786432;
const ROOT = path.join(__dirname, '..');

function makeScratch() {
  return {
    v0: new Float64Array(N_STATES),
    v1: new Float64Array(N_STATES),
    v2: new Float64Array(N_STATES),
    hold1: new Int16Array(N_STATES),
    hold2: new Int16Array(N_STATES)
  };
}

function buildFiveFace(model) {
  const face = new Int8Array(N_STATES);
  for (let s = 0; s < N_STATES; s++) {
    if (!model.fiveKind[s]) continue;
    for (let f = 0; f < 6; f++) {
      if (model.stateCounts[s][f] === 5) { face[s] = f + 1; break; }
    }
  }
  return face;
}

function openCatsFor(bits) {
  const out = [];
  for (let ci = 0; ci < N_CATS; ci++) {
    if (bits & (1 << ci)) out.push(ci);
  }
  return out;
}

function splitMasks(masks, count) {
  const size = Math.ceil(masks.length / count);
  const chunks = [];
  for (let i = 0; i < count; i++) chunks.push(masks.slice(i * size, (i + 1) * size));
  return chunks;
}

/**
 * Compute every valid (u, y) entry for one open-box mask.  Writes in place and
 * returns the number of states solved.  `W` is Float32 for repo rules and
 * Float64 for the official validation modes.
 */
function computeMask(W, model, bits, mode, fiveFace, scratch) {
  const openCats = openCatsFor(bits);
  const yahtzeeOpen = !!(bits & YAHTZEE_BIT);
  const official = mode === 'official';
  const strict = mode === 'strict';
  let count = 0;

  for (let upper = 0; upper <= 63; upper++) {
    for (let y = 0; y <= 1; y++) {
      if (yahtzeeOpen && y === 1) continue;

      const term = (official || strict)
        ? function (ci, s) {
          const sc = model.scores[ci][s];
          const five = model.fiveKind[s];

          if (!five) {
            const next = bits & ~(1 << ci);
            const u2 = upper + (ci < 6 ? sc : 0);
            const uu = u2 >= UPPER_TARGET ? UPPER_TARGET : u2;
            const y2 = ci === 11 ? (sc === 50 ? 1 : 0) : y;
            return sc + W[((next * 64) + uu) * 2 + (y2 ? 1 : 0)];
          }

          if (bits & YAHTZEE_BIT) {
            // The Yahtzee box is open: a normal first Yahtzee.
            const next = bits & ~(1 << ci);
            const u2 = upper + (ci < 6 ? sc : 0);
            const uu = u2 >= UPPER_TARGET ? UPPER_TARGET : u2;
            const y2 = ci === 11 ? 1 : y;
            return sc + W[((next * 64) + uu) * 2 + (y2 ? 1 : 0)];
          }

          // The Yahtzee box is closed: joker placement.
          const face = fiveFace[s];
          const match = face - 1;
          let legal;
          let score;

          if (bits & (1 << match)) {
            // Rule 1: the matching upper box is the only legal box.
            legal = ci === match;
            score = sc;
          } else if (bits & LOWER_BITS) {
            // Any open lower box is legal, with the joker values.  The
            // official rules also allow a zero in an open upper box; the
            // strict reading only allows that after the lower section is full.
            legal = (ci >= 6 && ci <= 12) || (official && ci < 6);
            if (ci < 6) score = 0;
            else if (ci === 8) score = 25;
            else if (ci === 9) score = 30;
            else if (ci === 10) score = 40;
            else score = sc;
          } else {
            // The lower section is full: zero in any open upper box.
            legal = ci < 6;
            score = 0;
          }

          if (!legal) return -Infinity;

          const next = bits & ~(1 << ci);
          const u2 = upper + (ci < 6 ? score : 0);
          const uu = u2 >= UPPER_TARGET ? UPPER_TARGET : u2;
          const y2 = ci === 11 ? (sc === 50 ? 1 : 0) : y;
          let value = score + W[((next * 64) + uu) * 2 + (y2 ? 1 : 0)];
          if (y) value += YAHTZEE_BONUS;
          return value;
        }
        : function (ci, s) {
          const sc = model.scores[ci][s];
          const next = bits & ~(1 << ci);
          const u2 = upper + (ci < 6 ? sc : 0);
          const uu = u2 >= UPPER_TARGET ? UPPER_TARGET : u2;
          const y2 = ci === 11 ? (sc === 50 ? 1 : 0) : y;
          let value = sc + W[((next * 64) + uu) * 2 + (y2 ? 1 : 0)];
          if (y && model.fiveKind[s]) value += YAHTZEE_BONUS;
          return value;
        };

      const v2 = Engine.solveTurnValues(model, openCats, term, scratch);
      let expected = 0;
      for (let s = 0; s < N_STATES; s++) expected += model.freshProb[s] * v2[s];
      W[Engine.tableIndex(bits, upper, y)] = expected;
      count++;
    }
  }

  return count;
}

function fillTerminal(W) {
  for (let upper = 0; upper <= 63; upper++) {
    const value = upper >= UPPER_TARGET ? UPPER_BONUS : 0;
    W[Engine.tableIndex(0, upper, 0)] = value;
    W[Engine.tableIndex(0, upper, 1)] = value;
  }
}

function popcount(bits) {
  let n = 0;
  while (bits) { n += bits & 1; bits >>>= 1; }
  return n;
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '?';
  const s = Math.round(seconds);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m + 'm ' + r + 's';
}

function parseArgs(argv) {
  const opts = {
    mode: 'repo',
    workers: Math.max(1, Math.min(16, (os.cpus() || []).length || 1)),
    maxPop: 13
  };

  for (const arg of argv) {
    if (arg === '--official') {
      if (opts.mode !== 'repo') throw new Error('Choose one of --official or --strict.');
      opts.mode = 'official';
    } else if (arg === '--strict') {
      if (opts.mode !== 'repo') throw new Error('Choose one of --official or --strict.');
      opts.mode = 'strict';
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node tools/solve-optimal.js [--official | --strict] [--workers=N] [--max-pop=N]');
      process.exit(0);
    } else if (arg.startsWith('--workers=')) {
      opts.workers = parseInt(arg.slice('--workers='.length), 10);
    } else if (arg.startsWith('--max-pop=')) {
      opts.maxPop = parseInt(arg.slice('--max-pop='.length), 10);
    } else {
      throw new Error('Unknown argument: ' + arg);
    }
  }

  if (!Number.isInteger(opts.workers) || opts.workers < 1) {
    throw new Error('--workers must be a positive integer');
  }
  if (!Number.isInteger(opts.maxPop) || opts.maxPop < 1 || opts.maxPop > 13) {
    throw new Error('--max-pop must be between 1 and 13');
  }
  return opts;
}

function writeOutputs(W, full) {
  const binPath = path.join(ROOT, 'tools', 'optimal-table.bin');
  const jsPath = path.join(ROOT, 'src', 'optimal-table.js');
  const bytes = Buffer.from(new Uint8Array(W.buffer, W.byteOffset, W.byteLength));
  const b64 = bytes.toString('base64');
  const header = '/* Generated by tools/solve-optimal.js. Repo rules. W(8191,0,0) = ' +
    full.toFixed(6) + '. */\n';
  const script = header +
    '(function (root) {\n' +
    '  root.YAHTZEE_OPTIMAL_B64 = "' + b64 + '";\n' +
    '})(typeof globalThis !== "undefined" ? globalThis : this);\n';

  fs.writeFileSync(binPath, bytes);
  fs.writeFileSync(jsPath, script);

  console.log('Wrote ' + binPath + ' (' + bytes.length + ' bytes)');
  console.log('Wrote ' + jsPath + ' (' + Buffer.byteLength(script) + ' bytes)');
}

function runLayer(workers, masks) {
  return new Promise(function (resolve, reject) {
    const chunks = splitMasks(masks, workers.length);
    let remaining = workers.length;
    let states = 0;

    workers.forEach(function (worker, i) {
      function cleanup() {
        worker.off('message', onMessage);
        worker.off('error', onError);
      }

      function onMessage(msg) {
        if (!msg || msg.type !== 'done') return;
        cleanup();
        states += msg.count;
        remaining--;
        if (remaining === 0) resolve(states);
      }

      function onError(err) {
        cleanup();
        reject(err);
      }

      worker.on('message', onMessage);
      worker.on('error', onError);
      worker.postMessage({ type: 'layer', masks: chunks[i] });
    });
  });
}

async function stopWorkers(workers) {
  for (const worker of workers) {
    try { worker.postMessage({ type: 'exit' }); } catch (err) { /* already gone */ }
  }
  await Promise.all(workers.map(function (worker) {
    return worker.terminate().catch(function () { return 0; });
  }));
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const mode = opts.mode;
  const official = mode === 'official';
  const strict = mode === 'strict';
  const float64 = mode !== 'repo';
  const started = Date.now();
  const model = Engine.getModel();

  const modeLabel = mode === 'repo'
    ? 'repo rules (Float32)'
    : official
      ? 'official rules, benchmark check (Float64)'
      : 'strict joker reading (Float64 validation)';
  console.log('Mode: ' + modeLabel);
  console.log('Workers: ' + opts.workers + ', layers: 1..' + opts.maxPop);
  console.log('Valid states: ' + TOTAL_STATES + ', indexed slots: ' + TABLE_SIZE);

  const W = float64
    ? new Float64Array(new SharedArrayBuffer(TABLE_SIZE * 8))
    : new Float32Array(new SharedArrayBuffer(TABLE_SIZE * 4));
  fillTerminal(W);

  const masksByPop = Array.from({ length: 14 }, function () { return []; });
  for (let bits = 1; bits <= FULL_BITS; bits++) {
    masksByPop[popcount(bits)].push(bits);
  }

  const inlineScratch = opts.workers === 1 ? makeScratch() : null;
  const inlineFiveFace = opts.workers === 1 && mode !== 'repo' ? buildFiveFace(model) : null;
  const workers = [];

  try {
    if (opts.workers > 1) {
      for (let i = 0; i < opts.workers; i++) {
        workers.push(new Worker(__filename, {
          workerData: { WBuffer: W.buffer, mode: mode }
        }));
      }
    }

    let processed = 0;

    for (let pc = 1; pc <= opts.maxPop; pc++) {
      const masks = masksByPop[pc];
      const layerStart = Date.now();
      let states;

      if (opts.workers === 1) {
        states = 0;
        for (const bits of masks) {
          states += computeMask(W, model, bits, mode, inlineFiveFace, inlineScratch);
        }
      } else {
        states = await runLayer(workers, masks);
      }

      processed += states;
      const elapsed = (Date.now() - started) / 1000;
      const layerSeconds = (Date.now() - layerStart) / 1000;
      const eta = processed ? (elapsed / processed) * (TOTAL_STATES - processed) : 0;

      console.log(
        'popcount ' + pc + ': ' + masks.length + ' masks, ' + states + ' states, ' +
        layerSeconds.toFixed(1) + 's layer, ' + elapsed.toFixed(1) + 's total, ' +
        'ETA ' + formatDuration(eta)
      );

      if (pc === 1) {
        let maxDiff = 0;
        for (let ci = 0; ci < N_CATS; ci++) {
          // Both validation conventions score an extra Yahtzee 30/40 in a
          // straight; the repo soloEV scores it 0, so those two categories are
          // not comparable outside repo mode.
          if (mode !== 'repo' && (ci === 9 || ci === 10)) continue;
          const value = W[Engine.tableIndex(1 << ci, 0, 0)];
          maxDiff = Math.max(maxDiff, Math.abs(value - model.soloEV[ci]));
        }
        console.log('single-box max difference vs soloEV: ' + maxDiff.toExponential(3));
        if (maxDiff > 0.01) {
          throw new Error('Single-box check failed; the DP or terminal values are wrong.');
        }
      }
    }

    if (opts.maxPop < 13) {
      console.log('Smoke run complete; no table files written.');
      return;
    }

    const full = W[Engine.tableIndex(FULL_BITS, 0, 0)];
    console.log('W(8191,0,0) = ' + full.toFixed(6));

    if (!Number.isFinite(full) || full <= 0) {
      throw new Error('Full-card table value is not usable: ' + full);
    }

    if (official) {
      const diff = Math.abs(full - BENCHMARK_EXPECTED);
      console.log('Benchmark target: ' + BENCHMARK_EXPECTED.toFixed(4) + ', difference: ' + diff.toExponential(3));
      if (diff > 0.001) {
        console.error('Official validation FAILED.');
        process.exitCode = 1;
      } else {
        console.log('Official validation OK.');
      }
      return;
    }

    if (strict) {
      const diff = Math.abs(full - BENCHMARK_EXPECTED);
      console.log('Strict forced-joker value recorded.');
      console.log('Distance from the published benchmark: ' + diff.toExponential(3));
      return;
    }

    writeOutputs(W, full);
    console.log('Total time: ' + formatDuration((Date.now() - started) / 1000));
  } finally {
    await stopWorkers(workers);
  }
}

function runWorker() {
  const mode = workerData.mode || 'repo';
  const model = Engine.getModel();
  const W = mode === 'repo'
    ? new Float32Array(workerData.WBuffer)
    : new Float64Array(workerData.WBuffer);
  const scratch = makeScratch();
  const fiveFace = mode !== 'repo' ? buildFiveFace(model) : null;

  parentPort.on('message', function (msg) {
    if (!msg) return;
    if (msg.type === 'exit') {
      process.exit(0);
      return;
    }
    if (msg.type !== 'layer') return;

    let count = 0;
    for (const bits of msg.masks) {
      count += computeMask(W, model, bits, mode, fiveFace, scratch);
    }
    parentPort.postMessage({ type: 'done', count: count });
  });
}

if (!isMainThread) {
  runWorker();
} else {
  main().catch(function (err) {
    console.error(err && err.stack ? err.stack : err);
    process.exitCode = 1;
  });
}
