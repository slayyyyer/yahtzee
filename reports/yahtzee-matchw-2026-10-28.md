# Match-W endgame solver: exact win probability for the final rounds

> **Current benchmark:** the
> [100-game CPU Match-W benchmark](yahtzee-cpu-matchw-2026-10-28.md) measures
> the CPU-role policy now shipped in the browser. This report remains the
> design reference and the exact state-level evaluation of Match-W.

**Bottom line:** I added a second policy, **Match-W**, that keeps the shipped
Exact-W strategy early and then switches to exact `P(win) + 0.5 * P(tie)` for
the final two rounds (12 and 13). It is exact: it enumerates every dice outcome
on the decision maker's turn and represents the opponent's actual Exact-W turn
as an exact distribution. The shipped browser CPU now uses Match-W in those two
rounds.

It works, but the edge is small. On 50 real round-12 states, Match-W raises the
exact win probability by **+0.425 percentage points** (95% CI **+0.235 to
+0.615**); 40 of 50 states improve, 10 tie, and none get worse. The extra value
comes mostly when behind. A 100-game hybrid match went **46–53–1** and averaged
**248.20** against the CPU's **262.74** — the score drop is the deliberate price
of trading expected points for match equity, and the win-rate result is too
noisy to resolve a sub-percentage-point effect.

| model | rounds | games | record | player mean | CPU mean |
|---|---|---:|---:|---:|---:|
| Exact-W control | 1–13 | 100 | **50–50–0** | 253.18 | 261.77 |
| Hybrid Match-W | 1–11 Exact-W, 12–13 Match-W | 100 | **46–53–1** | 248.20 | 262.74 |

## What was implemented

[`tools/match-solver.js`](../tools/match-solver.js) holds the new solver.

- **Early game:** the player still uses the shipped exact expected-score table
  `W(B,u,y)` and its exact turn solver.
- **Final two rounds:** the player maximizes

  ```
  P(player final > CPU final) + 0.5 * P(player final == CPU final)
  ```

  with exact enumeration of every initial roll, every legal hold, every reroll
  outcome, and every bankable category.
- **Opponent turn:** the opponent is not sampled or approximated. Its shipped
  Exact-W policy is evaluated exactly, producing a distribution over the
  resulting `(bits, upper, yahtzee)` state and score delta.
- **Both cards are tracked:** the decision maker's total and the opponent's
  total are part of the state, so the same two open boxes are worth different
  amounts when ahead and when behind.
- **Caching:** opponent policies, opponent outcome distributions, opponent-turn
  values, decision-maker turn solves, and Exact-W policy-evaluation turns are
  cached by state.

The browser now ships a mirror of this solver in
[`src/match-solver.js`](../src/match-solver.js). The CPU is the decision maker;
the human's future turns are modelled as the shipped Exact-W policy. At the
round-12 switch the human has exactly one box left, so their category choice is
forced; only their hold policy is modelled. The headless numbers below are the
player-role benchmark, not a direct measurement of the CPU-role mirror.

## State and recurrence

The endgame state is

```
(round, playerState, cpuState)
playerState = (bits, upper, y, base)
cpuState    = (bits, upper, y, base)
```

`bits` is the open-box mask, `upper` is capped at 63, `y` is 1 only when the
Yahtzee box is closed with 50, and `base` is the score already banked including
the extra-Yahtzee bonus.

For the player:

```
term(c, s) = matchCpuValue(round, applyScore(playerState, c, score, s), cpuState)
playerValue = exact expected term under the optimal hold/bank policy
```

For the CPU:

```
matchCpuValue(round, player, cpu) =
  sum over exact Exact-W outcomes o:
    o.prob * (
      round == 13 ? utility(player, cpu + o.delta)
                  : playerValue(round + 1, player, cpu + o.delta)
    )
```

`utility(a,b)` is 1 when `a > b`, 0.5 when equal, and 0 when `a < b`.

This is the same finite-horizon structure as the existing turn solver, except
the terminal value is match equity instead of points. It is exact for rounds
12–13. It is **not** an exact solution for rounds 1–13: the state space would
include both full cards, and the early-round value would require a much larger
precomputed object.

## Exactness checks

1. **The CPU distribution is the CPU's real policy.** For 20 random CPU cards,
   the distribution summed to 1 within `1e-12`, and its mean final score matched
   `engine.solve(card).expected` within `2e-11`. This checks the implementation
   against the shipped Exact-W solver, not against a separate approximation.

