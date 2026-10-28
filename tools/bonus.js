/*
 * Learn an empirical upper-bonus model from self-play.
 *   node tools/bonus.js
 *
 * For every turn we record the scorecard's upper total and which upper boxes
 * are still open, then observe the final upper total.  A small linear model of
 * the remaining upper gain is fitted and turned into P(bonus).
 */
'use strict';

const path = require('path');
const fs = require('fs');
const Engine = require(path.join(__dirname, '..', 'src', 'engine.js'));
const { mulberry32, rollFive, reroll } = require(path.join(__dirname, 'train.js'));

const CATS = Engine.CAT_IDS;
const UPPER = Engine.UPPER_IDS;

function playGameCollect(engine, rng, rows) {
  const card = Engine.blankCard();
  const local = [];

  for (let turn = 0; turn < 13; turn++) {
    const open = Engine.openCategories(card);
    if (!open.length) break;
    const openUpper = open.filter((id) => UPPER.includes(id));
    let soloSum = 0;
    for (const id of openUpper) soloSum += engine.soloEV[Engine.CAT_INDEX[id]];
    const u = Engine.upperScore(card);
    local.push({ u, rem: openUpper.length, openAll: open.length, soloSum });

    const solver = engine.solve(open, card);
    let dice = rollFive(rng);
    let rollsLeft = 2;
    while (rollsLeft > 0) {
      const decision = solver.bestKeep(dice, rollsLeft);
      if (!decision || decision.holdAll) break;
      dice = reroll(dice, decision.hold, rng);
      rollsLeft--;
    }
    const choice = solver.bestCategory(dice);
    const bonus = engine.yahtzeeBonusFor(card, dice);
    if (bonus) card.yahtzeeBonus += bonus;
    card.scores[choice.catId] = choice.score;
  }

  const finalUpper = Engine.upperScore(card);
  for (const row of local) {
    row.finalUpper = finalUpper;
    row.gain = finalUpper - row.u;
    row.bonus = finalUpper >= 63 ? 1 : 0;
    rows.push(row);
  }
  return card;
}

function collect(games, seed, tuning) {
  const engine = Engine.createEngine(tuning);
  const rng = mulberry32(seed);
  const rows = [];
  for (let g = 0; g < games; g++) playGameCollect(engine, rng, rows);
  return rows;
}

function solveLeastSquares(X, y, cols) {
  const A = Array.from({ length: cols }, () => new Float64Array(cols + 1));
  for (let r = 0; r < X.length; r++) {
    for (let i = 0; i < cols; i++) {
      for (let j = 0; j < cols; j++) A[i][j] += X[r][i] * X[r][j];
      A[i][cols] += X[r][i] * y[r];
    }
  }
  return solveLinear(A, cols);
}

function solveLinear(A, n) {
  const M = A.map((row) => Float64Array.from(row));
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    if (pivot !== col) {
      const tmp = M[col]; M[col] = M[pivot]; M[pivot] = tmp;
    }
    const div = M[col][col] || 1e-12;
    for (let c = col; c <= n; c++) M[col][c] /= div;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col];
      if (!f) continue;
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  return Array.from({ length: n }, (_, i) => M[i][n]);
}

function sigmoid(z) {
  if (z > 30) return 1;
  if (z < -30) return 0;
  return 1 / (1 + Math.exp(-z));
}

/** Iteratively reweighted least squares logistic regression. */
function trainLogistic(X, y, iters) {
  const n = X.length;
  const f = X[0].length;
  let w = new Float64Array(f);
  for (let it = 0; it < iters; it++) {
    const H = Array.from({ length: f }, () => new Float64Array(f + 1));
    for (let r = 0; r < n; r++) {
      let z = 0;
      for (let i = 0; i < f; i++) z += w[i] * X[r][i];
      const p = sigmoid(z);
      const wt = Math.max(0.000001, p * (1 - p));
      const residual = y[r] - p;
      for (let i = 0; i < f; i++) {
        const xi = X[r][i];
        for (let j = 0; j < f; j++) H[i][j] += wt * xi * X[r][j];
        H[i][f] += residual * xi;
      }
    }
    for (let i = 1; i < f; i++) H[i][i] += 1e-4; // tiny ridge, intercept untouched
    const step = solveLinear(H, f);
    for (let i = 0; i < f; i++) w[i] += step[i];
  }
  return w;
}

// Abramowitz & Stegun 7.1.26
function erf(x) {
  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * z);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  return sign * y;
}
function normalCdf(x) { return 0.5 * (1 + erf(x / Math.SQRT2)); }

