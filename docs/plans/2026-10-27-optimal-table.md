# Exact optimal Yahtzee table implementation plan

Goal: replace the approximate long-game value function with an exact offline
table `W(B, u, y)`, wired into the AI and coach, while keeping the dependency-
free file:// game and the heuristic fallback.

Design: the reviewed recurrence. Valid states are 786,432; the indexed table is
1,048,576 Float32 entries (4 MiB). `B` is the open-box mask, `u` is the upper
total capped at 63, `y` is 1 only when the Yahtzee box is closed with 50.

Not doing: maximizing win probability against a human, shipping the official
rules table, UI redesign, or committing/pushing without a separate request.

## Task 1 — Add a values-only turn solver

Files: `src/engine.js` (add `solveTurnValues`, export `getModel`, `solveTurn`,
`solveTurnValues`), `tools/test-engine.js` (equality check).

Change: add a scratch-buffer solver that computes `v0/v1/v2` without allocating
`bestCat` or hold arrays. It must reuse caller-provided `Float64Array(252)` and
`Int16Array(252)` buffers and return `v2`.

Verify: `node tools/test-engine.js` → the new equality check passes and the
existing 36 checks still pass.

## Task 2 — Load and use the table with a safe fallback

Files: `src/engine.js`, `tools/test-engine.js` (synthetic-table test).

Change: add `decodeOptimalTable(base64)` (length-checked, returns `null` on
failure), accept an `optimalTable` option in `createEngine`, and use
`W(B, u, y)` in `solve()`/`bestCategory()`. Fix the fallback terminal value at
`bits === 0` to include the upper bonus. Keep the heuristic when no table is
present.

Verify: `node tools/test-engine.js` → synthetic table is read at the expected
index, fallback ignores it, invalid base64 returns `null`, and all existing
checks pass.

## Task 3 — Implement the table generator

Files: `tools/solve-optimal.js` (new), `tools/optimal-worker.js` if worker code
is split out.

Change: generate the table by ascending popcount, with reusable scratch
buffers. Support two Float64 validation modes: `--official` for the joker rules
that match the published benchmark (matching upper first; otherwise any open
lower box with 25/30/40 or the dice sum; an open upper box may also be zeroed)
and `--strict` for the narrower reading (a zero in an upper box is only allowed
after the lower section is full). The normal mode uses repo rules and Float32.
Support `--workers` (use up to 16 for full runs) and `--max-pop` for a smoke run
that does not write the shipped files. Neither validation mode may write
`src/optimal-table.js`.

Verify: `node tools/solve-optimal.js --workers=1 --max-pop=2` exits 0 and
reports per-layer progress without writing outputs; an `--official` smoke run
passes the single-box check.

## Task 4 — Validate the DP against 254.5896

Files: none written; the validation table is discarded.

Change: run the official-rules table generation, then record the stricter
reading separately. The official mode allows an open upper box to be zeroed
while lower boxes remain, which is the reading that reproduces the published
benchmark.

Verify: `--official` prints `W(8191, 0, 0)` within `0.001` of `254.5896`.
Record the `--strict` value (about `254.5877`) and its distance from the
benchmark as a second check, but do not fail strict mode for that difference.

## Task 5 — Generate the shipped repo table

Files: `tools/optimal-table.bin`, `src/optimal-table.js`.

Change: run the normal table generation with repo rules. Record
`W_repo(8191, 0, 0)`. Do not compare it to 254.5896 as a pass/fail.

Verify: `.bin` is exactly 4,194,304 bytes; `src/optimal-table.js` sets the
global base64; print the repo exact value and generation time.

## Task 6 — Wire the trainer to the table

Files: `tools/load-table.js` (new), `tools/train.js`.

Change: add `--optimal` to load `tools/optimal-table.bin` and pass the table to
`createEngine`; leave `tools/tune.js` and `tools/bonus.js` on the heuristic.
Run 5,000 seeded games with the table.

Verify: `node tools/train.js --games=5000 --optimal` → mean is within
`1.96 * SD / sqrt(5000)` of `W_repo`; report mean, SD, upper-bonus rate, and
Yahtzee bonus per game.

## Task 7 — Add table regression tests

Files: `tools/test-engine.js`.

Change: load `tools/optimal-table.bin` when present; add full-card value,
terminal, all-13 single-box, upper/y monotonicity, fallback, and finite-state
checks. Keep the old heuristic action tests on a fallback engine so exact-play
changes do not silently rewrite them.

Verify: `node tools/test-engine.js` → all old and new checks pass; update the
README count afterwards.

## Task 8 — Wire the browser

Files: `index.html`, `src/app.js`.

Change: load `src/optimal-table.js` before `src/engine.js`; decode it once and
pass `optimalTable` to `createEngine`. If the global is absent or invalid, use
the fallback.

Verify: start a local static server, open the game in the preview browser,
play a complete turn, confirm the coach/AI still work, and check the console for
errors.

## Task 9 — Update the README

Files: `README.md`.

Change: replace the “not a lookup table” description with the exact table and
fallback; update the project layout, development commands, test count, and
measured strength. Label 254.5896 as the official-rules benchmark and report
the repo exact value separately.

Verify: read the diff and confirm every number matches the generator/trainer
outputs.

## Task 10 — Final verification and self-review

Files: all changed files.

Change: run the full suite, inspect the final diff, and check the generated
artifacts. Do not commit or push unless the user asks.

Verify: `node tools/test-engine.js` exits 0; generator outputs exist with the
expected sizes; the browser smoke test passes; README numbers match the
recorded outputs.

## Results (2026-10-28)

- Official-rules validation: `W(8191,0,0) = 254.589097` against the published
  `254.5896` (difference `5.027e-4`). The narrower `--strict` reading gives
  `254.587729`, also recorded.
- Shipped repo-rules table: `W(8191,0,0) = 254.143784`; `tools/optimal-table.bin`
  is 4,194,304 bytes and `src/optimal-table.js` is 5,592,600 bytes.
- Generation time: 1m 37s with 16 workers.
- Self-play (`node tools/train.js --games=5000 --optimal`): mean **254.16**,
  SD 58.84, 95% CI ±1.63, upper bonus 67.6%, Yahtzee bonus 9.38 per game.
  The mean is within the confidence interval of the exact 254.143784.
- Tests: **50 checks passed**, including the generated table, the base64 copy,
  monotonicity, single-box values, and a mid-game table-versus-heuristic check.
- Browser smoke test: served over localhost (equivalent to `file://` for the
  scripts), the 5.6 MB table decoded to 1,048,576 entries
  (`W(8191,0,0) = 254.14378357` in Float32), a full turn was played, the CPU
  answered, and there were no console errors.
