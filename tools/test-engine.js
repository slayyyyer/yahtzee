/*
 * Correctness checks for the probability engine.
 *   node tools/test-engine.js
 */
'use strict';

const path = require('path');
const assert = require('assert');
const Engine = require(path.join(__dirname, '..', 'src', 'engine.js'));

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

console.log('\n' + passed + ' checks passed' + (process.exitCode ? ' (with failures)' : '.'));
