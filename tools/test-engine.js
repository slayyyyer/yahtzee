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

console.log('\n' + passed + ' checks passed' + (process.exitCode ? ' (with failures)' : '.'));
