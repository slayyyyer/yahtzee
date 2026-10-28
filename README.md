# Yahtzee — Probability Engine

A one-player, browser-only Yahtzee game. You play against a computer that does
not rely on canned rules of thumb: for every turn it enumerates every possible
continuation, values every hold exactly, and plays the long game with a value
function calibrated by seeded self-play.

## Play

Open [index.html](index.html) in a modern browser. There is no install, build
step, dependency or network request.

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

### 2. A value function for the rest of the game

A turn decision is only as good as the value assigned to the boxes that remain.
The engine uses a per-category value (seeded with the exact solo expectation of
each box) plus the probability of the 35-point upper bonus:

- `tools/bonus.js` fits a logistic model of the bonus on **52,000 turn states**
  from 4,000 self-play games. It predicts the bonus from the points needed, the
  open upper boxes, the total turn budget and interaction terms. On a held-out
  seed it scores a Brier of 0.157, versus 0.209 for a normal model of the
  remaining upper score.
- The category values went through policy iteration: start from the exact solo
  expectations, play thousands of seeded games, blend the observed category
  yields back in, repeat, and keep the variant that holds up on independent
  seeds.

The result is a compact model, not a lookup table or a neural network: it is
transparent, fast enough to run on the main thread, and strong enough to play
the percentages at every decision point.

### 3. Measured strength

5,000 seeded self-play games with the shipped configuration:

| metric | result |
| --- | --- |
| mean final score | **250.39** |
| standard deviation | 61.15 |
| 95% confidence interval | ±1.69 |
| upper bonus earned | 64.2% of games |
| Yahtzee bonus points | 9.9 per game |
| perfect-play expected score | 254.59 |

That is within roughly 2% of the known optimal expected score, and clearly
above casual human play (typically around 200). The engine never estimates the
dice with a random rollout; the randomness comes only from the actual rolls.

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
  box is open is **not** enforced; the joker bonus is always available.
- A Yahtzee rolled while the Yahtzee box holds 0 does not earn the +100 bonus.
- Ones through Sixes score the sum of the dice showing that face; Three/Four
  of a Kind sum all five dice; Chance sums all five dice.

## Project layout

```
index.html            page, rules dialog, final-score dialog
styles.css            felt table, dice, scorecard, responsive layout
src/engine.js         dice model, exact turn solver, value function, scoring
src/app.js            game flow, AI pacing, coach, scorecard UI, persistence
icon.svg              app / favicon mark
pinokio.json          static Pinokio metadata
tools/test-engine.js  36 correctness checks
tools/train.js        seeded self-play evaluation
tools/tune.js         grid sweep for the value-model weights
tools/bonus.js        fits the empirical upper-bonus model
tools/bonus-model.json  the fitted coefficients (also baked into engine.js)
```

## Development

Node 18+ is enough; there are no npm dependencies.

```bash
node tools/test-engine.js         # scoring, probabilities, DP and bonus checks
node tools/train.js --games=3000  # self-play average and per-category report
node tools/tune.js                # sweep scale / offset / bonus weight
node tools/bonus.js 4000          # refit the bonus model (writes bonus-model.json)
```

The trainer seeds its PRNG, so repeated runs with the same seed are
reproducible. If you refit `bonus.js`, copy the new `means`, `sds` and
`coefficients` into `BONUS_MODEL` in [src/engine.js](src/engine.js); the game
keeps the model inline so it works from `file://` with no fetch.

The engine is a classic script (no ES modules), which means double-clicking
`index.html` works. `localStorage` is wrapped in `try/catch` for browsers that
restrict storage on file URLs.

## A note on the numbers

"Projected score" figures are deliberately not shown in the interface. The
value function is calibrated for *choices*, not for predicting an exact final
score from an arbitrary mid-game state, and showing a number that looks like a
score but is not one would be misleading. The coach shows decisions and honest
probability estimates instead.
