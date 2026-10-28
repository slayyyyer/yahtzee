/*
 * Yahtzee probability engine
 * ---------------------------
 * The computer does not guess: it evaluates every possible outcome of the
 * dice it can still roll, and every legal hold, exactly.  There are only 252
 * distinct five-dice results (order does not matter), so the whole turn can be
 * solved by backward induction in a few milliseconds.
 *
 * The long-term value of the categories that are left over is supplied by a
 * value function over category masks.  It is seeded with the exact solo
 * expected value of every category (computed with the same solver) and
 * calibrated by Monte-Carlo self-play (see tools/train.js).
 *
 * This file is a classic script (no ES modules) so index.html also works when
 * opened straight from disk.
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.YahtzeeEngine = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const N_DICE = 5;
  const N_FACES = 6;
  const N_STATES = 252; // C(5+6-1, 5)
  const N_CATS = 13;
  const UPPER_BONUS = 35;
  const UPPER_TARGET = 63;
  const YAHTZEE_BONUS = 100;

  const FACT = [1, 1, 2, 6, 24, 120, 720];

  const CATEGORIES = [
    { id: 'ones', label: 'Ones', section: 'upper', face: 1, hint: 'Total of all 1s' },
    { id: 'twos', label: 'Twos', section: 'upper', face: 2, hint: 'Total of all 2s' },
    { id: 'threes', label: 'Threes', section: 'upper', face: 3, hint: 'Total of all 3s' },
    { id: 'fours', label: 'Fours', section: 'upper', face: 4, hint: 'Total of all 4s' },
    { id: 'fives', label: 'Fives', section: 'upper', face: 5, hint: 'Total of all 5s' },
    { id: 'sixes', label: 'Sixes', section: 'upper', face: 6, hint: 'Total of all 6s' },
    { id: 'threeKind', label: 'Three of a Kind', section: 'lower', hint: 'Three or more alike — sum all dice' },
    { id: 'fourKind', label: 'Four of a Kind', section: 'lower', hint: 'Four or more alike — sum all dice' },
    { id: 'fullHouse', label: 'Full House', section: 'lower', hint: 'Three of one number and two of another — 25' },
    { id: 'smallStraight', label: 'Small Straight', section: 'lower', hint: 'Four dice in sequence — 30' },
    { id: 'largeStraight', label: 'Large Straight', section: 'lower', hint: 'Five dice in sequence — 40' },
    { id: 'yahtzee', label: 'Yahtzee', section: 'lower', hint: 'Five of a kind — 50' },
    { id: 'chance', label: 'Chance', section: 'lower', hint: 'Sum of all five dice' }
  ];

  const CAT_IDS = CATEGORIES.map(function (c) { return c.id; });
  const CAT_INDEX = Object.create(null);
  CATEGORIES.forEach(function (c, i) { CAT_INDEX[c.id] = i; });
  const UPPER_IDS = CATEGORIES.filter(function (c) { return c.section === 'upper'; }).map(function (c) { return c.id; });
  const LOWER_IDS = CATEGORIES.filter(function (c) { return c.section === 'lower'; }).map(function (c) { return c.id; });

  /* ------------------------------------------------------------------ */
  /* Combinatorics                                                      */
  /* ------------------------------------------------------------------ */

  /** Every count vector of `total` dice across `faces` faces. */
  function multisetCounts(total, faces) {
    const out = [];
    const cur = new Array(faces).fill(0);
    (function rec(face, left) {
      if (face === faces - 1) {
        cur[face] = left;
        out.push(cur.slice());
        cur[face] = 0;
        return;
      }
      for (let k = 0; k <= left; k++) {
        cur[face] = k;
        rec(face + 1, left - k);
      }
      cur[face] = 0;
    })(0, total);
    return out;
  }

  function countsKey(counts) {
    return counts.join(',');
  }

  function sumCounts(counts) {
    let n = 0;
    for (let i = 0; i < counts.length; i++) n += counts[i];
    return n;
  }

  /** Probability that `n` thrown dice land in the given unordered counts. */
  function multinomialProbability(counts, n) {
    let denom = 1;
    for (let i = 0; i < counts.length; i++) denom *= FACT[counts[i]];
    return FACT[n] / denom / Math.pow(6, n);
  }

  function expandCounts(counts) {
    const values = [];
    for (let f = 0; f < counts.length; f++) {
      for (let k = 0; k < counts[f]; k++) values.push(f + 1);
    }
    return values;
  }

  /* ------------------------------------------------------------------ */
  /* Scoring                                                            */
  /* ------------------------------------------------------------------ */

  function scoreForCounts(ci, counts) {
    if (ci < 6) return counts[ci] * (ci + 1);

    let sum = 0;
    let max = 0;
    for (let f = 0; f < N_FACES; f++) {
      const n = counts[f];
      sum += n * (f + 1);
      if (n > max) max = n;
    }

    switch (ci) {
      case 6: // three of a kind
        return max >= 3 ? sum : 0;
      case 7: // four of a kind
        return max >= 4 ? sum : 0;
      case 8: { // full house (a Yahtzee also counts, per the joker rule)
        if (max === 5) return 25;
        let has3 = false;
        let has2 = false;
        for (let f = 0; f < N_FACES; f++) {
          if (counts[f] === 3) has3 = true;
          else if (counts[f] === 2) has2 = true;
        }
        return has3 && has2 ? 25 : 0;
      }
      case 9: // small straight
        for (let start = 0; start < 3; start++) {
          if (counts[start] > 0 && counts[start + 1] > 0 && counts[start + 2] > 0 && counts[start + 3] > 0) return 30;
        }
        return 0;
      case 10: { // large straight
        let low = true;
        let high = true;
        for (let f = 0; f < 5; f++) if (counts[f] === 0) low = false;
        for (let f = 1; f < 6; f++) if (counts[f] === 0) high = false;
        return low || high ? 40 : 0;
      }
      case 11: // yahtzee
        return max === 5 ? 50 : 0;
      case 12: // chance
        return sum;
      default:
        return 0;
    }
  }

  /* ------------------------------------------------------------------ */
  /* The dice model (built once)                                        */
  /* ------------------------------------------------------------------ */

  let MODEL = null;

  function buildModel() {
    const stateCounts = multisetCounts(N_DICE, N_FACES);
    const stateIndex = new Map();
    stateCounts.forEach(function (c, i) { stateIndex.set(countsKey(c), i); });

    const freshProb = new Float64Array(N_STATES);
    for (let s = 0; s < N_STATES; s++) {
      freshProb[s] = multinomialProbability(stateCounts[s], N_DICE);
    }

    // Every possible multiset of held dice: 1 + 6 + 21 + 56 + 126 + 252.
    const keeps = [];
    const keepIndex = new Map();
    for (let k = 0; k <= N_DICE; k++) {
      const vecs = multisetCounts(k, N_FACES);
      for (let i = 0; i < vecs.length; i++) {
        keepIndex.set(countsKey(vecs[i]), keeps.length);
        keeps.push(vecs[i]);
      }
    }
    const keepSizes = keeps.map(sumCounts);
    const keepDice = keeps.map(expandCounts);

    const keepTrans = keeps.map(function (keep, ki) {
      const n = N_DICE - keepSizes[ki];
      const extras = multisetCounts(n, N_FACES);
      const res = new Int32Array(extras.length);
      const prob = new Float64Array(extras.length);
      for (let i = 0; i < extras.length; i++) {
        const merged = new Array(N_FACES);
        for (let f = 0; f < N_FACES; f++) merged[f] = keep[f] + extras[i][f];
        res[i] = stateIndex.get(countsKey(merged));
        prob[i] = multinomialProbability(extras[i], n);
      }
      return { res: res, prob: prob };
    });

    const stateKeeps = new Array(N_STATES);
    for (let s = 0; s < N_STATES; s++) {
      const counts = stateCounts[s];
      const ids = [];
      const cur = new Array(N_FACES).fill(0);
      (function rec(f) {
        if (f === N_FACES) {
          ids.push(keepIndex.get(countsKey(cur)));
          return;
        }
        for (let k = 0; k <= counts[f]; k++) {
          cur[f] = k;
          rec(f + 1);
        }
        cur[f] = 0;
      })(0);
      stateKeeps[s] = Int32Array.from(ids);
    }

    const scores = [];
    for (let ci = 0; ci < N_CATS; ci++) {
      const arr = new Int16Array(N_STATES);
      for (let s = 0; s < N_STATES; s++) arr[s] = scoreForCounts(ci, stateCounts[s]);
      scores.push(arr);
    }

    const fiveKind = new Uint8Array(N_STATES);
    for (let s = 0; s < N_STATES; s++) {
      for (let f = 0; f < N_FACES; f++) {
        if (stateCounts[s][f] === N_DICE) { fiveKind[s] = 1; break; }
      }
    }

    const model = {
      stateCounts: stateCounts,
      stateIndex: stateIndex,
      freshProb: freshProb,
      keeps: keeps,
      keepSizes: keepSizes,
      keepDice: keepDice,
      keepTrans: keepTrans,
      stateKeeps: stateKeeps,
      scores: scores,
      fiveKind: fiveKind,
      soloEV: null
    };

    computeSoloStats(model);
    return model;
  }

  function getModel() {
    if (!MODEL) MODEL = buildModel();
    return MODEL;
  }

  /* ------------------------------------------------------------------ */
  /* Turn solver                                                        */
  /* ------------------------------------------------------------------ */

  /**
   * One step of backward induction: for every dice state, pick the hold whose
   * re-rolled outcomes maximise expected value at the next level.
   */
  function evalLevel(model, prev, out, holds) {
    const stateKeeps = model.stateKeeps;
    const keepTrans = model.keepTrans;
    const keepSizes = model.keepSizes;
    for (let s = 0; s < N_STATES; s++) {
      const ks = stateKeeps[s];
      let best = -Infinity;
      let bestKeep = -1;
      let bestSize = -1;
      for (let ki = 0; ki < ks.length; ki++) {
        const k = ks[ki];
        const tr = keepTrans[k];
        const res = tr.res;
        const prob = tr.prob;
        let sum = 0;
        for (let j = 0; j < res.length; j++) sum += prob[j] * prev[res[j]];
        // Prefer holding more dice on an exact tie (it also lets the AI stop
        // rolling when extra rolls cannot improve anything).
        if (sum > best || (sum === best && keepSizes[k] > bestSize)) {
          best = sum;
          bestKeep = k;
          bestSize = keepSizes[k];
        }
      }
      out[s] = best;
      holds[s] = bestKeep;
    }
  }

  /**
   * Solve a turn exactly.  `termFn(categoryIndex, stateIndex)` is the value of
   * scoring that category with that final roll, including whatever the rest of
   * the game is worth.
   */
  function solveTurn(model, openCats, termFn) {
    const v0 = new Float64Array(N_STATES);
    const bestCat = new Int8Array(N_STATES);

    for (let s = 0; s < N_STATES; s++) {
      let best = -Infinity;
      let bc = -1;
      for (let k = 0; k < openCats.length; k++) {
        const ci = openCats[k];
        const val = termFn(ci, s);
        if (val > best) { best = val; bc = ci; }
      }
      v0[s] = best;
      bestCat[s] = bc;
    }

    const v1 = new Float64Array(N_STATES);
    const hold1 = new Int16Array(N_STATES);
    evalLevel(model, v0, v1, hold1);

    const v2 = new Float64Array(N_STATES);
    const hold2 = new Int16Array(N_STATES);
    evalLevel(model, v1, v2, hold2);

    return { v0: v0, v1: v1, v2: v2, hold1: hold1, hold2: hold2, bestCat: bestCat };
  }

  /**
   * Exact expected score of one category played alone with three rolls.  These
   * values seed the future-value model (and are used by the upper-bonus odds).
   */
  function computeSoloStats(model) {
    const soloEV = new Float64Array(N_CATS);
    for (let ci = 0; ci < N_CATS; ci++) {
      const solver = solveTurn(model, [ci], function (c, s) {
        return model.scores[c][s];
      });
      let ev = 0;
      for (let s = 0; s < N_STATES; s++) ev += model.freshProb[s] * solver.v2[s];
      soloEV[ci] = ev;
    }
    model.soloEV = soloEV;
  }

  /* ------------------------------------------------------------------ */
  /* Cards                                                              */
  /* ------------------------------------------------------------------ */

  function blankCard() {
    return { scores: Object.create(null), yahtzeeBonus: 0 };
  }

  function upperScore(card) {
    let sum = 0;
    for (let i = 0; i < 6; i++) sum += card.scores[CAT_IDS[i]] || 0;
    return sum;
  }

  function lowerScore(card) {
    let sum = 0;
    for (let i = 6; i < N_CATS; i++) sum += card.scores[CAT_IDS[i]] || 0;
    return sum;
  }

  function upperBonus(card) {
    return upperScore(card) >= UPPER_TARGET ? UPPER_BONUS : 0;
  }

  function totalScore(card) {
    return upperScore(card) + lowerScore(card) + upperBonus(card) + (card.yahtzeeBonus || 0);
  }

  function isCardComplete(card) {
    for (let i = 0; i < N_CATS; i++) {
      if (card.scores[CAT_IDS[i]] === undefined) return false;
    }
    return true;
  }

  function openCategories(card) {
    const out = [];
    for (let i = 0; i < N_CATS; i++) {
      if (card.scores[CAT_IDS[i]] === undefined) out.push(CAT_IDS[i]);
    }
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* Engine                                                             */
  /* ------------------------------------------------------------------ */

  // Future-value model used by the game.  The per-category values were
  // produced by policy iteration in tools/policy.js: start from the exact
  // solo expectations, play thousands of seeded self-play games, blend the
  // observed category yields back in, repeat, and keep the best defender
  // against two independent seeds.  tools/tune.js then swept the bonus
  // weight.  Self-play average: ~250 points (perfect play: 254.59).
  const CALIBRATED_VALUES = [
    1.918,   // ones
    4.5365,  // twos
    7.1395,  // threes
    9.973,   // fours
    12.851,  // fives
    15.7895, // sixes
    18.6925, // three of a kind
    9.8255,  // four of a kind
    16.207,  // full house
    24.1115, // small straight
    22.512,  // large straight
    6.4905,  // yahtzee
    23.0415  // chance
  ];

  const DEFAULT_TUNING = {
    scale: 1,
    offset: 0,
    bonusWeight: 1,
    baseValues: CALIBRATED_VALUES
  };

  // Upper-bonus probability model, fitted on 52,000 turn states from 4,000
  // self-play games (tools/bonus.js).  Inputs: points still needed, sum of the
  // exact solo values of the open upper boxes, number of open upper boxes,
  // total number of open boxes, and three interaction terms.  A logistic
  // regression beat a normal model of the remaining upper score (Brier 0.157
  // vs 0.209) on a held-out seed.
  const BONUS_MODEL = {
    means: [
      34.58340384615384, 24.218865740740906, 3.148326923076923, 7,
      1728.2442115384615, 837.1086703745735, 1194.4408680555746, 6.785261091819406
    ],
    sds: [
      23.07016233042738, 15.828935927807635, 2.0735465458332367, 3.7416573867739413,
      1544.0502465280697, 747.7372215466321, 1076.8429628435426, 3.2773605160276746
    ],
    weights: [
      0.4093128422351527, -13.998675857381965, 14.21212659532198,
      -1.6123955705709108, 0.744912738008601, -10.819831168195488,
      -19.543817831300498, 30.770106681648663, -0.8284372110820999
    ]
  };

  function createEngine(overrides) {
    const model = getModel();
    const tuning = Object.assign({}, DEFAULT_TUNING, overrides || {});
    const baseValues = (tuning.baseValues && tuning.baseValues.length === N_CATS
      ? tuning.baseValues.slice()
      : Array.from(model.soloEV));

    let remainingCache = new Map(); // mask -> base value
    let bonusCache = new Map(); // mask*128+upper -> probability
    let futureCache = new Map(); // mask*128+upper -> total future value

    function remainingBase(bits) {
      let cached = remainingCache.get(bits);
      if (cached !== undefined) return cached;
      let sum = 0;
      let count = 0;
      for (let ci = 0; ci < N_CATS; ci++) {
        if (bits & (1 << ci)) { sum += baseValues[ci]; count++; }
      }
      cached = tuning.scale * sum + tuning.offset * count;
      remainingCache.set(bits, cached);
      return cached;
    }

    /**
     * Probability that the upper bonus is reached, from the empirical model
     * fitted in tools/bonus.js.  `bits` is the set of all open boxes (used for
     * the total turn budget), `upper` is the current upper total.
     */
    function bonusProbability(bits, upper) {
      if (upper >= UPPER_TARGET) return 1;
      const upperMask = bits & 0x3F;
      if (upperMask === 0) return 0;

      const key = bits * 128 + upper;
      let cached = bonusCache.get(key);
      if (cached !== undefined) return cached;

      const need = UPPER_TARGET - upper;
      let rem = 0;
      let soloSum = 0;
      let openAll = 0;
      for (let i = 0; i < N_CATS; i++) if (bits & (1 << i)) openAll++;
      for (let i = 0; i < 6; i++) {
        if (upperMask & (1 << i)) {
          rem++;
          soloSum += model.soloEV[i];
        }
      }
      const avg = rem ? soloSum / rem : 0;
      const raw = [need, soloSum, rem, openAll, need * need, soloSum * soloSum, need * soloSum, avg];
      let z = BONUS_MODEL.weights[0];
      for (let i = 0; i < 8; i++) {
        z += BONUS_MODEL.weights[i + 1] * (raw[i] - BONUS_MODEL.means[i]) / BONUS_MODEL.sds[i];
      }
      let prob;
      if (z > 30) prob = 1;
      else if (z < -30) prob = 0;
      else prob = 1 / (1 + Math.exp(-z));
      bonusCache.set(key, prob);
      return prob;
    }

    function futureValue(bits, upper) {
      if (bits === 0) return 0;
      const key = bits * 128 + Math.min(upper, UPPER_TARGET);
      let cached = futureCache.get(key);
      if (cached !== undefined) return cached;
      cached = remainingBase(bits) + UPPER_BONUS * tuning.bonusWeight * bonusProbability(bits, upper);
      futureCache.set(key, cached);
      return cached;
    }

    function stateFor(dice) {
      const counts = [0, 0, 0, 0, 0, 0];
      for (let i = 0; i < dice.length; i++) {
        const v = dice[i];
        if (!(v >= 1 && v <= 6)) return -1;
        counts[v - 1]++;
      }
      if (sumCounts(counts) !== N_DICE) return -1;
      const idx = model.stateIndex.get(countsKey(counts));
      return idx === undefined ? -1 : idx;
    }

    function holdMask(dice, keepCounts) {
      const need = keepCounts.slice();
      const hold = [false, false, false, false, false];
      for (let i = 0; i < dice.length; i++) {
        const f = dice[i] - 1;
        if (need[f] > 0) { need[f]--; hold[i] = true; }
      }
      return hold;
    }

    function weightedFresh(values) {
      let sum = 0;
      for (let s = 0; s < N_STATES; s++) sum += model.freshProb[s] * values[s];
      return sum;
    }

    /**
     * Solve the remainder of one turn.
     * @param {string[]} openIds categories still open on the card
     * @param {object} card the player's scorecard
     */
    function solve(openIds, card) {
      const open = openIds.map(function (id) { return CAT_INDEX[id]; }).sort(function (a, b) { return a - b; });
      let bits = 0;
      for (let i = 0; i < open.length; i++) bits |= (1 << open[i]);
      const upper = upperScore(card);
      const extraYahtzee = card.scores && card.scores.yahtzee === 50 ? YAHTZEE_BONUS : 0;

      const term = function (ci, s) {
        const sc = model.scores[ci][s];
        const u2 = upper + (ci < 6 ? sc : 0);
        let value = sc + futureValue(bits & ~(1 << ci), u2);
        if (extraYahtzee && model.fiveKind[s]) value += extraYahtzee;
        return value;
      };

      const res = solveTurn(model, open, term);
      const expected = weightedFresh(res.v2);

      function bestKeep(dice, rollsLeft) {
        const s = stateFor(dice);
        if (s < 0) return null;
        if (rollsLeft <= 0) {
          return {
            hold: [true, true, true, true, true],
            values: dice.slice().sort(),
            value: res.v0[s],
            holdAll: true,
            keepId: -1
          };
        }
        const keepId = rollsLeft >= 2 ? res.hold2[s] : res.hold1[s];
        return {
          hold: holdMask(dice, model.keeps[keepId]),
          values: model.keepDice[keepId].slice(),
          value: rollsLeft >= 2 ? res.v2[s] : res.v1[s],
          holdAll: model.keepSizes[keepId] === N_DICE,
          keepId: keepId
        };
      }

      function keepOptions(dice, rollsLeft, limit) {
        const s = stateFor(dice);
        if (s < 0) return [];
        const prev = rollsLeft >= 2 ? res.v1 : res.v0;
        const ks = model.stateKeeps[s];
        const options = [];
        for (let i = 0; i < ks.length; i++) {
          const k = ks[i];
          const tr = model.keepTrans[k];
          let sum = 0;
          for (let j = 0; j < tr.res.length; j++) sum += tr.prob[j] * prev[tr.res[j]];
          options.push({
            hold: holdMask(dice, model.keeps[k]),
            values: model.keepDice[k].slice(),
            value: sum,
            keepId: k
          });
        }
        options.sort(function (a, b) { return b.value - a.value; });
        return typeof limit === 'number' ? options.slice(0, limit) : options;
      }

      function bestCategory(dice) {
        const s = stateFor(dice);
        if (s < 0) return null;
        const ci = res.bestCat[s];
        if (ci < 0) return null;
        const sc = model.scores[ci][s];
        const u2 = upper + (ci < 6 ? sc : 0);
        const future = futureValue(bits & ~(1 << ci), u2);
        return {
          catId: CAT_IDS[ci],
          catIndex: ci,
          score: sc,
          future: future,
          value: res.v0[s],
          yahtzeeBonus: extraYahtzee && model.fiveKind[s] ? extraYahtzee : 0
        };
      }

      function stopValue(dice) {
        const s = stateFor(dice);
        return s < 0 ? null : res.v0[s];
      }

      function valueFor(dice, rollsLeft) {
        if (rollsLeft >= 3) return expected;
        const s = stateFor(dice);
        if (s < 0) return null;
        return rollsLeft === 2 ? res.v2[s] : rollsLeft === 1 ? res.v1[s] : res.v0[s];
      }

      /** How many hold patterns and hold+outcome lines this roll state uses. */
      function searchSize(dice) {
        const s = stateFor(dice);
        if (s < 0) return null;
        const keeps = model.stateKeeps[s];
        let outcomes = 0;
        for (let i = 0; i < keeps.length; i++) outcomes += model.keepTrans[keeps[i]].res.length;
        return { holds: keeps.length, outcomes: outcomes };
      }

      return {
        openIds: openIds.slice(),
        upper: upper,
        expected: expected,
        bestKeep: bestKeep,
        keepOptions: keepOptions,
        bestCategory: bestCategory,
        stopValue: stopValue,
        valueFor: valueFor,
        searchSize: searchSize,
        turnValue: res
      };
    }

    function scoreFor(catId, dice) {
      const ci = CAT_INDEX[catId];
      const s = stateFor(dice);
      if (ci === undefined || s < 0) return 0;
      return model.scores[ci][s];
    }

    function fiveOfAKind(dice) {
      for (let i = 1; i < dice.length; i++) if (dice[i] !== dice[0]) return false;
      return dice.length === N_DICE;
    }

    function yahtzeeBonusFor(card, dice) {
      return fiveOfAKind(dice) && card.scores.yahtzee === 50 ? YAHTZEE_BONUS : 0;
    }

    function bonusChance(openIds, card) {
      let bits = 0;
      for (let i = 0; i < openIds.length; i++) bits |= (1 << CAT_INDEX[openIds[i]]);
      return bonusProbability(bits, upperScore(card));
    }

    return {
      model: model,
      tuning: tuning,
      soloEV: Array.from(model.soloEV),
      solve: solve,
      scoreFor: scoreFor,
      fiveOfAKind: fiveOfAKind,
      yahtzeeBonusFor: yahtzeeBonusFor,
      bonusChance: bonusChance,
      remainingBase: remainingBase,
      futureValue: function (openIds, card) {
        let bits = 0;
        for (let i = 0; i < openIds.length; i++) bits |= (1 << CAT_INDEX[openIds[i]]);
        return futureValue(bits, upperScore(card));
      },
      upperScore: upperScore,
      lowerScore: lowerScore,
      upperBonus: upperBonus,
      totalScore: totalScore,
      isCardComplete: isCardComplete,
      openCategories: openCategories,
      blankCard: blankCard,
      categories: CATEGORIES,
      catIds: CAT_IDS,
      upperIds: UPPER_IDS,
      lowerIds: LOWER_IDS
    };
  }

  return {
    createEngine: createEngine,
    CATEGORIES: CATEGORIES,
    CAT_IDS: CAT_IDS,
    UPPER_IDS: UPPER_IDS,
    LOWER_IDS: LOWER_IDS,
    CAT_INDEX: CAT_INDEX,
    UPPER_BONUS: UPPER_BONUS,
    UPPER_TARGET: UPPER_TARGET,
    YAHTZEE_BONUS: YAHTZEE_BONUS,
    blankCard: blankCard,
    upperScore: upperScore,
    lowerScore: lowerScore,
    upperBonus: upperBonus,
    totalScore: totalScore,
    isCardComplete: isCardComplete,
    openCategories: openCategories,
    scoreForCounts: scoreForCounts
  };
});
