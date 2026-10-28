# Yahtzee — Probability Engine

A one-player, browser-only Yahtzee game. You play against a computer that does
not rely on canned rules of thumb: for every turn it enumerates every possible
continuation, values every hold exactly, and values the rest of the game with a
precomputed exact table. Under this game's rules the optimal expected score is
**254.143784**.

## Play

**Play online:** <https://slayyyyer.github.io/yahtzee/>

Or open [index.html](index.html) in a modern browser. There is no install,
build step, dependency or network request.

Optional local server:

```bash
npx serve .
# or
python -m http.server 8000
```

`pinokio.json` is included, so the folder can also be used as a static Pinokio
web app.

## The interface

- **Roll dice** starts a turn. Click any die to hold it between rolls. You have
  three rolls.
- **Bank a score** by clicking any open box on the scorecard. Open boxes show
  what the current roll would pay there. You may bank after any roll.
- **Coach** (on by default) shows the optimal hold, the best box if you stop
  now, your current odds of the 35-point upper bonus, and the next-best lines.
  The number in the coach header is the size of the search for this roll.
- **The computer's turn** is animated: its rolls, holds, search size and final
  decision are shown in the insight panel while it plays.
- **New game** arms on the first click and restarts on the second, so a stray
  click cannot wipe a game. Your win/loss record is kept in `localStorage`.
- `Esc` closes the rules or final-score dialog. All controls are native buttons
  and keyboard reachable.

## How the computer plays

### 1. Every turn is solved, not sampled

There are only **252 distinct five-dice results** (order is irrelevant). Each
one appears with its exact multinomial probability, so the 7,776 ordered rolls
collapse into a small, exact probability space.

For a given roll there are at most 32 distinct ways to hold dice. The engine
walks backwards through the remaining rolls:

```
value(final roll)   = best score now + value of the boxes left
value(roll with 1)  = best hold, weighted over every reroll outcome
value(roll with 2)  = best hold, weighted over every reroll outcome
```

The same DP tells the computer whether to **stop early**: if holding all five
dice is the best option, extra rolls cannot improve the expected total, so it
banks instead of rolling for the sake of rolling. A solve takes roughly 2 ms.

### 2. An exact table for the rest of the game

A turn decision is only as good as the value assigned to the boxes that remain.
That value is precomputed offline. The state is:

- `B` — the 13-bit set of open boxes;
- `u` — the upper-section total, capped at 63;
- `y` — 1 only when the Yahtzee box is closed with 50.

`W(B, u, y)` is the expected score from the start of a turn. The generator
works backwards by popcount, solving every turn exactly and looking up the
already-computed states with one fewer box. There are 786,432 reachable states
in a 1,048,576-entry Float32 array (4 MiB). Under this game's rules the empty
card is worth **254.143784** expected points.

The table ships in two forms:

- `tools/optimal-table.bin` — the raw Float32 table for the Node tools;
- `src/optimal-table.js` — the same table as base64, loaded by a script tag so
  `index.html` still works from `file://` with no fetch.

It is generated reproducibly by [tools/solve-optimal.js](tools/solve-optimal.js),
which takes about two minutes on 16 worker threads. If the table is missing or
fails to decode, the engine falls back to the older heuristic: per-category
values from policy iteration plus a logistic upper-bonus model (`tools/bonus.js`,
Brier 0.157 versus 0.209 for a normal model of the remaining upper score). The
fallback is a safety net, not what the shipped game uses.

### 3. Measured strength

5,000 seeded self-play games with the exact table
(`node tools/train.js --games=5000 --optimal`):

| metric | result |
| --- | --- |
| mean final score | **254.16** |
| standard deviation | 58.84 |
| 95% confidence interval | ±1.63 |
| exact expected value | 254.143784 |
| upper bonus earned | 67.6% of games |
| Yahtzee bonus points | 9.38 per game |

The mean matches the table's exact full-card value within its confidence
interval. The older heuristic averaged 250.39 with the same trainer (SD 61.15,
upper bonus 64.2%), so the table is worth about 3.8 points per game.

A separate **45-game browser benchmark** against the deployed build is recorded
in [reports/yahtzee-benchmark-2026-10-28.md](reports/yahtzee-benchmark-2026-10-28.md).
It finished **24–20–1**, averaging **256.58** to the computer's **240.76**. The
95% interval on the margin includes zero, as expected when both sides use the
same solver; the 20-game extension went 14–6 after a 10–14–1 start. An
independent 100-game headless rerun with the same **Exact-W** model (seed
`20261028`) went **42–57–1**, averaging **253.88–257.25**; the player mean stayed
within 0.3 of 254.14, so the 45-game record was the noisy part.