function main() {
  const games = parseInt(process.argv[2] || '4000', 10);
  console.log('Collecting ' + games + ' training games…');
  const t0 = Date.now();
  const trainRows = collect(games, 90210, {});
  const testRows = collect(Math.max(400, Math.floor(games / 4)), 5150, {});
  console.log('collected in ' + ((Date.now() - t0) / 1000).toFixed(1) + 's; rows train=' +
    trainRows.length + ' test=' + testRows.length);

  const FEATURE_COUNT = 8;
  const rawFeatures = (r) => {
    const need = Math.max(0, 63 - r.u);
    const avg = r.rem ? r.soloSum / r.rem : 0;
    return [
      need,
      r.soloSum,
      r.rem,
      r.openAll,
      need * need,
      r.soloSum * r.soloSum,
      need * r.soloSum,
      avg
    ];
  };

  const trainRaw = trainRows.map(rawFeatures);
  const means = new Array(FEATURE_COUNT).fill(0);
  const sds = new Array(FEATURE_COUNT).fill(0);
  for (const row of trainRaw) for (let i = 0; i < FEATURE_COUNT; i++) means[i] += row[i];
  for (let i = 0; i < FEATURE_COUNT; i++) means[i] /= trainRaw.length;
  for (const row of trainRaw) for (let i = 0; i < FEATURE_COUNT; i++) sds[i] += (row[i] - means[i]) ** 2;
  for (let i = 0; i < FEATURE_COUNT; i++) sds[i] = Math.sqrt(sds[i] / trainRaw.length) || 1;

  const scaled = (raw) => [1].concat(raw.map((v, i) => (v - means[i]) / sds[i]));
  const X = trainRaw.map(scaled);
  const y = trainRows.map((r) => r.bonus);

  // Baseline: normal model of the remaining upper gain.
  const beta = solveLeastSquares(trainRows.map((r) => [1, r.soloSum, r.rem, r.openAll]), trainRows.map((r) => r.gain), 4);
  let sse = 0;
  for (let i = 0; i < trainRows.length; i++) {
    const row = trainRows[i];
    const pred = beta[0] + beta[1] * row.soloSum + beta[2] * row.rem + beta[3] * row.openAll;
    const e = row.gain - pred;
    sse += e * e;
  }
  const sd = Math.sqrt(sse / trainRows.length);
  console.log('normal gain model: ' + beta.map((v) => v.toFixed(4)).join(', ') + '  residual sd=' + sd.toFixed(2));

  const w = trainLogistic(X, y, 18);
  console.log('logistic: ' + w.map((v) => v.toFixed(4)).join(', '));

  function predictNormal(row) {
    const need = Math.max(0, 63 - row.u);
    const predGain = beta[0] + beta[1] * row.soloSum + beta[2] * row.rem + beta[3] * row.openAll;
    return 1 - normalCdf((need - predGain) / sd);
  }

  function predictLogistic(row) {
    const x = scaled(rawFeatures(row));
    let z = 0;
    for (let i = 0; i < w.length; i++) z += w[i] * x[i];
    return sigmoid(z);
  }

  function report(name, predict) {
    const bins = Array.from({ length: 10 }, () => ({ n: 0, pred: 0, actual: 0 }));
    let brier = 0;
    for (const row of testRows) {
      const p = Math.min(1, Math.max(0, predict(row)));
      const b = Math.min(9, Math.floor(p * 10));
      bins[b].n++;
      bins[b].pred += p;
      bins[b].actual += row.bonus;
      brier += (p - row.bonus) * (p - row.bonus);
    }
    console.log('\nHeld-out calibration — ' + name);
    for (let i = 0; i < bins.length; i++) {
      const b = bins[i];
      if (!b.n) continue;
      console.log('  p ' + (i / 10).toFixed(1) + '-' + ((i + 1) / 10).toFixed(1) +
        '  n=' + String(b.n).padStart(5) +
        '  predicted=' + (100 * b.pred / b.n).toFixed(1) + '%' +
        '  actual=' + (100 * b.actual / b.n).toFixed(1) + '%');
    }
    console.log('  Brier=' + (brier / testRows.length).toFixed(4));
  }

  report('normal', predictNormal);
  report('logistic', predictLogistic);

  const allSolo = Engine.createEngine({}).soloEV.slice(0, 6).reduce((a, b) => a + b, 0);
  const sample = (u, rem, soloSum, openAll) => ({
    u,
    rem,
    soloSum,
    openAll
  });
  console.log('\nSample predictions');
  console.log('  start: 0/63, all 6 open -> normal=' +
    (100 * predictNormal(sample(0, 6, allSolo, 13))).toFixed(1) + '%  logistic=' +
    (100 * predictLogistic(sample(0, 6, allSolo, 13))).toFixed(1) + '%');
  console.log('  50/63, sixes+ones open, 2 turns -> normal=' +
    (100 * predictNormal(sample(50, 2, 12.639 + 2.106, 2))).toFixed(1) + '%  logistic=' +
    (100 * predictLogistic(sample(50, 2, 12.639 + 2.106, 2))).toFixed(1) + '%');

  const out = {
    kind: 'logistic',
    means,
    sds,
    coefficients: Array.from(w),
    samples: trainRows.length,
    games,
    brier: null
  };
  fs.writeFileSync(path.join(__dirname, 'bonus-model.json'), JSON.stringify(out, null, 2) + '\n');
  console.log('\nWrote tools/bonus-model.json');
}

main();
