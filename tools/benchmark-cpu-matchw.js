'use strict';

/*
 * Headless benchmark for the CPU's shipped endgame.
 *
 *   node tools/benchmark-cpu-matchw.js --games=100 --seed=20261028
 *   node tools/benchmark-cpu-matchw.js --games=100 --cpu=exact \
 *     --out=reports/yahtzee-cpu-exact-control-100.json
 *
 * The player is fixed at Exact-W.  The CPU uses Exact-W through round 11 and
 * Match-W for rounds 12-13, exactly as the browser does.  The CPU's Match-W
 * solver models the human with Exact-W, which is the same policy the
 * benchmark player uses.  Dice are seeded; no browser or LLM is in the loop.
 */

const fs = require('fs');
const path = require('path');

const Engine = require(path.join(__dirname, '..', 'src', 'engine.js'));
const { loadOptimalTable } = require('./load-table.js');
const { createLateGameSolver } = require(path.join(__dirname, '..', 'src', 'match-solver.js'));
const { playTurn, mulberry32, summarize } = require('./benchmark-matchw.js');

const CATS = Engine.CAT_IDS;
const START_ROUND = 12;
const PLAYER_MODEL = 'Exact-W';
const MATCHW_CPU_MODEL = 'Exact-W rounds 1-11; Match-W rounds 12-13';
const EXACT_CPU_MODEL = 'Exact-W rounds 1-13';

