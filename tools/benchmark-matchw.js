'use strict';

/*
 * Hybrid match benchmark.
 *
 *   node tools/benchmark-matchw.js --games=100 --seed=20261028 --start-round=12
 *
 * Rounds before `startRound` use the shipped Exact-W policy for both sides.
 * From `startRound` through round 13 the player uses Match-W, while the CPU
 * keeps playing the shipped Exact-W policy it actually uses in the game.
 *
 * `--start-round=14` is an Exact-W control run.
 *
 * The opponent model is exact: the CPU's turn and every dice outcome are
 * enumerated from its real policy, not sampled.
 */

const path = require('path');
const fs = require('fs');
const Engine = require(path.join(__dirname, '..', 'src', 'engine.js'));
const { loadOptimalTable } = require('./load-table.js');
const { createMatchSolver } = require('./match-solver.js');

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

function playTurn(engine, card, solver, rng) {
  let dice = rollFive(rng);
  let rollsLeft = 2;
  while (rollsLeft > 0) {
    const decision = solver.bestKeep(dice, rollsLeft);
    if (!decision) throw new Error('No hold decision for ' + dice.join(','));
    if (decision.holdAll) break;
    dice = reroll(dice, decision.hold, rng);
    rollsLeft--;
  }

  const choice = solver.bestCategory(dice);
  if (!choice) throw new Error('No category decision for ' + dice.join(','));
  const hadYahtzee = card.scores.yahtzee === 50;
  if (hadYahtzee && engine.fiveOfAKind(dice)) card.yahtzeeBonus = (card.yahtzeeBonus || 0) + 100;
  card.scores[choice.catId] = choice.score;
  return { catId: choice.catId, score: choice.score, dice: dice };
}

