'use strict';

/*
 * Exact state-level comparison of Match-W against the shipped Exact-W policy.
 *
 *   node tools/compare-matchw.js --games=100 --seed=20261028
 *   node tools/compare-matchw.js --games=10 --start-round=11 --clear
 *
 * For each real game state at the start of the chosen round through round 13,
 * both policies are evaluated with the exact CPU distribution:
 *
 *   match  = optimal P(win) + 0.5*P(tie) from this state
 *   exact  = the same objective under the fixed Exact-W policy
 *
 * The difference is a paired quantity, so it is not obscured by dice noise.
 */

const fs = require('fs');
const path = require('path');
const Engine = require(path.join(__dirname, '..', 'src', 'engine.js'));
const { loadOptimalTable } = require('./load-table.js');
const { createMatchSolver } = require('./match-solver.js');
const { playTurn, mulberry32 } = require('./benchmark-matchw.js');

function cloneCard(card) {
  return {
    scores: Object.assign({}, card.scores),
    yahtzeeBonus: card.yahtzeeBonus || 0
  };
}

function mean(xs) {
  let s = 0;
  for (let i = 0; i < xs.length; i++) s += xs[i];
  return xs.length ? s / xs.length : 0;
}

function sd(xs) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  let s = 0;
  for (let i = 0; i < xs.length; i++) {
    const d = xs[i] - m;
    s += d * d;
  }
  return Math.sqrt(s / (xs.length - 1));
}

function summarize(xs) {
  const m = mean(xs);
  const s = sd(xs);
  const se = xs.length ? s / Math.sqrt(xs.length) : 0;
  return {
    n: xs.length,
    mean: +m.toFixed(6),
    sd: +s.toFixed(6),
    se: +se.toFixed(6),
    min: xs.length ? +Math.min.apply(null, xs).toFixed(6) : 0,
    max: xs.length ? +Math.max.apply(null, xs).toFixed(6) : 0
  };
}

function playRoundExact(engine, cards, rng) {
  const playerSolver = engine.solve(Engine.openCategories(cards[0]), cards[0]);
  playTurn(engine, cards[0], playerSolver, rng);
  const cpuSolver = engine.solve(Engine.openCategories(cards[1]), cards[1]);
  playTurn(engine, cards[1], cpuSolver, rng);
}

function parseArgs(argv) {
  const opts = {
    games: 100,
    seed: 20261028,
    startRound: 12,
    clear: false,
    out: 'reports/yahtzee-matchw-evaluation.json'
  };
  for (const arg of argv) {
    if (arg === '--clear') { opts.clear = true; continue; }
    const m = arg.match(/^--([\w-]+)=(.+)$/);
    if (!m) continue;
    if (m[1] === 'games') opts.games = Math.max(1, parseInt(m[2], 10));
    else if (m[1] === 'seed') opts.seed = parseInt(m[2], 10);
    else if (m[1] === 'start-round') opts.startRound = parseInt(m[2], 10);
    else if (m[1] === 'out') opts.out = m[2];
  }
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const table = loadOptimalTable();
  if (!table) {
    console.error('No optimal table found at tools/optimal-table.bin. Run tools/solve-optimal.js first.');
    process.exitCode = 1;
    return;
  }

  if (!(opts.startRound >= 11 && opts.startRound <= 13)) {
    console.error('--start-round must be 11, 12, or 13.');
    process.exitCode = 1;
    return;
  }

  const engine = Engine.createEngine({ optimalTable: table });
  const matchSolver = createMatchSolver(engine);
  const rng = mulberry32(opts.seed);
  const states = [];
  const t0 = Date.now();

  for (let g = 1; g <= opts.games; g++) {
    const cards = [Engine.blankCard(), Engine.blankCard()];
    for (let round = 1; round < opts.startRound; round++) playRoundExact(engine, cards, rng);

    for (let round = opts.startRound; round <= 13; round++) {
      const snapshot = [cloneCard(cards[0]), cloneCard(cards[1])];
      const playerTotal = engine.totalScore(snapshot[0]);
      const cpuTotal = engine.totalScore(snapshot[1]);
      const cmp = matchSolver.compareFromCards(snapshot[0], snapshot[1], round);
      states.push({
        game: g,
        round: round,
        playerTotal: playerTotal,
        cpuTotal: cpuTotal,
        margin: playerTotal - cpuTotal,
        playerOpen: Engine.openCategories(snapshot[0]).length,
        cpuOpen: Engine.openCategories(snapshot[1]).length,
        match: cmp.match,
        exact: cmp.exact,
        diff: cmp.diff
      });
      if (round < 13) playRoundExact(engine, cards, rng);
    }

    if (opts.clear) matchSolver.clear();
    if (g % 5 === 0 || g === opts.games) {
      console.log('game ' + g + '/' + opts.games + ' - ' + Math.round((Date.now() - t0) / 1000) + 's');
    }
  }

  const byRound = {};
  for (let round = opts.startRound; round <= 13; round++) {
    const subset = states.filter(function (s) { return s.round === round; });
    const diffs = subset.map(function (s) { return s.diff; });
    const matches = subset.map(function (s) { return s.match; });
    const exacts = subset.map(function (s) { return s.exact; });
    byRound[round] = {
      states: subset.length,
      match: summarize(matches),
      exact: summarize(exacts),
      diff: summarize(diffs),
      improved: subset.filter(function (s) { return s.diff > 1e-9; }).length,
      equal: subset.filter(function (s) { return Math.abs(s.diff) <= 1e-9; }).length,
      worse: subset.filter(function (s) { return s.diff < -1e-9; }).length,
      behind: summarize(subset.filter(function (s) { return s.margin < 0; }).map(function (s) { return s.diff; })),
      ahead: summarize(subset.filter(function (s) { return s.margin > 0; }).map(function (s) { return s.diff; }))
    };
  }

  const allDiffs = states.map(function (s) { return s.diff; });
  const summary = {
    seed: opts.seed,
    games: opts.games,
    startRound: opts.startRound,
    clearBetweenGames: opts.clear,
    elapsedMs: Date.now() - t0,
    states: states.length,
    all: summarize(allDiffs),
    byRound: byRound,
    solverCaches: matchSolver.stats()
  };

  fs.mkdirSync(path.dirname(path.resolve(opts.out)), { recursive: true });
  fs.writeFileSync(opts.out, JSON.stringify({ summary: summary, states: states }, null, 2) + '\n');
  console.log('\n' + JSON.stringify(summary, null, 2));
  console.log('\nWrote ' + opts.out);
}

if (require.main === module) main();

module.exports = { cloneCard, playRoundExact };