The official-rules benchmark is **254.5896** (Verhoeff). Official joker rules
score an extra Yahtzee differently; this game deliberately uses the permissive
rule documented below, so its exact value is 254.143784, not 254.5896. The
generator's `--official` mode reproduces the benchmark independently:
**254.589097**, within 0.0005.

Either way the engine is far above casual human play (typically around 200).
It never estimates the dice with a random rollout; the randomness comes only
from the actual rolls.

### 4. The coach

The coach uses the same engine as the opponent. It shows what the computer
would do on your turn, including the exact hold, the best box if you bank, the
bonus probability, and the runner-up lines. It is advice, not an autoplayer.

## Rules implemented

- Standard 13 boxes: Ones–Sixes, Three of a Kind, Four of a Kind, Full House,
  Small Straight, Large Straight, Yahtzee, Chance.
- Upper bonus: **35 points** when the six upper boxes total 63 or more.
- Yahtzee: 50 points for five of a kind. Every **extra** Yahtzee after the
  Yahtzee box has been scored for 50 is worth **+100**, and may be banked in any
  open box.
- A five of a kind also counts as a full house (joker rule). The official
  restriction that an extra Yahtzee must use its matching upper box when that
  box is open is **not** enforced; the +100 bonus is added wherever the roll is
  banked.
- A Yahtzee rolled while the Yahtzee box holds 0 does not earn the +100 bonus.
- Ones through Sixes score the sum of the dice showing that face; Three/Four
  of a Kind sum all five dice; Chance sums all five dice.

## Project layout

```
index.html            page, rules dialog, final-score dialog
styles.css            felt table, dice, scorecard, responsive layout
src/engine.js         dice model, exact turn solver, table lookup, scoring
src/optimal-table.js  generated base64 table (about 5.6 MB)
src/app.js            game flow, AI pacing, coach, scorecard UI, persistence
icon.svg              app / favicon mark
pinokio.json          static Pinokio metadata
tools/test-engine.js  50 correctness checks
tools/solve-optimal.js  exact table generator and official validation
tools/optimal-table.bin  generated raw table (4 MiB)
tools/load-table.js   loads the raw table for the Node tools
tools/train.js        seeded self-play evaluation
tools/benchmark-match.js  seeded headless 100-game match verification
tools/render-benchmark.js  benchmark JSON and SVG chart generator
tools/tune.js         grid sweep for the fallback weights
tools/bonus.js        fits the fallback upper-bonus model
tools/bonus-model.json  the fitted coefficients (also baked into engine.js)
docs/plans/2026-10-27-optimal-table.md  implementation plan and results
```

## Development

Node 18+ is enough; there are no npm dependencies.

```bash
node tools/test-engine.js                    # 50 checks
node tools/train.js --games=5000 --optimal   # exact-table self-play
node tools/solve-optimal.js --official --workers=16  # benchmark check, no files
node tools/solve-optimal.js --workers=16     # regenerate the shipped table
node tools/tune.js                           # sweep fallback weights
node tools/bonus.js 4000                     # refit the fallback bonus model
```

The table generator is deterministic. It writes `tools/optimal-table.bin` and
`src/optimal-table.js` from the same Float32 array. `--official` runs the
official-rules DP in Float64 and checks the published **254.5896** value;
`--strict` records the narrower joker reading (**254.587729**), and
`--max-pop=2` is a quick smoke run that writes nothing.

The trainer seeds its PRNG, so repeated runs with the same seed are
reproducible. Without `--optimal` it evaluates the heuristic fallback. If you
refit `bonus.js`, copy the new `means`, `sds` and `coefficients` into
`BONUS_MODEL` in [src/engine.js](src/engine.js); the fallback model stays inline
so the game also works from `file://` with no fetch.

The engine is a classic script (no ES modules), which means double-clicking
`index.html` works. `localStorage` is wrapped in `try/catch` for browsers that
restrict storage on file URLs.

## A note on the numbers

The table gives an exact expected final score, but a single game is still
dominated by the dice. The interface shows decisions and probabilities rather
than a projected score, so a lucky or unlucky run is not mistaken for a change
in the strategy's strength.