2. **Match-W dominates the fixed Exact-W policy from the same state.** The
   solver includes a second evaluator that follows the Exact-W policy exactly
   and values it with the same match utility. On 50 round-12 states, Match-W
   was at least as high in every state: 40 improved, 10 equal, 0 worse.

3. **The engine tests pass:** `node tools/test-engine.js` now runs **61**
   checks, including the CPU distribution, the locked-win/locked-loss cases, a
   Match-W-vs-Exact-W state comparison, and six browser-role tests (exact last
   turn, locked loss, future-human valuation, scoreboard response, legal
   decisions/no mutation, and caching).

## State-level exact comparison

[`tools/compare-matchw.js`](../tools/compare-matchw.js) plays 11 rounds with
Exact-W, then evaluates both policies at the start of round 12 and round 13.
The values below are **exact probabilities**, not simulated win rates.

| state | states | Match-W | Exact-W | gain | 95% CI | improved / equal / worse |
|---|---:|---:|---:|---:|---:|---:|
| start of round 12 | 50 | 0.475525 | 0.471275 | **+0.425 pp** | +0.235 to +0.615 pp | 40 / 10 / 0 |
| start of round 13 | 50 | 0.507958 | 0.506206 | **+0.175 pp** | +0.038 to +0.313 pp | 13 / 37 / 0 |
| both states combined | 100 | — | — | **+0.300 pp** | +0.162 to +0.438 pp | 53 / 47 / 0 |

The round-12 row is the relevant estimate for a policy that switches at round
12. The round-13 row is measured after an Exact-W round 12, so it is a separate
“last-round-only” estimate, not the marginal value of the full two-round switch.
The combined interval averages the two states within each game, so it reflects
50 independent games rather than treating all 100 state rows as independent.

### When the gain appears

| situation | round 12 gain | round 13 gain |
|---|---:|---:|
| player behind | **+0.514 pp** | **+0.252 pp** |
| player ahead | +0.336 pp | +0.037 pp |
| all | +0.425 pp | +0.175 pp |

The asymmetry is the expected one: when behind, Match-W is willing to give up
mean score for a higher chance of a large swing; when ahead, it protects the
lead. Even so, the absolute effect is small because the final two rounds are
only part of a 13-round game.

### One real decision

Seed `20261028`, game 1, start of round 12: the player has **215**, the CPU has
**229**, and the only open player boxes are **ones** and **twos**. On the final
roll `[2,2,6,6,6]`:

- **Exact-W** banks **twos for 4**, leaving ones open.
- **Match-W** banks **ones for 0**, leaving twos open for the last round.

That looks like giving away four points, but it is the match objective at work:
twos can still pay up to 10 on the last turn, while ones can pay at most 5.
When behind, preserving the higher-ceiling box is worth more than the four
points available now. This is a concrete case where the two policies diverge;
the exact state-level table above is the aggregate effect.

## The 100-game hybrid benchmark

[`tools/benchmark-matchw.js`](../tools/benchmark-matchw.js) uses the same
interleaved round order as the real game, with a seeded Mulberry32 dice stream.
The player uses Exact-W for rounds 1–11 and Match-W for 12–13. The CPU always
uses its shipped Exact-W policy.

| metric | Exact-W control | Hybrid Match-W |
|---|---:|---:|
| games | 100 | 100 |
| record | **50–50–0** | **46–53–1** |
| win rate | 50.0% | 46.0% |
| Win-rate 95% CI | 40.4–59.6% | 36.6–55.7% |
| player mean | 253.18 | **248.20** |
| player SD | 60.74 | 55.47 |
| CPU mean | 261.77 | **262.74** |
| CPU SD | 66.75 | 69.59 |
| mean margin | −8.59 | **−14.54** |
| margin 95% CI | −26.83 to +9.65 | −31.94 to +2.86 |
| upper bonus games | 68 / 100 | 57 / 100 |
| Yahtzee bonus points | 1100 | 900 |

Both runs use seed `20261028`, but they are **not paired after the first
different decision**: a different hold or box consumes a different number of
dice from the shared stream. The state-level table above is the paired
measurement; this table is a realistic whole-game sanity check.

The player's mean falls by about **5 points** (253.18 to 248.20). That is the
expected cost of a win-probability policy: it sometimes takes a lower-EV line
when the scoreboard makes variance valuable. The CPU's mean is essentially
unchanged.

### Why 46–53–1 is not evidence of failure

The exact paired gain from switching at round 12 is **+0.425 pp**. A 100-game
win-rate sample has a standard error of about **5 pp**, so a result 4 pp below
50% is well inside one standard deviation. The 46% confidence interval
(36.6–55.7%) is wide enough to contain 50% and a range of plausible effects.
The exact state-level comparison, which removes dice noise, is the sharper
result.

