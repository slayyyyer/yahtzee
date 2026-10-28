/*
 * Correctness checks for the probability engine.
 *   node tools/test-engine.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const Engine = require(path.join(__dirname, '..', 'src', 'engine.js'));
const { loadOptimalTable } = require('./load-table.js');
const { createMatchSolver } = require('./match-solver.js');
const BrowserMatch = require(path.join(__dirname, '..', 'src', 'match-solver.js'));

let passed = 0;
function ok(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ok  ' + name);
  } catch (err) {
    console.error('  FAIL ' + name);
    console.error(err && err.stack ? err.stack : err);
    process.exitCode = 1;
  }
}

const engine = Engine.createEngine({});
const model = engine.model;

console.log('Model');
ok('252 distinct five-dice states', () => assert.strictEqual(model.stateCounts.length, 252));
ok('fresh-roll distribution sums to 1', () => {
  let sum = 0;
  for (let i = 0; i < model.freshProb.length; i++) sum += model.freshProb[i];
  assert.ok(Math.abs(sum - 1) < 1e-12, 'sum=' + sum);
});
ok('every hold transition is a probability distribution', () => {
  for (let k = 0; k < model.keepTrans.length; k++) {
    let sum = 0;
    for (let j = 0; j < model.keepTrans[k].prob.length; j++) sum += model.keepTrans[k].prob[j];
    assert.ok(Math.abs(sum - 1) < 1e-12, 'keep ' + k + ' sum=' + sum);
  }
});
ok('462 distinct hold patterns', () => assert.strictEqual(model.keeps.length, 462));

console.log('Scoring');
function score(id, dice) { return engine.scoreFor(id, dice); }
ok('ones', () => assert.strictEqual(score('ones', [1, 1, 3, 4, 6]), 2));
ok('sixes', () => assert.strictEqual(score('sixes', [6, 6, 6, 2, 1]), 18));
ok('three of a kind', () => assert.strictEqual(score('threeKind', [4, 4, 4, 2, 1]), 15));
ok('three of a kind rejects a pair', () => assert.strictEqual(score('threeKind', [4, 4, 2, 2, 1]), 0));
ok('four of a kind', () => assert.strictEqual(score('fourKind', [5, 5, 5, 5, 2]), 22));
ok('full house', () => assert.strictEqual(score('fullHouse', [3, 3, 3, 6, 6]), 25));
ok('full house rejects two pair', () => assert.strictEqual(score('fullHouse', [3, 3, 6, 6, 1]), 0));
ok('yahtzee is a full house (joker)', () => assert.strictEqual(score('fullHouse', [2, 2, 2, 2, 2]), 25));
ok('small straight', () => assert.strictEqual(score('smallStraight', [1, 2, 3, 4, 6]), 30));
ok('small straight with duplicate', () => assert.strictEqual(score('smallStraight', [2, 3, 4, 5, 5]), 30));
ok('small straight rejects a gap', () => assert.strictEqual(score('smallStraight', [1, 2, 3, 5, 6]), 0));
ok('large straight 1-5', () => assert.strictEqual(score('largeStraight', [1, 2, 3, 4, 5]), 40));
ok('large straight 2-6', () => assert.strictEqual(score('largeStraight', [2, 3, 4, 5, 6]), 40));
ok('large straight rejects a duplicate', () => assert.strictEqual(score('largeStraight', [1, 2, 3, 4, 4]), 0));
ok('yahtzee', () => assert.strictEqual(score('yahtzee', [6, 6, 6, 6, 6]), 50));
ok('chance', () => assert.strictEqual(score('chance', [6, 6, 6, 6, 6]), 30));

console.log('Exact solo expectations');
ok('ones ≈ 2.106', () => assert.ok(Math.abs(engine.soloEV[0] - 2.106) < 0.01));
ok('sixes ≈ 12.639', () => assert.ok(Math.abs(engine.soloEV[5] - 12.639) < 0.01));
ok('large straight ≈ 10.444', () => assert.ok(Math.abs(engine.soloEV[10] - 10.444) < 0.01));
ok('chance ≈ 23.333', () => assert.ok(Math.abs(engine.soloEV[12] - 23.333) < 0.01));
ok('yahtzee ≈ 2.301', () => assert.ok(Math.abs(engine.soloEV[11] - 2.301) < 0.01));

console.log('Turn solver');
ok('a five-of-a-kind is kept', () => {
  const solver = engine.solve(Engine.CAT_IDS, Engine.blankCard());
  const d = solver.bestKeep([5, 5, 5, 5, 5], 2);
  assert.deepStrictEqual(d.hold, [true, true, true, true, true]);
  assert.strictEqual(d.holdAll, true);
});
ok('chases a small straight', () => {
  const solver = engine.solve(['smallStraight'], Engine.blankCard());
  const d = solver.bestKeep([1, 2, 3, 6, 6], 2);
  assert.strictEqual(d.values.join(''), '123');
});
ok('keeps a completed straight rather than rerolling', () => {
  const solver = engine.solve(['smallStraight'], Engine.blankCard());
  const d = solver.bestKeep([1, 2, 3, 4, 6], 2);
  assert.deepStrictEqual(d.hold, [true, true, true, true, true]);
});
ok('prefers a large straight over a small straight when both are open', () => {
  const solver = engine.solve(Engine.CAT_IDS, Engine.blankCard());
  const choice = solver.bestCategory([1, 2, 3, 4, 5]);
  assert.strictEqual(choice.catId, 'largeStraight');
  assert.strictEqual(choice.score, 40);
});
ok('values are finite for every roll state', () => {
  const solver = engine.solve(Engine.CAT_IDS, Engine.blankCard());
  for (let a = 1; a <= 6; a++) {
    for (let b = a; b <= 6; b++) {
      for (let c = b; c <= 6; c++) {
        for (let d = c; d <= 6; d++) {
          for (let e = d; e <= 6; e++) {
            const dice = [a, b, c, d, e];
            assert.ok(Number.isFinite(solver.valueFor(dice, 2)), 'v2 ' + dice);
            assert.ok(Number.isFinite(solver.valueFor(dice, 1)), 'v1 ' + dice);
            assert.ok(Number.isFinite(solver.valueFor(dice, 0)), 'v0 ' + dice);
          }
        }
      }
    }
  }
});

ok('values-only solver matches the full turn solver', () => {
  const model = engine.model;
  const open = Engine.CAT_IDS.map(function (id) { return Engine.CAT_INDEX[id]; });
  const scratch = {
    v0: new Float64Array(252),
    v1: new Float64Array(252),
    v2: new Float64Array(252),
    hold1: new Int16Array(252),
    hold2: new Int16Array(252)
  };
  const term = function (c, s) { return model.scores[c][s]; };
  const full = Engine.solveTurn(model, open, term);
  const values = Engine.solveTurnValues(model, open, term, scratch);
  assert.strictEqual(values, scratch.v2);
  for (let s = 0; s < 252; s++) {
    assert.ok(Math.abs(values[s] - full.v2[s]) < 1e-12, 'state ' + s);
  }
});

console.log('Cards and bonuses');
ok('upper bonus at 63', () => {
  const card = Engine.blankCard();
  card.scores.ones = 3; card.scores.twos = 6; card.scores.threes = 9;
  card.scores.fours = 12; card.scores.fives = 15; card.scores.sixes = 18;
  assert.strictEqual(Engine.upperScore(card), 63);
  assert.strictEqual(Engine.upperBonus(card), 35);
});
ok('no upper bonus at 62', () => {
  const card = Engine.blankCard();
  card.scores.sixes = 30; card.scores.fives = 20; card.scores.fours = 12;
  assert.strictEqual(Engine.upperScore(card), 62);
  assert.strictEqual(Engine.upperBonus(card), 0);
});
ok('extra yahtzee bonus only after a 50', () => {
  const card = Engine.blankCard();
  assert.strictEqual(engine.yahtzeeBonusFor(card, [4, 4, 4, 4, 4]), 0);
  card.scores.yahtzee = 50;
  assert.strictEqual(engine.yahtzeeBonusFor(card, [4, 4, 4, 4, 4]), 100);
  card.yahtzeeBonus = 100;
  card.scores.ones = 0;
  assert.strictEqual(Engine.totalScore(card), 150);
});
ok('solver values the extra yahtzee bonus', () => {
  const card = Engine.blankCard();
  card.scores.yahtzee = 50;
  const open = Engine.openCategories(card);
  const solver = engine.solve(open, card);
  const choice = solver.bestCategory([4, 4, 4, 4, 4]);
  assert.strictEqual(choice.yahtzeeBonus, 100);
});
ok('full card is complete', () => {
  const card = Engine.blankCard();
  for (const id of Engine.CAT_IDS) card.scores[id] = 0;
  assert.strictEqual(Engine.isCardComplete(card), true);
});
ok('bonus probability is monotone in the upper total', () => {
  const open = Engine.UPPER_IDS;
  const low = Engine.blankCard();
  const high = Engine.blankCard();
  high.scores.ones = 20; // impossible in a real game, fine for the model
  high.scores.twos = 10;
  const pLow = engine.bonusChance(open, low);
  const pHigh = engine.bonusChance(open, high);
  assert.ok(pHigh > pLow, pLow + ' -> ' + pHigh);
  assert.ok(pLow >= 0 && pHigh <= 1);
});

console.log('Optimal table wiring');
function tableSlot(bits, upper, y) {
  return ((bits * 64) + upper) * 2 + y;
}
function upperCard(total) {
  const card = Engine.blankCard();
  card.scores.sixes = total; // upperScore is all these tests read
  return card;
}

ok('table decoder rejects missing or malformed data', () => {
  assert.strictEqual(Engine.decodeOptimalTable(null), null);
  assert.strictEqual(Engine.decodeOptimalTable('not-base64'), null);
  assert.strictEqual(Engine.decodeOptimalTable(Buffer.alloc(4).toString('base64')), null);
});

ok('table decoder reads a valid base64 table', () => {
  const bytes = Buffer.alloc(1048576 * 4);
  const view = new Float32Array(bytes.buffer, bytes.byteOffset, 1048576);
  view[tableSlot(1 << 12, 0, 0)] = 123.5;
  view[tableSlot(0, 63, 0)] = 35;
  view[tableSlot(8191, 0, 0)] = 254;
  const decoded = Engine.decodeOptimalTable(bytes.toString('base64'));
  assert.ok(decoded instanceof Float32Array);
  assert.strictEqual(decoded.length, 1048576);
  assert.ok(Math.abs(decoded[tableSlot(1 << 12, 0, 0)] - 123.5) < 1e-4);
});

ok('table engine uses the injected W value and fallback does not', () => {
  const fake = new Float32Array(1048576);
  fake[tableSlot(1 << 12, 0, 0)] = 123.5;
  fake[tableSlot(0, 63, 0)] = 35;
  fake[tableSlot(8191, 0, 0)] = 254;
  const withTable = Engine.createEngine({ optimalTable: fake });
  const without = Engine.createEngine({ optimalTable: null });
  assert.strictEqual(withTable.hasOptimalTable, true);
  assert.strictEqual(without.hasOptimalTable, false);
  assert.ok(Math.abs(withTable.futureValue(['chance'], Engine.blankCard()) - 123.5) < 1e-4);
  assert.ok(Math.abs(without.futureValue(['chance'], Engine.blankCard()) - 123.5) > 1);
  assert.strictEqual(withTable.futureValue([], upperCard(63)), 35);
});

ok('wrong-length tables fall back to the heuristic', () => {
  const ignored = Engine.createEngine({ optimalTable: new Float32Array(10) });
  assert.strictEqual(ignored.hasOptimalTable, false);
});

ok('fallback includes the upper bonus on the last box', () => {
  const without = Engine.createEngine({ optimalTable: null });
  assert.strictEqual(without.futureValue([], upperCard(63)), 35);
  assert.strictEqual(without.futureValue([], upperCard(62)), 0);
});

console.log('Generated repo table');
const table = loadOptimalTable();
const tableEngine = table ? Engine.createEngine({ optimalTable: table }) : null;
const REPO_FULL_VALUE = 254.143784;

ok('generated table exists with the expected size', () => {
  assert.ok(table instanceof Float32Array, 'tools/optimal-table.bin is missing');
  assert.strictEqual(table.length, 1048576);
  assert.strictEqual(tableEngine.hasOptimalTable, true);
});

ok('shipped base64 matches the binary table', () => {
  const script = path.join(__dirname, '..', 'src', 'optimal-table.js');
  assert.ok(fs.existsSync(script), 'src/optimal-table.js is missing');
  require(script);
  const decoded = Engine.decodeOptimalTable(globalThis.YAHTZEE_OPTIMAL_B64);
  assert.ok(decoded instanceof Float32Array);
  for (let i = 0; i < table.length; i++) {
    if (decoded[i] !== table[i]) assert.fail('table mismatch at slot ' + i);
  }
});

ok('terminal table values include the upper bonus', () => {
  assert.ok(Math.abs(table[tableSlot(0, 63, 0)] - 35) < 1e-6);
  assert.ok(Math.abs(table[tableSlot(0, 63, 1)] - 35) < 1e-6);
  assert.strictEqual(table[tableSlot(0, 62, 0)], 0);
  assert.strictEqual(table[tableSlot(0, 62, 1)], 0);
});

ok('full-card value matches the generator', () => {
  assert.ok(Math.abs(table[tableSlot(8191, 0, 0)] - REPO_FULL_VALUE) < 1e-3,
    'W(8191,0,0)=' + table[tableSlot(8191, 0, 0)]);
});

ok('every single open box matches its solo expectation', () => {
  for (let ci = 0; ci < Engine.CAT_IDS.length; ci++) {
    const value = table[tableSlot(1 << ci, 0, 0)];
    assert.ok(Math.abs(value - tableEngine.soloEV[ci]) < 1e-3,
      Engine.CAT_IDS[ci] + ': ' + value + ' vs ' + tableEngine.soloEV[ci]);
  }
});

ok('table values are finite and non-negative', () => {
  for (let i = 0; i < table.length; i++) {
    assert.ok(Number.isFinite(table[i]), 'slot ' + i);
    assert.ok(table[i] >= 0, 'slot ' + i + '=' + table[i]);
  }
});

ok('more upper points never reduce the table value', () => {
  const masks = [8191 & ~(1 << 11), 8191, (1 << 12) | (1 << 6) | (1 << 0)];
  for (const bits of masks) {
    const limited = bits === 8191 ? [0, 1, 10, 30, 62] : null;
    const ys = bits === 8191 ? [0] : [0, 1];
    for (const y of ys) {
      for (let u = 0; u < 63; u++) {
        if (limited && limited.indexOf(u) === -1 && u !== 62) continue;
        const low = table[tableSlot(bits, u, y)];
        const high = table[tableSlot(bits, u + 1, y)];
        assert.ok(high >= low - 1e-2, 'bits=' + bits + ' y=' + y + ' u=' + u);
      }
    }
  }
});

ok('exact and heuristic engines make legal mid-game decisions', () => {
  const card = Engine.blankCard();
  card.scores.ones = 3;
  card.scores.twos = 6;
  card.scores.threes = 9;
  card.scores.fours = 12;
  card.scores.fives = 15;
  card.scores.sixes = 18;
  card.scores.threeKind = 21;
  card.scores.yahtzee = 50;
  const open = Engine.openCategories(card);
  const exact = tableEngine.solve(open, card);
  const heuristic = engine.solve(open, card);

  let bits = 0;
  for (const id of open) bits |= 1 << Engine.CAT_INDEX[id];
  assert.ok(Math.abs(tableEngine.futureValue(open, card) - table[tableSlot(bits, 63, 1)]) < 1e-6);

  for (const dice of [[4, 4, 4, 4, 4], [1, 2, 3, 4, 6], [6, 6, 2, 3, 5]]) {
    const a = exact.bestCategory(dice);
    const b = heuristic.bestCategory(dice);
    assert.ok(a && open.indexOf(a.catId) !== -1, 'exact choice');
    assert.ok(b && open.indexOf(b.catId) !== -1, 'heuristic choice');
    assert.ok(Number.isFinite(exact.expected) && exact.expected > 0);
    assert.ok(Number.isFinite(heuristic.expected) && heuristic.expected > 0);
    assert.ok(Math.abs(exact.expected - heuristic.expected) < 20,
      'expected values diverged: ' + exact.expected + ' vs ' + heuristic.expected);
  }
});

console.log('Match-W endgame solver');
if (!tableEngine) {
  ok('Match-W checks need the generated table', () => assert.fail('table missing'));
} else {
  runBrowserMatchChecks(tableEngine);

  const match = createMatchSolver(tableEngine);

  function cardWithOpen() {
    const card = Engine.blankCard();
    card.scores.ones = 3;
    card.scores.twos = 6;
    card.scores.threes = 9;
    card.scores.fours = 12;
    card.scores.fives = 15;
    card.scores.sixes = 18;
    card.scores.threeKind = 24;
    card.scores.fourKind = 20;
    card.scores.fullHouse = 25;
    card.scores.smallStraight = 30;
    // largeStraight, yahtzee and chance stay open
    return card;
  }

  function openIdsFromBits(bits) {
    const ids = [];
    for (let i = 0; i < Engine.CAT_IDS.length; i++) if (bits & (1 << i)) ids.push(Engine.CAT_IDS[i]);
    return ids;
  }

  ok('card-to-state conversion preserves the total', () => {
    const card = cardWithOpen();
    const state = match.stateFromCard(card);
    assert.strictEqual(match.totalOf(state), Engine.totalScore(card));
    for (const id of Engine.openCategories(card)) {
      assert.ok(state.bits & (1 << Engine.CAT_INDEX[id]), id + ' should be open');
    }
  });

  ok('tie utility is exactly one half', () => {
    assert.strictEqual(match.utility(100, 100), 0.5);
    assert.strictEqual(match.utility(101, 100), 1);
    assert.strictEqual(match.utility(99, 100), 0);
  });

  ok('CPU distribution sums to 1 and matches the shipped expected value', () => {
    const card = cardWithOpen();
    const dist = match.cpuTurnDistribution(match.stateFromCard(card));
    const exact = tableEngine.solve(Engine.openCategories(card), card);
    let total = 0;
    let expected = 0;
    for (const o of dist) {
      total += o.prob;
      const futureCard = { scores: { ones: o.upper, yahtzee: o.y ? 50 : 0 } };
      const future = tableEngine.futureValue(openIdsFromBits(o.bits), futureCard);
      expected += o.prob * (o.delta + future);
    }
    assert.ok(Math.abs(total - 1) < 1e-10, 'distribution sum=' + total);
    assert.ok(Math.abs(expected - exact.expected) < 1e-6,
      'distribution mean=' + expected + ' expected=' + exact.expected);
  });

  ok('Match-W is at least as good as the Exact-W policy', () => {
    const player = cardWithOpen();
    const cpu = cardWithOpen();
    const cmp = match.compareFromCards(player, cpu, 12);
    assert.ok(Number.isFinite(cmp.match) && cmp.match >= 0 && cmp.match <= 1);
    assert.ok(cmp.match >= cmp.exact - 1e-9, 'match=' + cmp.match + ' exact=' + cmp.exact);
  });

  ok('Match-W recognizes a locked win and a locked loss', () => {
    const player = Engine.blankCard();
    player.scores.ones = 100; // model-level score; only totals matter here
    const cpu = Engine.blankCard();
    const win = match.turnFromCards(player, cpu, 13);
    assert.ok(win.value > 0.999, 'locked win value=' + win.value);
    assert.ok(match.exactPolicyValueFromCards(player, cpu, 13) > 0.999, 'locked Exact-W win');

    const losingPlayer = Engine.blankCard();
    const winningCpu = Engine.blankCard();
    winningCpu.scores.ones = 200;
    const loss = match.turnFromCards(losingPlayer, winningCpu, 13);
    assert.ok(loss.value < 0.001, 'locked loss value=' + loss.value);
    assert.ok(match.exactPolicyValueFromCards(losingPlayer, winningCpu, 13) < 0.001, 'locked Exact-W loss');
  });
}

function runBrowserMatchChecks(tableEngine) {
  console.log('Browser Match-W endgame (CPU role)');
  const cpuMatch = BrowserMatch.createLateGameSolver(tableEngine);

  function cardWithOnly(openId, fillValue) {
    const card = Engine.blankCard();
    const value = fillValue === undefined ? 0 : fillValue;
    for (const id of Engine.CAT_IDS) {
      if (id !== openId) card.scores[id] = value;
    }
    return card;
  }

  function cardWithTwoOpen(first, second) {
    const card = Engine.blankCard();
    for (const id of Engine.CAT_IDS) {
      if (id !== first && id !== second) card.scores[id] = 0;
    }
    return card;
  }

  function lastRoundValue(cpuCard, playerCard) {
    const cpu = BrowserMatch.stateFromCard(cpuCard);
    const player = BrowserMatch.stateFromCard(playerCard);
    let value = 0;
    for (let s = 0; s < Engine.getModel().stateCounts.length; s++) {
      const score = Engine.getModel().scores[Engine.CAT_INDEX.chance][s];
      value += Engine.getModel().freshProb[s] * BrowserMatch.utility(
        BrowserMatch.totalOf(cpu) + score,
        BrowserMatch.totalOf(player)
      );
    }
    return value;
  }

  ok('browser Match-W is exact on the last turn', () => {
    const cpu = cardWithOnly('chance');
    const player = cardWithOnly('chance', 0);
    player.scores.chance = 0; // complete the player's card
    const turn = cpuMatch.turnFromCards(cpu, player, 13);
    const expected = lastRoundValue(cpu, player);
    assert.strictEqual(turn.policy, 'Match-W');
    assert.ok(Math.abs(turn.value - expected) < 1e-9,
      'value=' + turn.value + ' expected=' + expected);
    assert.ok(turn.value > 0.999999, 'locked win value=' + turn.value);
    const choice = turn.bestCategory([1, 2, 3, 4, 5]);
    assert.strictEqual(choice.catId, 'chance');
    assert.strictEqual(choice.score, 15);
  });

  ok('browser Match-W recognizes a locked last-turn loss', () => {
    const cpu = cardWithOnly('chance');
    const player = cardWithOnly('chance', 0);
    player.scores.chance = 100;
    const turn = cpuMatch.turnFromCards(cpu, player, 13);
    assert.ok(turn.value < 1e-12, 'locked loss value=' + turn.value);
  });

  ok('browser Match-W values the human last turn', () => {
    const cpu = cardWithTwoOpen('chance', 'yahtzee');
    const chanceOpen = cardWithOnly('chance', 0);
    const yahtzeeOpen = cardWithOnly('yahtzee', 0);
    const chance = cpuMatch.turnFromCards(cpu, chanceOpen, 12);
    const yahtzee = cpuMatch.turnFromCards(cpu, yahtzeeOpen, 12);
    assert.ok(chance.value < yahtzee.value - 0.1,
      'chance=' + chance.value + ' yahtzee=' + yahtzee.value);
  });

  ok('browser Match-W responds to the scoreboard', () => {
    const cpu = cardWithTwoOpen('chance', 'yahtzee');
    const low = cardWithOnly('chance', 0);
    const high = cardWithOnly('chance', 0);
    high.scores.ones = 50;
    const lowTurn = cpuMatch.turnFromCards(cpu, low, 12);
    const highTurn = cpuMatch.turnFromCards(cpu, high, 12);
    assert.ok(highTurn.value < lowTurn.value,
      'high=' + highTurn.value + ' low=' + lowTurn.value);
  });

  ok('browser Match-W decisions are legal and do not mutate cards', () => {
    const cpu = cardWithTwoOpen('chance', 'yahtzee');
    const player = cardWithOnly('chance', 0);
    const beforeCpu = JSON.stringify(cpu);
    const beforePlayer = JSON.stringify(player);
    const turn = cpuMatch.turnFromCards(cpu, player, 12);
    const open = Engine.openCategories(cpu);
    for (const dice of [[1, 2, 3, 4, 5], [6, 6, 2, 3, 5], [4, 4, 4, 4, 4]]) {
      const keep = turn.bestKeep(dice, 2);
      assert.ok(keep && keep.hold.length === 5, 'keep decision');
      assert.ok(keep.values.every(function (v) { return dice.indexOf(v) !== -1; }));
      assert.ok(keep.value >= 0 && keep.value <= 1, 'keep value');
      const choice = turn.bestCategory(dice);
      assert.strictEqual(open.indexOf(choice.catId) !== -1, true, 'open category');
    }
    assert.strictEqual(JSON.stringify(cpu), beforeCpu);
    assert.strictEqual(JSON.stringify(player), beforePlayer);
  });

  ok('browser Match-W caches repeated evaluations', () => {
    const cpu = cardWithTwoOpen('chance', 'yahtzee');
    const player = cardWithOnly('chance', 0);
    const first = cpuMatch.turnFromCards(cpu, player, 12);
    const cached = cpuMatch.stats().cpuTurnCache;
    const second = cpuMatch.turnFromCards(cpu, player, 12);
    assert.strictEqual(second.value, first.value);
    assert.strictEqual(cpuMatch.stats().cpuTurnCache, cached);
  });
}

console.log('\n' + passed + ' checks passed' + (process.exitCode ? ' (with failures)' : '.'));
