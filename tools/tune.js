/*
 * Monte-Carlo calibration for the engine's future-value model.
 *   node tools/tune.js
 *
 * Each parameter set plays the same number of seeded games.  The score is the
 * mean final score; the standard error is reported so small differences are
 * not over-read.
 */
'use strict';

const path = require('path');
const Engine = require(path.join(__dirname, '..', 'src', 'engine.js'));
const { playGame, mulberry32 } = require(path.join(__dirname, 'train.js'));

function evaluate(tuning, games, seed) {
  const engine = Engine.createEngine(tuning);
  const rng = mulberry32(seed);
  let sum = 0;
  let sumSq = 0;
  let bon = 0;
  for (let g = 0; g < games; g++) {
    const card = playGame(engine, rng);
    const s = Engine.totalScore(card);
    sum += s;
    sumSq += s * s;
    if (Engine.upperBonus(card)) bon++;
  }
  const mean = sum / games;
  const variance = Math.max(0, sumSq / games - mean * mean);
  return {
    mean: +mean.toFixed(2),
    se: +(Math.sqrt(variance / games)).toFixed(2),
    bonus: +((100 * bon) / games).toFixed(1)
  };
}

const GAMES = process.argv.includes('--quick') ? 300 : 600;
const SEED = 7717;

const results = [];
const scales = [1.0, 1.1, 1.2, 1.3];
const offsets = [0, 4, 8];
const bonusWeights = [1, 2, 3, 4];

console.log('Calibrating ' + scales.length * offsets.length * bonusWeights.length +
  ' parameter sets, ' + GAMES + ' games each');
for (const scale of scales) {
  for (const offset of offsets) {
    for (const bonusWeight of bonusWeights) {
      const r = evaluate({ scale, offset, bonusWeight }, GAMES, SEED);
      results.push(Object.assign({ scale, offset, bonusWeight }, r));
      console.log('scale=' + scale.toFixed(2) + ' offset=' + offset + ' bw=' + bonusWeight +
        '  mean=' + r.mean + ' ±' + r.se + '  bonus=' + r.bonus + '%');
    }
  }
}

results.sort((a, b) => b.mean - a.mean);
console.log('\nTop 10:');
for (const r of results.slice(0, 10)) {
  console.log('  scale=' + r.scale + ' offset=' + r.offset + ' bw=' + r.bonusWeight +
    '  mean=' + r.mean + ' ±' + r.se + '  bonus=' + r.bonus + '%');
}