At the same time, this is not a large improvement. If the goal is “beat the CPU
more often in a single match,” the honest summary is: Match-W is provably at
least as good as Exact-W under this opponent model, but the edge is roughly
**0.4 percentage points** from the final two rounds. Most of any single-game
record is still dice.

## Extending the search earlier

The same code supports `--start-round=11`. A 5-game pilot (15 states) took
**349 seconds** and produced:

| state | states | gain | 95% CI | improved / equal / worse |
|---|---:|---:|---:|---:|
| start of round 11 | 5 | **+1.318 pp** | +0.232 to +2.404 pp | 5 / 0 / 0 |
| start of round 12 | 5 | +0.226 pp | −0.158 to +0.610 pp | 4 / 1 / 0 |
| start of round 13 | 5 | 0.000 pp | 0 to 0 | 0 / 5 / 0 |

The round-11 pilot suggests the edge grows when more of the game is included,
which is what the Bellman recurrence predicts. But five states are far too few
to settle the size, and the runtime is the blocker: about 70 seconds per game
for both-policy evaluation. A 100-game three-round benchmark would take roughly
two hours. The implementation is there; the evidence is not yet.

## What this means

- **For expected final score:** Exact-W is still optimal. Match-W deliberately
  gives up points; do not use it if the objective is the 254.14 table value.
- **For match win probability:** Match-W is optimal for the final two rounds
  against the Exact-W opponent model under the repo rules. The measured
  player-role gain is real but small: about **+0.43 pp** from round 12, rising
  to about **+1.3 pp** in a five-state three-round pilot. The browser CPU uses
  the mirror policy in rounds 12–13.
- **For a single game record:** neither policy can escape dice variance. The
  100-game hybrid record is a draw from a process whose exact edge over the
  baseline is well under one percentage point, not a demonstration that the new
  policy is worse.

## Reproduce

```bash
node tools/test-engine.js

# 100-game Exact-W control
node tools/benchmark-matchw.js --games=100 --seed=20261028 --start-round=14 \
  --out=reports/yahtzee-matchw-control-100.json

# 100-game hybrid: Exact-W through round 11, Match-W in 12-13
node tools/benchmark-matchw.js --games=100 --seed=20261028 --start-round=12 \
  --out=reports/yahtzee-matchw-r12-100.json

# Exact paired state-level comparison at round 12/13
node tools/compare-matchw.js --games=50 --seed=20261028 \
  --out=reports/yahtzee-matchw-evaluation-50.json

# Three-round pilot (slow)
node tools/compare-matchw.js --games=5 --seed=20261028 --start-round=11 --clear \
  --out=reports/yahtzee-matchw-evaluation-r11-pilot-5.json
```

Raw data:

- [100-game hybrid](yahtzee-matchw-r12-100.json)
- [100-game Exact-W control](yahtzee-matchw-control-100.json)
- [50-game exact state evaluation](yahtzee-matchw-evaluation-50.json)
- [5-game three-round pilot](yahtzee-matchw-evaluation-r11-pilot-5.json)

## Browser integration

The browser path is verified separately from the player-role benchmark:

- [`src/match-solver.js`](../src/match-solver.js) uses the same recurrence with
  the CPU as the decision maker and the human as the Exact-W opponent.
- A complete browser game was played through round 13. The CPU insight panel
  reported **`Match-W · exact win probability`** on both endgame turns, the
  final-score dialog appeared, and the page logged no console or network errors.
- On 10 random round-12 states the synchronous browser-role solve took
  **47–1,915 ms** (mean **1.18 s**) in the headless runtime used here. The UI
  shows the computer thinking during the pause; rounds 1–11 and round 13 are
  much faster.
- The six browser-role tests in `tools/test-engine.js` cover the exact last
  turn, a locked loss, future-human valuation, scoreboard monotonicity, legal
  decisions without card mutation, and repeated-state caching.

## Limitations

- The headless benchmark's opponent model is the shipped Exact-W policy under
  this repo's rules. A different bot or official joker rules would need a new
  distribution.
- Only the final two rounds are solved exactly. The three-round pilot is
  implemented but too slow for a large sample.
- The browser CPU models future human turns with Exact-W, not with an adaptive
  or match-aware human model. This is exact for the forced final category, but
  the hold policy is an assumption.
- The 100-game hybrid record is descriptive. The exact state-level comparison
  is the statistically meaningful result.
