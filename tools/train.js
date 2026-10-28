/*
 * Offline trainer / evaluator for the Yahtzee engine.
 * Run with:  node tools/train.js
 *
 * It plays complete games with the same policy the browser uses, so the
 * tuning constants in src/engine.js are measured, not guessed.  Dice are
 * driven by a seeded PRNG, so different parameter sets can share the same
 * random stream (common random numbers) to keep comparisons fair.
 */
'use strict';

const path = require('path');
const Engine = require(path.join(__dirname, '..', 'src', 'engine.js'));
const { loadOptimalTable } = require('./load-table.js');

const CATS = Engine.CAT_IDS;

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function die(rng) {
  return 1 + Math.floor(rng() * 6);
}

function rollFive(rng) {
  return [die(rng), die(rng), die(rng), die(rng), die(rng)];
}

function reroll(dice, hold, rng) {
  const out = dice.slice();
  for (let i = 0; i < out.length; i++) if (!hold[i]) out[i] = die(rng);
  return out;
}

const EMPTY_STATS = {
  games: 0,
  scoreSum: 0,
  scoreSqSum: 0,
  bonus: 0,
  yahtzeeBonus: 0,
  upperSum: 0,
  lowerSum: 0,
  catSum: null,
  catWins: null
};

function newStats() {
  const s = Object.assign({}, EMPTY_STATS);
  s.catSum = new Array(13).fill(0);
  s.catWins = new Array(13).fill(0);
  return s;
}

function addResult(stats, card) {
  stats.games++;
  const score = Engine.totalScore(card);
  stats.scoreSum += score;
  stats.scoreSqSum += score * score;
  stats.upperSum += Engine.upperScore(card);
  stats.lowerSum += Engine.lowerScore(card);
  if (Engine.upperBonus(card)) stats.bonus++;
  stats.yahtzeeBonus += card.yahtzeeBonus || 0;
  for (let i = 0; i < 13; i++) {
    const v = card.scores[CATS[i]] || 0;
    stats.catSum[i] += v;
    if (v > 0) stats.catWins[i]++;
  }
}

function playGame(engine, rng) {
  const card = Engine.blankCard();

  for (let turn = 0; turn < 13; turn++) {
    const open = Engine.openCategories(card);
    if (open.length === 0) break;
    const solver = engine.solve(open, card);

    let dice = rollFive(rng);
    let rollsLeft = 2;
    while (rollsLeft > 0) {
      const decision = solver.bestKeep(dice, rollsLeft);
      if (!decision || decision.holdAll) break;
      dice = reroll(dice, decision.hold, rng);
      rollsLeft--;
    }
    const choice = solver.bestCategory(dice);
    if (!choice) throw new Error('no category for ' + dice.join(',') + ' open=' + open.join(','));

    const bonus = engine.yahtzeeBonusFor(card, dice);
    if (bonus) card.yahtzeeBonus += bonus;
    card.scores[choice.catId] = choice.score;
  }

  return card;
}

function summarize(stats) {
  const n = stats.games;
  const mean = stats.scoreSum / n;
  const variance = Math.max(0, stats.scoreSqSum / n - mean * mean);
  return {
    games: n,
    mean: +mean.toFixed(2),
    sd: +Math.sqrt(variance).toFixed(2),
    upper: +(stats.upperSum / n).toFixed(2),
    lower: +(stats.lowerSum / n).toFixed(2),
    bonusRate: +((100 * stats.bonus) / n).toFixed(1),
    yahtzeeBonusPerGame: +(stats.yahtzeeBonus / n).toFixed(2),
    perCategory: Object.fromEntries(
      CATS.map((id, i) => [id, +(stats.catSum[i] / n).toFixed(2)])
    ),
    filledRate: Object.fromEntries(
      CATS.map((id, i) => [id, +((100 * stats.catWins[i]) / n).toFixed(1)])
    )
  };
}

function run(games, tuning, seed, optimalTable) {
  const engine = Engine.createEngine(Object.assign({}, tuning, {
    optimalTable: optimalTable || null
  }));
  const rng = mulberry32(seed);
  const stats = newStats();
  const t0 = Date.now();
  for (let g = 0; g < games; g++) addResult(stats, playGame(engine, rng));
  const elapsed = Date.now() - t0;
  return { stats: summarize(stats), ms: elapsed, perGameMs: +(elapsed / games).toFixed(1) };
}

function parseArgs(argv) {
  const opts = { games: 300, seed: 20261027, optimal: false };
  const tuning = {};
  for (const arg of argv) {
    if (arg === '--optimal') { opts.optimal = true; continue; }
    const m = arg.match(/^--([\w]+)=(.+)$/);
    if (!m) continue;
    const key = m[1];
    const val = m[2];
    if (key === 'games') opts.games = parseInt(val, 10);
    else if (key === 'seed') opts.seed = parseInt(val, 10);
    else if (key === 'scale') tuning.scale = parseFloat(val);
    else if (key === 'offset') tuning.offset = parseFloat(val);
    else if (key === 'bonusWeight') tuning.bonusWeight = parseFloat(val);
    else if (key === 'base') tuning.baseValues = val.split(',').map(Number);
  }
  return { opts, tuning };
}

function main() {
  const { opts, tuning } = parseArgs(process.argv.slice(2));
  const optimalTable = opts.optimal ? loadOptimalTable() : null;
  if (opts.optimal && !optimalTable) {
    console.error('No optimal table found at tools/optimal-table.bin. Run tools/solve-optimal.js first.');
    process.exitCode = 1;
    return;
  }

  const engine = Engine.createEngine({});
  console.log('Solo expected values (exact, 3 rolls):');
  const solo = engine.soloEV;
  let sum = 0;
  CATS.forEach((id, i) => {
    sum += solo[i];
    console.log('  ' + id.padEnd(14) + solo[i].toFixed(3));
  });
  console.log('  ' + 'SUM'.padEnd(14) + sum.toFixed(3));
  console.log('\nDice model: ' + engine.model.stateCounts.length + ' states, ' +
    engine.model.keeps.length + ' hold patterns');

  console.log('\nTable: ' + (optimalTable ? 'exact optimal' : 'heuristic fallback'));
  console.log('Evaluating ' + opts.games + ' games with', JSON.stringify(tuning));
  const out = run(opts.games, tuning, opts.seed, optimalTable);
  console.log(JSON.stringify(out, null, 2));
}

if (require.main === module) main();

module.exports = { playGame, run, summarize, newStats, addResult, mulberry32, rollFive, reroll, die };
