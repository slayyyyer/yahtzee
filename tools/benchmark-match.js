'use strict';

/**
 * Headless match benchmark: two independent Exact-W players.
 *
 *   node tools/benchmark-match.js
 *   node tools/benchmark-match.js --games=100 --seed=20261028
 *
 * The playing model is Exact-W: the engine's exact expected-score policy,
 * using the shipped W(B,u,y) table. There is no browser and no LLM in the
 * decision loop. Dice come from a seeded Mulberry32 PRNG.
 */

const fs = require('fs');
const path = require('path');

const Engine = require(path.join(__dirname, '..', 'src', 'engine.js'));
const { loadOptimalTable } = require('./load-table.js');
const { playGame, mulberry32 } = require('./train.js');

const CATS = Engine.CAT_IDS;
const MODEL = 'Exact-W';
const MODEL_NOTE = 'Exact expected-score dynamic programming over the shipped W(B,u,y) table; no browser, no LLM in the decision loop.';
const T95_99 = 1.984217;

function parseArgs(argv) {
  const opts = { games: 100, seed: 20261028, out: 'reports/yahtzee-verification-100.json' };
  for (const arg of argv) {
    const m = arg.match(/^--([\w]+)=(.+)$/);
    if (!m) continue;
    if (m[1] === 'games') opts.games = Math.max(1, parseInt(m[2], 10));
    else if (m[1] === 'seed') opts.seed = parseInt(m[2], 10);
    else if (m[1] === 'out') opts.out = m[2];
  }
  return opts;
}

function mean(a) { return a.reduce((s, x) => s + x, 0) / a.length; }
function sd(a) {
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) * (x - m), 0) / (a.length - 1));
}
function median(a) {
  const s = a.slice().sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function stats(a) {
  const m = mean(a);
  const s = sd(a);
  const se = s / Math.sqrt(a.length);
  return {
    mean: +m.toFixed(4),
    sd: +s.toFixed(4),
    se: +se.toFixed(4),
    median: +median(a).toFixed(4),
    min: Math.min.apply(null, a),
    max: Math.max.apply(null, a),
    ci95: [+(m - T95_99 * se).toFixed(4), +(m + T95_99 * se).toFixed(4)]
  };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const table = loadOptimalTable();
  if (!table) {
    console.error('No optimal table found at tools/optimal-table.bin. Run tools/solve-optimal.js first.');
    process.exitCode = 1;
    return;
  }

  const engine = Engine.createEngine({ optimalTable: table });
  const rng = mulberry32(opts.seed);
  const games = [];
  const t0 = Date.now();

  for (let i = 0; i < opts.games; i++) {
    const player = playGame(engine, rng);
    const cpu = playGame(engine, rng);
    const playerTotal = Engine.totalScore(player);
    const cpuTotal = Engine.totalScore(cpu);
    const margin = playerTotal - cpuTotal;
    games.push({
      id: i + 1,
      player: playerTotal,
      cpu: cpuTotal,
      margin: margin,
      result: margin > 0 ? 'win' : margin < 0 ? 'loss' : 'tie',
      playerUpper: Engine.upperScore(player),
      cpuUpper: Engine.upperScore(cpu),
      playerUpperBonus: Engine.upperBonus(player),
      cpuUpperBonus: Engine.upperBonus(cpu),
      playerYahtzeeBonus: player.yahtzeeBonus || 0,
      cpuYahtzeeBonus: cpu.yahtzeeBonus || 0,
      playerCard: player.scores,
      cpuCard: cpu.scores
    });
  }

  const player = games.map(g => g.player);
  const cpu = games.map(g => g.cpu);
  const margins = games.map(g => g.margin);
  const record = games.reduce((r, g) => {
    if (g.result === 'win') r.wins++;
    else if (g.result === 'loss') r.losses++;
    else r.ties++;
    return r;
  }, { wins: 0, losses: 0, ties: 0 });

  const catAvg = {};
  CATS.forEach(id => {
    catAvg[id] = {
      player: +(games.reduce((s, g) => s + (Number(g.playerCard[id]) || 0), 0) / games.length).toFixed(4),
      cpu: +(games.reduce((s, g) => s + (Number(g.cpuCard[id]) || 0), 0) / games.length).toFixed(4)
    };
  });

  const summary = {
    model: MODEL,
    modelNote: MODEL_NOTE,
    seed: opts.seed,
    games: opts.games,
    elapsedMs: Date.now() - t0,
    record: record,
    winRate: +(100 * record.wins / games.length).toFixed(2),
    player: stats(player),
    cpu: stats(cpu),
    margin: Object.assign(stats(margins), {
      t: +(mean(margins) / (sd(margins) / Math.sqrt(margins.length))).toFixed(3)
    }),
    upperBonusGames: {
      player: games.filter(g => g.playerUpperBonus > 0).length,
      cpu: games.filter(g => g.cpuUpperBonus > 0).length
    },
    yahtzeeBonusPoints: {
      player: games.reduce((s, g) => s + g.playerYahtzeeBonus, 0),
      cpu: games.reduce((s, g) => s + g.cpuYahtzeeBonus, 0)
    },
    categoryAverages: catAvg
  };

  const output = {
    meta: {
      title: 'Yahtzee Exact-W headless verification',
      date: '2026-10-28',
      model: MODEL,
      modelNote: MODEL_NOTE,
      seed: opts.seed,
      engine: 'src/engine.js with tools/optimal-table.bin',
      rules: 'Repo rules: +35 upper bonus at 63; +100 extra Yahtzee after a 50; an extra Yahtzee may be banked in any open box.',
      sample: opts.games + ' complete head-to-head games; both sides use Exact-W.'
    },
    summary: summary,
    games: games
  };

  const out = path.isAbsolute(opts.out) ? opts.out : path.join(__dirname, '..', opts.out);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(output, null, 2) + '\n', 'utf8');

  console.log('Model: ' + MODEL);
  console.log(MODEL_NOTE);
  console.log('Seed: ' + opts.seed + ' · games: ' + opts.games + ' · ' + summary.elapsedMs + ' ms');
  console.log('Record: ' + record.wins + '-' + record.losses + '-' + record.ties + ' (' + summary.winRate + '% wins)');
  console.log('Player: mean ' + summary.player.mean + ', SD ' + summary.player.sd + ', 95% CI ' + summary.player.ci95.join('–'));
  console.log('CPU:    mean ' + summary.cpu.mean + ', SD ' + summary.cpu.sd + ', 95% CI ' + summary.cpu.ci95.join('–'));
  console.log('Margin: mean ' + summary.margin.mean + ', SD ' + summary.margin.sd + ', 95% CI ' + summary.margin.ci95.join('–') + ', t ' + summary.margin.t);
  console.log('Upper bonus: ' + summary.upperBonusGames.player + '/' + opts.games + ' vs ' + summary.upperBonusGames.cpu + '/' + opts.games);
  console.log('Yahtzee bonus points: ' + summary.yahtzeeBonusPoints.player + ' vs ' + summary.yahtzeeBonusPoints.cpu);
  console.log('Wrote ' + out);
}

if (require.main === module) main();

module.exports = { main, MODEL };