function playGame(engine, matchSolver, rng, startRound) {
  const cards = [Engine.blankCard(), Engine.blankCard()];
  const history = [];

  for (let round = 1; round <= 13; round++) {
    let playerSolver;
    if (round >= startRound) {
      playerSolver = matchSolver.turnFromCards(cards[0], cards[1], round);
    } else {
      playerSolver = engine.solve(Engine.openCategories(cards[0]), cards[0]);
    }
    const playerTurn = playTurn(engine, cards[0], playerSolver, rng);

    const cpuSolver = engine.solve(Engine.openCategories(cards[1]), cards[1]);
    const cpuTurn = playTurn(engine, cards[1], cpuSolver, rng);

    history.push({
      round: round,
      player: { catId: playerTurn.catId, score: playerTurn.score, dice: playerTurn.dice, policy: round >= startRound ? 'Match-W' : 'Exact-W' },
      cpu: { catId: cpuTurn.catId, score: cpuTurn.score, dice: cpuTurn.dice, policy: 'Exact-W' }
    });
  }

  return { cards: cards, history: history };
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

function median(xs) {
  const a = xs.slice().sort(function (x, y) { return x - y; });
  if (!a.length) return 0;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

// Two-sided 95% Student t critical values. The table is enough for the
// sample sizes this tool is used with; larger samples use the normal limit.
const T95 = {
  1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571,
  6: 2.447, 7: 2.365, 8: 2.306, 9: 2.262, 10: 2.228,
  11: 2.201, 12: 2.179, 13: 2.160, 14: 2.145, 15: 2.131,
  16: 2.120, 17: 2.110, 18: 2.101, 19: 2.093, 20: 2.086,
  21: 2.080, 22: 2.074, 23: 2.069, 24: 2.064, 25: 2.060,
  26: 2.056, 27: 2.052, 28: 2.048, 29: 2.045, 30: 2.042,
  40: 2.021, 50: 2.009, 60: 2.000, 80: 1.990, 100: 1.984
};

function tCritical95(df) {
  if (df <= 0) return 0;
  if (T95[df]) return T95[df];
  const keys = Object.keys(T95).map(Number).sort(function (a, b) { return a - b; });
  for (let i = 0; i < keys.length; i++) if (keys[i] > df) return T95[keys[i]];
  return 1.96;
}

function summarize(values) {
  const m = mean(values);
  const s = sd(values);
  const se = values.length ? s / Math.sqrt(values.length) : 0;
  const t = tCritical95(values.length - 1);
  return {
    mean: +m.toFixed(4),
    sd: +s.toFixed(4),
    se: +se.toFixed(4),
    median: +median(values).toFixed(2),
    min: values.length ? Math.min.apply(null, values) : 0,
    max: values.length ? Math.max.apply(null, values) : 0,
    ci95: [+(m - t * se).toFixed(4), +(m + t * se).toFixed(4)]
  };
}

function wilson(k, n) {
  if (!n) return [0, 0];
  const z = 1.959963984540054;
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return [Math.max(0, center - half), Math.min(1, center + half)];
}

function parseArgs(argv) {
  const opts = {
    games: 100,
    seed: 20261028,
    startRound: 12,
    out: null
  };
  for (const arg of argv) {
    const m = arg.match(/^--([\w-]+)=(.+)$/);
    if (!m) continue;
    const key = m[1];
    const val = m[2];
    if (key === 'games') opts.games = parseInt(val, 10);
    else if (key === 'seed') opts.seed = parseInt(val, 10);
    else if (key === 'start-round') opts.startRound = parseInt(val, 10);
    else if (key === 'out') opts.out = val;
  }
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!(opts.startRound >= 11 && opts.startRound <= 14)) {
    console.error('--start-round must be 11, 12, 13, or 14 (14 = Exact-W control).');
    process.exitCode = 1;
    return;
  }

  const optimalTable = loadOptimalTable();
  if (!optimalTable) {
    console.error('No optimal table found at tools/optimal-table.bin. Run tools/solve-optimal.js first.');
    process.exitCode = 1;
    return;
  }

  const engine = Engine.createEngine({ optimalTable: optimalTable });
  const matchSolver = createMatchSolver(engine);
  const rng = mulberry32(opts.seed);
  const games = [];
  const t0 = Date.now();

  for (let g = 1; g <= opts.games; g++) {
    const played = playGame(engine, matchSolver, rng, opts.startRound);
    const p = played.cards[0];
    const c = played.cards[1];
    const player = engine.totalScore(p);
    const cpu = engine.totalScore(c);
    games.push({
      id: g,
      player: player,
      cpu: cpu,
      margin: player - cpu,
      result: player > cpu ? 'win' : player < cpu ? 'loss' : 'tie',
      playerUpper: engine.upperScore(p),
      cpuUpper: engine.upperScore(c),
      playerUpperBonus: engine.upperBonus(p),
      cpuUpperBonus: engine.upperBonus(c),
      playerYahtzeeBonus: p.yahtzeeBonus || 0,
      cpuYahtzeeBonus: c.yahtzeeBonus || 0,
      playerCard: Object.assign({}, p.scores),
      cpuCard: Object.assign({}, c.scores),
      history: played.history
    });
    if (g % 10 === 0 || g === opts.games) {
      console.log('game ' + g + '/' + opts.games + ' - ' + Math.round((Date.now() - t0) / 1000) + 's');
    }
  }

  const elapsedMs = Date.now() - t0;
  const playerScores = games.map(function (g) { return g.player; });
  const cpuScores = games.map(function (g) { return g.cpu; });
  const margins = games.map(function (g) { return g.margin; });
  const wins = games.filter(function (g) { return g.result === 'win'; }).length;
  const losses = games.filter(function (g) { return g.result === 'loss'; }).length;
  const ties = games.filter(function (g) { return g.result === 'tie'; }).length;
  const winRate = wins / games.length;
  const winCi = wilson(wins, games.length);
  const marginStats = summarize(margins);
  const n = margins.length;
  const marginT = marginStats.se ? marginStats.mean / marginStats.se : 0;

  const categoryAverages = {};
  CATS.forEach(function (id) {
    let ps = 0;
    let cs = 0;
    for (let i = 0; i < games.length; i++) {
      ps += games[i].playerCard[id] || 0;
      cs += games[i].cpuCard[id] || 0;
    }
    categoryAverages[id] = {
      player: +(ps / games.length).toFixed(2),
      cpu: +(cs / games.length).toFixed(2)
    };
  });

  const summary = {
    model: opts.startRound <= 13 ? 'Hybrid Exact-W + Match-W' : 'Exact-W control',
    modelNote: opts.startRound <= 13
      ? 'Rounds before ' + opts.startRound + ' use Exact-W; ' +
        (opts.startRound === 13 ? 'round 13 uses' : 'rounds ' + opts.startRound + '-13 use') +
        ' Match-W (P(win)+0.5*P(tie), exact dice and exact CPU policy distribution). CPU always uses its shipped Exact-W policy.'
      : 'Control run: both sides use the shipped Exact-W policy.',
    startRound: opts.startRound <= 13 ? opts.startRound : null,
    seed: opts.seed,
    games: games.length,
    elapsedMs: elapsedMs,
    perGameMs: +(elapsedMs / games.length).toFixed(1),
    record: { wins: wins, losses: losses, ties: ties },
    winRate: +(winRate * 100).toFixed(2),
    winRateCi95: [+(winCi[0] * 100).toFixed(2), +(winCi[1] * 100).toFixed(2)],
    player: summarize(playerScores),
    cpu: summarize(cpuScores),
    margin: Object.assign({}, marginStats, { t: +marginT.toFixed(3) }),
    upperBonusGames: {
      player: games.filter(function (g) { return g.playerUpperBonus > 0; }).length,
      cpu: games.filter(function (g) { return g.cpuUpperBonus > 0; }).length
    },
    yahtzeeBonusPoints: {
      player: games.reduce(function (s, g) { return s + g.playerYahtzeeBonus; }, 0),
      cpu: games.reduce(function (s, g) { return s + g.cpuYahtzeeBonus; }, 0)
    },
    categoryAverages: categoryAverages,
    solverCaches: matchSolver.stats()
  };

  const report = {
    meta: {
      title: 'Yahtzee Match-W hybrid benchmark',
      date: new Date().toISOString().slice(0, 10),
      model: summary.model,
      modelNote: summary.modelNote,
      seed: opts.seed,
      engine: 'src/engine.js with tools/optimal-table.bin',
      rules: 'Repo rules: +35 upper bonus at 63; +100 extra Yahtzee after a 50; an extra Yahtzee may be banked in any open box.'
    },
    summary: summary,
    games: games
  };

  console.log('\n' + JSON.stringify(summary, null, 2));
  if (opts.out) {
    const out = path.resolve(opts.out);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
    console.log('\nWrote ' + out);
  }
}

if (require.main === module) main();

module.exports = {
  playGame,
  playTurn,
  summarize,
  mulberry32,
  rollFive,
  reroll
};
