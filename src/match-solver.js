/*
 * Match-W endgame solver
 * ----------------------
 * Exact-W maximizes expected score.  In the last two rounds the CPU instead
 * maximizes match equity:
 *
 *   P(CPU wins) + 0.5 * P(tie)
 *
 * The CPU's own turn is solved by exact dice enumeration.  The human's future
 * turns are represented by an exact distribution under the shipped Exact-W
 * policy, which is the only opponent model available in the browser.  At the
 * default switch point (round 12) the human has just one box left on their
 * final turn, so their category choice is forced; only their hold policy is
 * modelled.
 *
 * This is a classic script (no ES modules) so index.html works from file://.
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./engine.js'));
  } else {
    root.YahtzeeMatch = factory(root.YahtzeeEngine);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Engine) {
  'use strict';

  if (!Engine || !Engine.CAT_IDS || !Engine.solveTurn) {
    throw new Error('YahtzeeEngine must load before match-solver.js.');
  }

  const CATS = Engine.CAT_IDS;
  const CAT_INDEX = Engine.CAT_INDEX;
  const LAST_ROUND = 13;
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
      const value = scores[CATS[i]];
      if (value === undefined) {
        bits |= (1 << i);
      } else {
        base += value;
        if (i < 6) upper += value;
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

  function stateKey(state) {
    return state.bits + '|' + state.upper + '|' + state.y + '|' + state.base;
  }

  function policyKey(state) {
    return state.bits + '|' + state.upper + '|' + state.y;
  }

  function totalOf(state) {
    return state.base + (state.upper >= 63 ? 35 : 0);
  }

  function utility(cpuTotal, playerTotal) {
    if (cpuTotal > playerTotal) return 1;
    if (cpuTotal === playerTotal) return TIE_VALUE;
    return 0;
  }

  function openIds(bits) {
    const out = [];
    for (let i = 0; i < CATS.length; i++) {
      if (bits & (1 << i)) out.push(CATS[i]);
    }
    return out;
  }

  function canonicalCard(state) {
    return {
      scores: { ones: state.upper, yahtzee: state.y ? 50 : 0 },
      yahtzeeBonus: 0
    };
  }

  function applyScore(state, ci, score, bonus) {
    const bit = 1 << ci;
    if (!(state.bits & bit)) {
      throw new Error('Category ' + CATS[ci] + ' is already closed.');
    }
    return {
      bits: state.bits & ~bit,
      upper: ci < 6 ? Math.min(63, state.upper + score) : state.upper,
      y: ci === 11 ? (score === 50 ? 1 : 0) : state.y,
      base: state.base + score + bonus
    };
  }

  /**
   * Build a solver for the CPU's turns in rounds 12-13 (or any earlier round
   * if the caller chooses to pay for the larger search).  The returned turn
   * object matches the engine's `solve()` surface for bestKeep/bestCategory.
   */
  function createLateGameSolver(engine) {
    if (!engine || !engine.model) {
      throw new Error('createLateGameSolver needs an engine instance.');
    }

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

    const playerPolicyCache = new Map();
    const playerDistCache = new Map();
    const playerTurnCache = new Map();
    const cpuTurnCache = new Map();

    function stateForDice(dice) {
      if (!dice || dice.length !== 5) return -1;
      const counts = [0, 0, 0, 0, 0, 0];
      for (let i = 0; i < dice.length; i++) {
        const value = dice[i];
        if (!(value >= 1 && value <= 6)) return -1;
        counts[value - 1]++;
      }
      const state = stateIndex.get(countsKey(counts));
      return state === undefined ? -1 : state;
    }

    function holdMask(dice, keep) {
      const need = keep.slice();
      const hold = [false, false, false, false, false];
      for (let i = 0; i < dice.length; i++) {
        const face = dice[i] - 1;
        if (need[face] > 0) {
          need[face]--;
          hold[i] = true;
        }
      }
      return hold;
    }

    function getPlayerPolicy(playerState) {
      const key = policyKey(playerState);
      let solver = playerPolicyCache.get(key);
      if (!solver) {
        solver = engine.solve(openIds(playerState.bits), canonicalCard(playerState));
        playerPolicyCache.set(key, solver);
      }
      return solver;
    }

    /**
     * Exact distribution of the human's next Exact-W turn over their resulting
     * state.  The distribution depends only on the policy state, so the base
     * total is applied by the caller.
     */
    function playerTurnDistribution(playerState) {
      const key = policyKey(playerState);
      const cached = playerDistCache.get(key);
      if (cached) return cached;

      const solver = getPlayerPolicy(playerState);
      const outcomes = new Map();

      function addOutcome(next, prob) {
        if (!(prob > 0)) return;
        const delta = next.base - playerState.base;
        const outcomeKey = next.bits + '|' + next.upper + '|' + next.y + '|' + delta;
        let entry = outcomes.get(outcomeKey);
        if (!entry) {
          entry = {
            bits: next.bits,
            upper: next.upper,
            y: next.y,
            delta: delta,
            prob: 0
          };
          outcomes.set(outcomeKey, entry);
        }
        entry.prob += prob;
      }

      function bank(state, prob) {
        const dice = diceByState[state];
        const choice = solver.bestCategory(dice);
        if (!choice) throw new Error('The Exact-W opponent had no category to bank.');
        const bonus = playerState.y === 1 && fiveKind[state] ? 100 : 0;
        addOutcome(applyScore(playerState, choice.catIndex, choice.score, bonus), prob);
      }

      function walk(state, rollsLeft, prob) {
        if (rollsLeft <= 0) {
          bank(state, prob);
          return;
        }
        const dice = diceByState[state];
        const decision = solver.bestKeep(dice, rollsLeft);
        if (!decision || decision.holdAll) {
          bank(state, prob);
          return;
        }
        const transition = keepTrans[decision.keepId];
        for (let i = 0; i < transition.res.length; i++) {
          walk(transition.res[i], rollsLeft - 1, prob * transition.prob[i]);
        }
      }

      for (let s = 0; s < stateCounts.length; s++) {
        walk(s, 2, freshProb[s]);
      }

      const result = Array.from(outcomes.values());
      playerDistCache.set(key, result);
      return result;
    }

    /**
     * Value after the human's turn in `round`.  The CPU follows in the same
     * round, so this is the bridge from the opponent's distribution back to
     * the CPU's next turn.
     */
    function playerTurnValue(round, playerState, cpuState) {
      if (round > LAST_ROUND) return utility(totalOf(cpuState), totalOf(playerState));
      const key = round + '|' + stateKey(playerState) + '|' + stateKey(cpuState);
      const cached = playerTurnCache.get(key);
      if (cached !== undefined) return cached;

      const outcomes = playerTurnDistribution(playerState);
      let value = 0;
      for (let i = 0; i < outcomes.length; i++) {
        const outcome = outcomes[i];
        const nextPlayer = {
          bits: outcome.bits,
          upper: outcome.upper,
          y: outcome.y,
          base: playerState.base + outcome.delta
        };
        value += outcome.prob * cpuTurnSolve(round, cpuState, nextPlayer).value;
      }

      playerTurnCache.set(key, value);
      return value;
    }

    /**
     * Solve the CPU's current turn.  `term` gives the match value of banking
     * each category with each final dice state, including the rest of the
     * game.  The CPU's later turns also use Match-W, so round 12 correctly
     * values the CPU's last turn after the human's last turn.
     */
    function cpuTurnSolve(round, cpuState, playerState) {
      if (!cpuState.bits) throw new Error('The computer has no open categories.');
      const key = round + '|' + stateKey(cpuState) + '|' + stateKey(playerState);
      const cached = cpuTurnCache.get(key);
      if (cached) return cached;

      const open = openIds(cpuState.bits).map(function (id) {
        return CAT_INDEX[id];
      });

      const term = function (ci, s) {
        const score = scores[ci][s];
        const bonus = cpuState.y === 1 && fiveKind[s] ? 100 : 0;
        const nextCpu = applyScore(cpuState, ci, score, bonus);
        if (round === LAST_ROUND) {
          return utility(totalOf(nextCpu), totalOf(playerState));
        }
        return playerTurnValue(round + 1, playerState, nextCpu);
      };

      const res = Engine.solveTurn(model, open, term);
      let expected = 0;
      for (let s = 0; s < stateCounts.length; s++) expected += freshProb[s] * res.v2[s];

      const out = {
        round: round,
        value: expected,
        res: res,
        cpuState: cpuState,
        playerState: playerState
      };
      cpuTurnCache.set(key, out);
      return out;
    }

    function turnFromCards(cpuCard, playerCard, round) {
      if (!(round >= 1 && round <= LAST_ROUND)) {
        throw new Error('round must be between 1 and 13.');
      }
      const cpuState = stateFromCard(cpuCard);
      const playerState = stateFromCard(playerCard);
      const solved = cpuTurnSolve(round, cpuState, playerState);

      function bestKeep(dice, rollsLeft) {
        const state = stateForDice(dice);
        if (state < 0) return null;
        if (rollsLeft <= 0) {
          return {
            hold: [true, true, true, true, true],
            values: dice.slice().sort(),
            value: solved.res.v0[state],
            holdAll: true,
            keepId: -1
          };
        }
        const keepId = rollsLeft >= 2 ? solved.res.hold2[state] : solved.res.hold1[state];
        return {
          hold: holdMask(dice, keeps[keepId]),
          values: keepDice[keepId].slice(),
          value: rollsLeft >= 2 ? solved.res.v2[state] : solved.res.v1[state],
          holdAll: keepSizes[keepId] === 5,
          keepId: keepId
        };
      }

      function bestCategory(dice) {
        const state = stateForDice(dice);
        if (state < 0) return null;
        const ci = solved.res.bestCat[state];
        if (ci < 0) return null;
        return {
          catId: CATS[ci],
          catIndex: ci,
          score: scores[ci][state]
        };
      }

      function searchSize(dice) {
        const state = stateForDice(dice);
        if (state < 0) return null;
        const openKeeps = model.stateKeeps[state];
        let outcomes = 0;
        for (let i = 0; i < openKeeps.length; i++) {
          outcomes += keepTrans[openKeeps[i]].res.length;
        }
        return { holds: openKeeps.length, outcomes: outcomes };
      }

      return {
        round: round,
        policy: 'Match-W',
        value: solved.value,
        cpuState: cpuState,
        playerState: playerState,
        bestKeep: bestKeep,
        bestCategory: bestCategory,
        searchSize: searchSize
      };
    }

    function clear() {
      playerPolicyCache.clear();
      playerDistCache.clear();
      playerTurnCache.clear();
      cpuTurnCache.clear();
    }

    function stats() {
      return {
        playerPolicyCache: playerPolicyCache.size,
        playerDistCache: playerDistCache.size,
        playerTurnCache: playerTurnCache.size,
        cpuTurnCache: cpuTurnCache.size
      };
    }

    return {
      turnFromCards: turnFromCards,
      clear: clear,
      stats: stats
    };
  }

  return {
    createLateGameSolver: createLateGameSolver,
    stateFromCard: stateFromCard,
    stateKey: stateKey,
    totalOf: totalOf,
    utility: utility
  };
});
