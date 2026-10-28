'use strict';

/**
 * Match-W: an exact endgame solver for P(win) + 0.5 * P(tie).
 *
 * The early game still uses Exact-W. Starting at a chosen round, the player's
 * turn is solved with exact dice enumeration and a win-probability terminal
 * value. The CPU keeps its shipped Exact-W policy; its turn is represented by
 * an exact distribution over resulting cards.
 *
 *   const solver = createMatchSolver(engine);
 *   const turn = solver.turnFromCards(playerCard, cpuCard, 13);
 *   turn.bestKeep(dice, rollsLeft);
 *   turn.bestCategory(dice);
 *
 * No browser, no LLM in the decision loop.
 */

const path = require('path');
const Engine = require(path.join(__dirname, '..', 'src', 'engine.js'));

const CATS = Engine.CAT_IDS;
const CAT_INDEX = Engine.CAT_INDEX;
const TIE_VALUE = 0.5;

function countsKey(counts) {
  return counts.join(',');
}

function stateFromCard(card) {
  let bits = 0;
  let base = 0;
  let upper = 0;
  const scores = card.scores || {};
  for (let i = 0; i < CATS.length; i++) {
    const v = scores[CATS[i]];
    if (v === undefined) {
      bits |= (1 << i);
    } else {
      base += v;
      if (i < 6) upper += v;
    }
  }
  base += card.yahtzeeBonus || 0;
  return {
    bits: bits,
    upper: Math.min(63, upper),
    y: scores.yahtzee === 50 ? 1 : 0,
    base: base
  };
}

function stateKey(s) {
  return s.bits + '|' + s.upper + '|' + s.y + '|' + s.base;
}

function policyKey(s) {
  return s.bits + '|' + s.upper + '|' + s.y;
}

function totalOf(s) {
  return s.base + (s.upper >= 63 ? 35 : 0);
}

function utility(playerTotal, cpuTotal) {
  if (playerTotal > cpuTotal) return 1;
  if (playerTotal === cpuTotal) return TIE_VALUE;
  return 0;
}

function openIds(bits) {
  const out = [];
  for (let i = 0; i < CATS.length; i++) if (bits & (1 << i)) out.push(CATS[i]);
  return out;
}