function parseArgs(argv) {
  const opts = {
    games: 100,
    seed: 20261028,
    cpu: 'matchw',
    out: 'reports/yahtzee-cpu-matchw-100.json'
  };
  for (const arg of argv) {
    const m = arg.match(/^--([\w-]+)=(.+)$/);
    if (!m) continue;
    const key = m[1];
    const value = m[2];
    if (key === 'games') opts.games = Math.max(1, parseInt(value, 10));
    else if (key === 'seed') opts.seed = parseInt(value, 10);
    else if (key === 'cpu') opts.cpu = value;
    else if (key === 'out') opts.out = value;
  }
  return opts;
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

function playGame(engine, cpuMatch, rng, cpuPolicy) {
  const cards = [Engine.blankCard(), Engine.blankCard()];
  const history = [];

  for (let round = 1; round <= 13; round++) {
    const playerSolver = engine.solve(Engine.openCategories(cards[0]), cards[0]);
    const playerTurn = playTurn(engine, cards[0], playerSolver, rng);

    let cpuSolver;
    if (cpuPolicy === 'matchw' && round >= START_ROUND) {
      cpuSolver = cpuMatch.turnFromCards(cards[1], cards[0], round);
    } else {
      cpuSolver = engine.solve(Engine.openCategories(cards[1]), cards[1]);
    }
    const cpuTurn = playTurn(engine, cards[1], cpuSolver, rng);

    history.push({
      round: round,
      player: {
        catId: playerTurn.catId,
        score: playerTurn.score,
        dice: playerTurn.dice,
        policy: PLAYER_MODEL
      },
      cpu: {
        catId: cpuTurn.catId,
        score: cpuTurn.score,
        dice: cpuTurn.dice,
        policy: cpuPolicy === 'matchw' && round >= START_ROUND ? 'Match-W' : 'Exact-W'
      }
    });
  }

  return { cards: cards, history: history };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.cpu !== 'matchw' && opts.cpu !== 'exact') {
    console.error('--cpu must be "matchw" or "exact".');
    process.exitCode = 1;
    return;
  }
  if (opts.games < 1) {
    console.error('--games must be at least 1.');
    process.exitCode = 1;
    return;
  }

  const table = loadOptimalTable();
  if (!table) {
    console.error('No optimal table found at tools/optimal-table.bin. Run tools/solve-optimal.js first.');
    process.exitCode = 1;
    return;
  }

  const engine = Engine.createEngine({ optimalTable: table });
  const cpuMatch = createLateGameSolver(engine);
  const rng = mulberry32(opts.seed);
  const games = [];
  const t0 = Date.now();

  for (let id = 1; id <= opts.games; id++) {
    const played = playGame(engine, cpuMatch, rng, opts.cpu);
    const playerCard = played.cards[0];
    const cpuCard = played.cards[1];
    const player = engine.totalScore(playerCard);
    const cpu = engine.totalScore(cpuCard);
    games.push({
      id: id,
      player: player,
      cpu: cpu,
      margin: player - cpu,
      result: player > cpu ? 'win' : player < cpu ? 'loss' : 'tie',
      playerUpper: engine.upperScore(playerCard),
      cpuUpper: engine.upperScore(cpuCard),
      playerUpperBonus: engine.upperBonus(playerCard),
      cpuUpperBonus: engine.upperBonus(cpuCard),
      playerYahtzeeBonus: playerCard.yahtzeeBonus || 0,
      cpuYahtzeeBonus: cpuCard.yahtzeeBonus || 0,
      playerCard: Object.assign({}, playerCard.scores),
      cpuCard: Object.assign({}, cpuCard.scores),
      history: played.history
    });

    // Keep the per-game cache bounded while retaining reuse inside each game.
    cpuMatch.clear();

    if (id % 10 === 0 || id === opts.games) {
      console.log('game ' + id + '/' + opts.games + ' - ' +
        Math.round((Date.now() - t0) / 1000) + 's');
    }
  }

  const elapsedMs = Date.now() - t0;
  const playerScores = games.map(function (g) { return g.player; });
  const cpuScores = games.map(function (g) { return g.cpu; });
  const margins = games.map(function (g) { return g.margin; });
  const wins = games.filter(function (g) { return g.result === 'win'; }).length;
  const losses = games.filter(function (g) { return g.result === 'loss'; }).length;
  const ties = games.filter(function (g) { return g.result === 'tie'; }).length;
  const winCi = wilson(wins, games.length);
  const marginStats = summarize(margins);

  const categoryAverages = {};
  CATS.forEach(function (id) {
    let playerSum = 0;
    let cpuSum = 0;
    for (let i = 0; i < games.length; i++) {
      playerSum += games[i].playerCard[id] || 0;
      cpuSum += games[i].cpuCard[id] || 0;
    }
    categoryAverages[id] = {
      player: +(playerSum / games.length).toFixed(2),
      cpu: +(cpuSum / games.length).toFixed(2)
    };
  });

  const model = opts.cpu === 'matchw' ? MATCHW_CPU_MODEL : EXACT_CPU_MODEL;
  const modelNote = opts.cpu === 'matchw'
    ? 'Player: Exact-W. CPU: Exact-W through round 11, then Match-W (P(win) + 0.5*P(tie)) in rounds 12-13 with the human modelled as Exact-W. Exact dice enumeration; no browser and no LLM in the decision loop.'
    : 'Player: Exact-W. CPU: Exact-W for all 13 rounds. Exact dice enumeration; no browser and no LLM in the decision loop.';

  const summary = {
    playerModel: PLAYER_MODEL,
    cpuModel: model,
    modelNote: modelNote,
    seed: opts.seed,
    games: games.length,
    elapsedMs: elapsedMs,
    perGameMs: +(elapsedMs / games.length).toFixed(1),
    record: { wins: wins, losses: losses, ties: ties },
    winRate: +(100 * wins / games.length).toFixed(2),
    winRateCi95: [+(winCi[0] * 100).toFixed(2), +(winCi[1] * 100).toFixed(2)],
    player: summarize(playerScores),
    cpu: summarize(cpuScores),
    margin: Object.assign({}, marginStats, {
      t: marginStats.se ? +(marginStats.mean / marginStats.se).toFixed(3) : 0
    }),
    upperBonusGames: {
      player: games.filter(function (g) { return g.playerUpperBonus > 0; }).length,
      cpu: games.filter(function (g) { return g.cpuUpperBonus > 0; }).length
    },
    yahtzeeBonusPoints: {
      player: games.reduce(function (sum, g) { return sum + g.playerYahtzeeBonus; }, 0),
      cpu: games.reduce(function (sum, g) { return sum + g.cpuYahtzeeBonus; }, 0)
    },
    categoryAverages: categoryAverages
  };

  const report = {
    meta: {
      title: 'Yahtzee CPU Match-W head-to-head benchmark',
      date: new Date().toISOString().slice(0, 10),
      model: model,
      playerModel: PLAYER_MODEL,
      seed: opts.seed,
      engine: 'src/engine.js with tools/optimal-table.bin',
      rules: 'Repo rules: +35 upper bonus at 63; +100 extra Yahtzee after a 50; an extra Yahtzee may be banked in any open box.',
      sample: opts.games + ' complete head-to-head games against the CPU policy used by the browser.'
    },
    summary: summary,
    games: games
  };

  const out = path.isAbsolute(opts.out) ? opts.out : path.join(__dirname, '..', opts.out);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n', 'utf8');

  console.log('\nPlayer model: ' + PLAYER_MODEL);
  console.log('CPU model:    ' + model);
  console.log(modelNote);
  console.log('Seed: ' + opts.seed + ' · games: ' + games.length + ' · ' + elapsedMs + ' ms');
  console.log('Record: ' + wins + '-' + losses + '-' + ties + ' (' + summary.winRate + '% wins)');
  console.log('Player: mean ' + summary.player.mean + ', SD ' + summary.player.sd + ', 95% CI ' + summary.player.ci95.join('-'));
  console.log('CPU:    mean ' + summary.cpu.mean + ', SD ' + summary.cpu.sd + ', 95% CI ' + summary.cpu.ci95.join('-'));
  console.log('Margin: mean ' + summary.margin.mean + ', SD ' + summary.margin.sd + ', 95% CI ' + summary.margin.ci95.join('-') + ', t ' + summary.margin.t);
  console.log('Upper bonus: ' + summary.upperBonusGames.player + '/' + games.length + ' vs ' + summary.upperBonusGames.cpu + '/' + games.length);
  console.log('Yahtzee bonus points: ' + summary.yahtzeeBonusPoints.player + ' vs ' + summary.yahtzeeBonusPoints.cpu);
  console.log('Wrote ' + out);
}

if (require.main === module) main();

module.exports = { playGame, main, PLAYER_MODEL };