function createMatchSolver(engine) {
  const model = engine.model;
  const stateIndex = model.stateIndex;
  const stateCounts = model.stateCounts;
  const freshProb = model.freshProb;
  const keepTrans = model.keepTrans;
  const keeps = model.keeps;
  const keepDice = model.keepDice;
  const keepSizes = model.keepSizes;
  const scores = model.scores;
  const fiveKind = model.fiveKind;

  const diceByState = stateCounts.map(function (counts) {
    const dice = [];
    for (let f = 0; f < 6; f++) {
      for (let n = 0; n < counts[f]; n++) dice.push(f + 1);
    }
    return dice;
  });

  function stateForDice(dice) {
    const counts = [0, 0, 0, 0, 0, 0];
    for (let i = 0; i < dice.length; i++) counts[dice[i] - 1]++;
    const s = stateIndex.get(countsKey(counts));
    return s === undefined ? -1 : s;
  }

  function holdMask(dice, keep) {
    const need = keep.slice();
    const hold = [false, false, false, false, false];
    for (let i = 0; i < dice.length; i++) {
      const f = dice[i] - 1;
      if (need[f] > 0) {
        need[f]--;
        hold[i] = true;
      }
    }
    return hold;
  }

  function canonicalCard(s) {
    return {
      scores: { ones: s.upper, yahtzee: s.y ? 50 : 0 },
      yahtzeeBonus: 0
    };
  }

  function applyScore(s, ci, score, bonus) {
    const bit = 1 << ci;
    if (!(s.bits & bit)) throw new Error('Category ' + CATS[ci] + ' is already closed.');
    return {
      bits: s.bits & ~bit,
      upper: ci < 6 ? Math.min(63, s.upper + score) : s.upper,
      y: ci === 11 ? (score === 50 ? 1 : 0) : s.y,
      base: s.base + score + bonus
    };
  }

  const cpuPolicyCache = new Map();
  const cpuDistCache = new Map();
  const cpuValueCache = new Map();
  const playerTurnCache = new Map();
  const exactPolicyTurnCache = new Map();
  const exactCpuValueCache = new Map();

  function getCpuPolicy(cpuState) {
    const key = policyKey(cpuState);
    let solver = cpuPolicyCache.get(key);
    if (!solver) {
      solver = engine.solve(openIds(cpuState.bits), canonicalCard(cpuState));
      cpuPolicyCache.set(key, solver);
    }
    return solver;
  }

  /**
   * Distribution of the CPU's Exact-W turn over `(bits, upper, y, deltaBase)`.
   * The distribution depends only on the policy state, so it is cached without
   * the CPU's current base total.
   */
  function cpuTurnDistribution(cpuState) {
    const key = policyKey(cpuState);
    const cached = cpuDistCache.get(key);
    if (cached) return cached;

    const solver = getCpuPolicy(cpuState);
    const outcomes = new Map();

    function addOutcome(bits, upper, y, delta, prob) {
      if (!(prob > 0)) return;
      const k = bits + '|' + upper + '|' + y + '|' + delta;
      let entry = outcomes.get(k);
      if (!entry) {
        entry = { bits: bits, upper: upper, y: y, delta: delta, prob: 0 };
        outcomes.set(k, entry);
      }
      entry.prob += prob;
    }

    function bank(s, prob) {
      const dice = diceByState[s];
      const choice = solver.bestCategory(dice);
      if (!choice) throw new Error('CPU had no category to bank.');
      const bonus = cpuState.y === 1 && fiveKind[s] ? 100 : 0;
      const ci = choice.catIndex;
      const score = choice.score;
      addOutcome(
        cpuState.bits & ~(1 << ci),
        ci < 6 ? Math.min(63, cpuState.upper + score) : cpuState.upper,
        ci === 11 ? (score === 50 ? 1 : 0) : cpuState.y,
        score + bonus,
        prob
      );
    }

    function rec(s, rollsLeft, prob) {
      if (rollsLeft <= 0) {
        bank(s, prob);
        return;
      }
      const dice = diceByState[s];
      const decision = solver.bestKeep(dice, rollsLeft);
      if (!decision || decision.holdAll) {
        bank(s, prob);
        return;
      }
      const tr = keepTrans[decision.keepId];
      for (let i = 0; i < tr.res.length; i++) {
        rec(tr.res[i], rollsLeft - 1, prob * tr.prob[i]);
      }
    }

    for (let s = 0; s < stateCounts.length; s++) {
      rec(s, 2, freshProb[s]);
    }

    const result = Array.from(outcomes.values());
    cpuDistCache.set(key, result);
    return result;
  }

  function cpuValue(round, playerState, cpuState) {
    const key = round + '|' + stateKey(playerState) + '|' + stateKey(cpuState);
    const cached = cpuValueCache.get(key);
    if (cached !== undefined) return cached;

    let value = 0;
    const outcomes = cpuTurnDistribution(cpuState);
    for (let i = 0; i < outcomes.length; i++) {
      const o = outcomes[i];
      const nextCpu = {
        bits: o.bits,
        upper: o.upper,
        y: o.y,
        base: cpuState.base + o.delta
      };
      value += o.prob * (
        round === 13
          ? utility(totalOf(playerState), totalOf(nextCpu))
          : playerValue(round + 1, playerState, nextCpu)
      );
    }

    cpuValueCache.set(key, value);
    return value;
  }

  function playerValue(round, playerState, cpuState) {
    return playerTurnSolver(round, playerState, cpuState).value;
  }

  /**
   * Value of the shipped Exact-W policy under the same match objective. This
   * is the comparison policy: it fixes the player's holds and category choices
   * to engine.solve, then evaluates the exact distribution of the rest of the
   * game. Match-W must be at least this high from the same state.
   */
  function exactPolicyPlayerValue(round, playerState, cpuState) {
    if (!playerState.bits) throw new Error('Player has no open categories.');
    const key = round + '|' + stateKey(playerState) + '|' + stateKey(cpuState);
    const cached = exactPolicyTurnCache.get(key);
    if (cached !== undefined) return cached;

    const solver = getCpuPolicy(playerState);
    const memo = new Map();

    function bank(s, rollsLeft) {
      const dice = diceByState[s];
      const choice = solver.bestCategory(dice);
      if (!choice) throw new Error('Exact-W policy had no category to bank.');
      const bonus = playerState.y === 1 && fiveKind[s] ? 100 : 0;
      return exactCpuValue(round, applyScore(playerState, choice.catIndex, choice.score, bonus), cpuState);
    }

    function valueState(s, rollsLeft) {
      const k = s + '|' + rollsLeft;
      const hit = memo.get(k);
      if (hit !== undefined) return hit;
      let value;
      if (rollsLeft <= 0) {
        value = bank(s, rollsLeft);
      } else {
        const dice = diceByState[s];
        const decision = solver.bestKeep(dice, rollsLeft);
        if (!decision || decision.holdAll) {
          value = bank(s, rollsLeft);
        } else {
          const tr = keepTrans[decision.keepId];
          value = 0;
          for (let i = 0; i < tr.res.length; i++) {
            value += tr.prob[i] * valueState(tr.res[i], rollsLeft - 1);
          }
        }
      }
      memo.set(k, value);
      return value;
    }

    let expected = 0;
    for (let s = 0; s < stateCounts.length; s++) expected += freshProb[s] * valueState(s, 2);
    exactPolicyTurnCache.set(key, expected);
    return expected;
  }

  function exactCpuValue(round, playerState, cpuState) {
    const key = round + '|' + stateKey(playerState) + '|' + stateKey(cpuState);
    const cached = exactCpuValueCache.get(key);
    if (cached !== undefined) return cached;

    let value = 0;
    const outcomes = cpuTurnDistribution(cpuState);
    for (let i = 0; i < outcomes.length; i++) {
      const o = outcomes[i];
      const nextCpu = {
        bits: o.bits,
        upper: o.upper,
        y: o.y,
        base: cpuState.base + o.delta
      };
      value += o.prob * (
        round === 13
          ? utility(totalOf(playerState), totalOf(nextCpu))
          : exactPolicyPlayerValue(round + 1, playerState, nextCpu)
      );
    }

    exactCpuValueCache.set(key, value);
    return value;
  }

  function playerTurnSolver(round, playerState, cpuState) {
    if (!playerState.bits) throw new Error('Player has no open categories.');
    const key = round + '|' + stateKey(playerState) + '|' + stateKey(cpuState);
    const cached = playerTurnCache.get(key);
    if (cached) return cached;

    const open = openIds(playerState.bits).map(function (id) { return CAT_INDEX[id]; });
    const term = function (ci, s) {
      const score = scores[ci][s];
      const bonus = playerState.y === 1 && fiveKind[s] ? 100 : 0;
      return cpuValue(round, applyScore(playerState, ci, score, bonus), cpuState);
    };
    const res = Engine.solveTurn(model, open, term);
    let expected = 0;
    for (let s = 0; s < stateCounts.length; s++) expected += freshProb[s] * res.v2[s];

    function bestKeep(dice, rollsLeft) {
      const s = stateForDice(dice);
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
        hold: holdMask(dice, keeps[keepId]),
        values: keepDice[keepId].slice(),
        value: rollsLeft >= 2 ? res.v2[s] : res.v1[s],
        holdAll: keepSizes[keepId] === 5,
        keepId: keepId
      };
    }

    function bestCategory(dice) {
      const s = stateForDice(dice);
      if (s < 0) return null;
      const ci = res.bestCat[s];
      if (ci < 0) return null;
      return {
        catId: CATS[ci],
        catIndex: ci,
        score: scores[ci][s]
      };
    }

    const out = {
      round: round,
      value: expected,
      res: res,
      bestKeep: bestKeep,
      bestCategory: bestCategory,
      playerState: playerState,
      cpuState: cpuState
    };
    playerTurnCache.set(key, out);
    return out;
  }

  function turnFromCards(playerCard, cpuCard, round) {
    return playerTurnSolver(round, stateFromCard(playerCard), stateFromCard(cpuCard));
  }

  function valueFromCards(playerCard, cpuCard, round) {
    return turnFromCards(playerCard, cpuCard, round).value;
  }

  function exactPolicyValueFromCards(playerCard, cpuCard, round) {
    return exactPolicyPlayerValue(round, stateFromCard(playerCard), stateFromCard(cpuCard));
  }

  function compareFromCards(playerCard, cpuCard, round) {
    const p = stateFromCard(playerCard);
    const c = stateFromCard(cpuCard);
    const match = playerValue(round, p, c);
    const exact = exactPolicyPlayerValue(round, p, c);
    return { match: match, exact: exact, diff: match - exact };
  }

  function clear() {
    cpuPolicyCache.clear();
    cpuDistCache.clear();
    cpuValueCache.clear();
    playerTurnCache.clear();
    exactPolicyTurnCache.clear();
    exactCpuValueCache.clear();
  }

  function stats() {
    return {
      cpuPolicyCache: cpuPolicyCache.size,
      cpuDistCache: cpuDistCache.size,
      cpuValueCache: cpuValueCache.size,
      playerTurnCache: playerTurnCache.size,
      exactPolicyTurnCache: exactPolicyTurnCache.size,
      exactCpuValueCache: exactCpuValueCache.size
    };
  }

  return {
    turnFromCards: turnFromCards,
    valueFromCards: valueFromCards,
    exactPolicyValueFromCards: exactPolicyValueFromCards,
    compareFromCards: compareFromCards,
    clear: clear,
    stats: stats,
    stateFromCard: stateFromCard,
    stateKey: stateKey,
    totalOf: totalOf,
    utility: utility,
    cpuTurnDistribution: cpuTurnDistribution,
    cpuValue: cpuValue,
    playerValue: playerValue,
    exactPolicyPlayerValue: exactPolicyPlayerValue
  };
}

module.exports = {
  createMatchSolver: createMatchSolver,
  stateFromCard: stateFromCard,
  stateKey: stateKey,
  totalOf: totalOf,
  utility: utility
};
