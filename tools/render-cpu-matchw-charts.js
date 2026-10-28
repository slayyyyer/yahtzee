'use strict';

/**
 * Build the SVG charts for the 100-game CPU Match-W benchmark.
 *
 *   node tools/render-cpu-matchw-charts.js
 *
 * Reads the treatment and Exact-W control JSON files, validates that they are
 * complete 13-round games, and writes four charts to reports/charts.
 * No dependencies. Node 18+ (or Bun) is enough.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const TREATMENT_PATH = path.join(ROOT, 'reports', 'yahtzee-cpu-matchw-100.json');
const CONTROL_PATH = path.join(ROOT, 'reports', 'yahtzee-cpu-exact-control-100.json');
const CHART_DIR = path.join(ROOT, 'reports', 'charts');

const treatment = JSON.parse(fs.readFileSync(TREATMENT_PATH, 'utf8'));
const control = JSON.parse(fs.readFileSync(CONTROL_PATH, 'utf8'));

/* ------------------------------------------------------------------ */
/* Validate the recorded data                                          */
/* ------------------------------------------------------------------ */

function fail(message) {
  throw new Error(message);
}
function close(a, b, tolerance) {
  return Math.abs(a - b) <= tolerance;
}
function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
function sd(values) {
  const m = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - m) * (value - m), 0) / (values.length - 1));
}
function median(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
function recordOf(games) {
  const record = { wins: 0, losses: 0, ties: 0 };
  games.forEach(game => {
    if (game.player > game.cpu) record.wins++;
    else if (game.player < game.cpu) record.losses++;
    else record.ties++;
  });
  return record;
}
function validate(dataset, label, cpuPolicy) {
  if (!Array.isArray(dataset.games) || dataset.games.length !== 100) {
    fail(label + ': expected 100 games.');
  }
  if (dataset.summary.games !== 100) fail(label + ': summary says ' + dataset.summary.games + ' games.');

  const derivedRecord = recordOf(dataset.games);
  ['wins', 'losses', 'ties'].forEach(key => {
    if (dataset.summary.record[key] !== derivedRecord[key]) {
      fail(label + ': ' + key + ' mismatch (' + derivedRecord[key] + ' vs ' + dataset.summary.record[key] + ').');
    }
  });

  const player = dataset.games.map(game => game.player);
  const cpu = dataset.games.map(game => game.cpu);
  if (!close(mean(player), dataset.summary.player.mean, 0.02)) fail(label + ': player mean mismatch.');
  if (!close(mean(cpu), dataset.summary.cpu.mean, 0.02)) fail(label + ': CPU mean mismatch.');
  if (!close(sd(player), dataset.summary.player.sd, 0.02)) fail(label + ': player SD mismatch.');
  if (!close(sd(cpu), dataset.summary.cpu.sd, 0.02)) fail(label + ': CPU SD mismatch.');
  if (!close(median(player), dataset.summary.player.median, 0.01)) fail(label + ': player median mismatch.');
  if (!close(median(cpu), dataset.summary.cpu.median, 0.01)) fail(label + ': CPU median mismatch.');
  if (!close(mean(dataset.games.map(game => game.margin)), dataset.summary.margin.mean, 0.02)) {
    fail(label + ': mean margin mismatch.');
  }

  dataset.games.forEach(game => {
    if (!Array.isArray(game.history) || game.history.length !== 13) {
      fail(label + ': game ' + game.id + ' does not have 13 rounds.');
    }
    const playerCard = Object.values(game.playerCard).reduce((sum, value) => sum + value, 0);
    const cpuCard = Object.values(game.cpuCard).reduce((sum, value) => sum + value, 0);
    const playerRounds = game.history.reduce((sum, round) => sum + round.player.score, 0);
    const cpuRounds = game.history.reduce((sum, round) => sum + round.cpu.score, 0);
    if (playerCard !== playerRounds) fail(label + ': game ' + game.id + ' player card does not reconcile.');
    if (cpuCard !== cpuRounds) fail(label + ': game ' + game.id + ' CPU card does not reconcile.');
    if (playerCard + game.playerUpperBonus + game.playerYahtzeeBonus !== game.player) {
      fail(label + ': game ' + game.id + ' player total does not reconcile.');
    }
    if (cpuCard + game.cpuUpperBonus + game.cpuYahtzeeBonus !== game.cpu) {
      fail(label + ': game ' + game.id + ' CPU total does not reconcile.');
    }
    if (game.margin !== game.player - game.cpu) {
      fail(label + ': game ' + game.id + ' margin does not match the scores.');
    }
    game.history.forEach((round, index) => {
      const expected = cpuPolicy(index + 1);
      if (round.cpu.policy !== expected) {
        fail(label + ': game ' + game.id + ' round ' + (index + 1) + ' CPU policy is ' + round.cpu.policy + ', expected ' + expected + '.');
      }
      if (round.player.policy !== 'Exact-W') {
        fail(label + ': game ' + game.id + ' round ' + (index + 1) + ' player policy is not Exact-W.');
      }
    });
  });
}

validate(treatment, 'Treatment', round => (round >= 12 ? 'Match-W' : 'Exact-W'));
validate(control, 'Control', () => 'Exact-W');

const T = treatment.games;
const C = control.games;
const N = T.length;
const tPlayer = T.map(game => game.player);
const tCpu = T.map(game => game.cpu);
const cPlayer = C.map(game => game.player);
const cCpu = C.map(game => game.cpu);
const tMargins = T.map(game => game.margin);
const tSummary = treatment.summary;
const cSummary = control.summary;

/* ------------------------------------------------------------------ */
/* SVG helpers                                                         */
/* ------------------------------------------------------------------ */

const COL = {
  bg: '#10251d',
  cream: '#f5eeda',
  muted: '#a4b3a8',
  muted2: '#7f9187',
  gold: '#d9b567',
  goldBright: '#f2d493',
  mint: '#8ec9a6',
  coral: '#dd7b5d',
  line: 'rgba(245,238,218,0.12)',
  lineStrong: 'rgba(245,238,218,0.24)'
};

function esc(value) {
  return String(value).replace(/[&<>"']/g, ch => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[ch]));
}
function fmt1(value) {
  return Number(value).toFixed(1);
}
function fmt0(value) {
  return String(Math.round(value));
}
function signed1(value) {
  const number = Number(value);
  return (number > 0 ? '+' : '') + number.toFixed(1);
}
function text(x, y, value, cls, anchor, extra) {
  return '<text x="' + x + '" y="' + y + '" class="' + (cls || '') + '"' +
    (anchor ? ' text-anchor="' + anchor + '"' : '') +
    (extra ? ' ' + extra : '') + '>' + esc(value) + '</text>';
}
function line(x1, y1, x2, y2, cls, extra) {
  return '<line x1="' + x1 + '" y1="' + y1 + '" x2="' + x2 + '" y2="' + y2 + '" class="' + (cls || '') + '"' +
    (extra ? ' ' + extra : '') + '/>';
}
function rect(x, y, width, height, fill, extra) {
  return '<rect x="' + x + '" y="' + y + '" width="' + width + '" height="' + height + '" fill="' + fill + '"' +
    (extra ? ' ' + extra : '') + '/>';
}
function chart(title, subtitle, body) {
  return '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<svg xmlns="http://www.w3.org/2000/svg" width="960" height="560" viewBox="0 0 960 560" role="img" aria-labelledby="chart-title chart-desc">\n' +
    '<title id="chart-title">' + esc(title) + '</title>\n' +
    '<desc id="chart-desc">' + esc(subtitle) + '</desc>\n' +
    '<defs>\n' +
    '<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#132a20"/><stop offset=".55" stop-color="#10251d"/><stop offset="1" stop-color="#0a1712"/></linearGradient>\n' +
    '<radialGradient id="glow" cx="72%" cy="-8%" r="72%"><stop offset="0" stop-color="#d9b567" stop-opacity=".18"/><stop offset="1" stop-color="#d9b567" stop-opacity="0"/></radialGradient>\n' +
    '<style>\n' +
    '.title{font-family:Georgia,"Times New Roman",serif;font-size:27px;font-weight:600;fill:#f5eeda;letter-spacing:.2px}\n' +
    '.sub{font-family:"Segoe UI",Arial,sans-serif;font-size:13px;fill:#a4b3a8}\n' +
    '.eyebrow{font-family:"Segoe UI",Arial,sans-serif;font-size:10px;font-weight:700;letter-spacing:2.2px;fill:#d9b567}\n' +
    '.axis{font-family:"Segoe UI",Arial,sans-serif;font-size:11px;fill:#7f9187}\n' +
    '.axis-strong{font-family:"Segoe UI",Arial,sans-serif;font-size:11px;fill:#a4b3a8}\n' +
    '.label{font-family:"Segoe UI",Arial,sans-serif;font-size:12px;fill:#f5eeda}\n' +
    '.small{font-family:"Segoe UI",Arial,sans-serif;font-size:10px;fill:#a4b3a8}\n' +
    '.tiny{font-family:"Segoe UI",Arial,sans-serif;font-size:9px;fill:#7f9187}\n' +
    '.num{font-family:Consolas,"Cascadia Mono",monospace;font-size:12px;fill:#f5eeda}\n' +
    '.num-small{font-family:Consolas,"Cascadia Mono",monospace;font-size:10px;fill:#a4b3a8}\n' +
    '.grid{stroke:#f5eeda;stroke-opacity:.08;stroke-width:1}\n' +
    '.grid-strong{stroke:#f5eeda;stroke-opacity:.16;stroke-width:1}\n' +
    '.axis-line{stroke:#f5eeda;stroke-opacity:.25;stroke-width:1}\n' +
    '.ev{stroke:#f5eeda;stroke-opacity:.55;stroke-width:1.2;stroke-dasharray:4 4}\n' +
    '.band{fill:#d9b567;fill-opacity:.10}\n' +
    '</style>\n' +
    '</defs>\n' +
    '<rect width="960" height="560" fill="url(#bg)"/>\n' +
    '<rect width="960" height="560" fill="url(#glow)"/>\n' +
    '<rect x="0" y="0" width="960" height="4" fill="#d9b567"/>\n' +
    '<text x="56" y="47" class="eyebrow">YAHTZEE · CPU MATCH-W BENCHMARK</text>\n' +
    text(56, 82, title, 'title') + '\n' +
    text(56, 107, subtitle, 'sub') + '\n' +
    text(904, 47, 'seed 20261028 · 100 games', 'tiny', 'end') + '\n' +
    body + '\n' +
    '</svg>\n';
}
function legend(x, y, label, color, dashed) {
  if (dashed) {
    return line(x, y - 4, x + 14, y - 4, '', 'stroke="' + color + '" stroke-width="2" stroke-dasharray="4 3"') +
      text(x + 20, y, label, 'small');
  }
  return rect(x, y - 9, 11, 11, color, 'rx="2"') + text(x + 17, y, label, 'small');
}
function footerLine(body, y) {
  return body + rect(56, y, 848, 1, COL.line);
}

/* ------------------------------------------------------------------ */
/* Chart 1 — cumulative record against a fair coin                     */
/* ------------------------------------------------------------------ */

function recordChart() {
  const left = 76, right = 838, top = 142, bottom = 448;
  const plotW = right - left;
  const plotH = bottom - top;
  const yMax = 65;
  const y = value => bottom - (value / yMax) * plotH;
  const x = game => left + (game / N) * plotW;

  let body = '';
  for (let tick = 0; tick <= 60; tick += 10) {
    body += line(left, y(tick), right, y(tick), tick === 0 ? 'axis-line' : 'grid');
    body += text(left - 14, y(tick) + 4, String(tick), 'axis', 'end');
  }
  body += text(28, top + plotH / 2, 'WINS', 'eyebrow', 'middle', 'transform="rotate(-90 28 ' + (top + plotH / 2) + ')"');
  for (let game = 0; game <= N; game += 10) {
    body += line(x(game), bottom, x(game), bottom + 5, 'axis-line');
    body += text(x(game), bottom + 22, String(game), 'axis', game === 0 ? 'start' : game === N ? 'end' : 'middle');
  }
  body += text((left + right) / 2, bottom + 44, 'GAME', 'eyebrow', 'middle');

  // 95% range of cumulative wins for a fair coin.
  const upper = [];
  const lower = [];
  for (let game = 0; game <= N; game++) {
    const half = 1.96 * Math.sqrt(game * 0.25);
    upper.push([game, game / 2 + half]);
    lower.push([game, Math.max(0, game / 2 - half)]);
  }
  let band = 'M ' + x(0) + ' ' + y(upper[0][1]);
  upper.slice(1).forEach(point => { band += ' L ' + x(point[0]) + ' ' + y(point[1]); });
  lower.slice().reverse().forEach(point => { band += ' L ' + x(point[0]) + ' ' + y(point[1]); });
  band += ' Z';
  body += '<path class="band" d="' + band + '"/>';
  body += line(left, y(50), right, y(50), 'ev');

  function cumulativePath(games) {
    let wins = 0;
    let pathData = 'M ' + x(0) + ' ' + y(0);
    games.forEach((game, index) => {
      if (game.player > game.cpu) wins++;
      pathData += ' H ' + x(index + 1) + ' V ' + y(wins);
    });
    return { pathData, wins };
  }
  const treatmentPath = cumulativePath(T);
  const controlPath = cumulativePath(C);

  body += '<path d="' + controlPath.pathData + '" fill="none" stroke="' + COL.muted + '" stroke-width="2" stroke-linejoin="round" opacity=".8"/>';
  body += '<path d="' + treatmentPath.pathData + '" fill="none" stroke="' + COL.gold + '" stroke-width="2.8" stroke-linejoin="round"/>';
  body += '<circle cx="' + x(N) + '" cy="' + y(treatmentPath.wins) + '" r="4.2" fill="' + COL.gold + '" stroke="' + COL.bg + '" stroke-width="2"/>';
  body += '<circle cx="' + x(N) + '" cy="' + y(controlPath.wins) + '" r="4.2" fill="' + COL.muted + '" stroke="' + COL.bg + '" stroke-width="2"/>';
  body += text(x(N) + 10, y(treatmentPath.wins) - 7, treatmentPath.wins + ' wins', 'num', 'start');
  body += text(x(N) + 10, y(controlPath.wins) + 15, controlPath.wins + ' wins', 'num-small', 'start');

  body += legend(588, 58, 'Match-W CPU', COL.gold);
  body += legend(724, 58, 'Exact-W control', COL.muted, true);
  body += rect(588, 80, 12, 9, COL.gold, 'opacity=".16"') + text(606, 88, 'fair-coin 95% band', 'small');

  body = footerLine(body, 494);
  body += text(56, 518, 'Player record vs Match-W CPU: 51–49 (51.0%). vs control: 50–50 (50.0%).', 'small');
  body += text(56, 536, 'Win-rate 95% CIs: 41.4–60.6% and 40.4–59.6%. The final records sit inside the fair-coin band, so neither establishes a real edge.', 'small');

  return chart(
    'Fifty-one wins is a coin flip',
    'Cumulative player wins over 100 seeded games. The shaded band is the pointwise 95% range of a fair coin.',
    body
  );
}

/* ------------------------------------------------------------------ */
/* Chart 2 — running mean score                                        */
/* ------------------------------------------------------------------ */

function runningMean(values) {
  let sum = 0;
  return values.map((value, index) => {
    sum += value;
    return sum / (index + 1);
  });
}

function runningChart() {
  const left = 80, right = 834, top = 145, bottom = 442;
  const plotW = right - left;
  const plotH = bottom - top;
  const yMin = 210, yMax = 285;
  const y = value => bottom - ((value - yMin) / (yMax - yMin)) * plotH;
  const x = game => left + ((game - 1) / (N - 1)) * plotW;

  const series = [
    { label: 'Match-W · player', color: COL.gold, values: runningMean(tPlayer), dashed: false },
    { label: 'Match-W · CPU', color: COL.mint, values: runningMean(tCpu), dashed: false },
    { label: 'Control · player', color: COL.goldBright, values: runningMean(cPlayer), dashed: true },
    { label: 'Control · CPU', color: '#b8d8c4', values: runningMean(cCpu), dashed: true }
  ];

  let body = '';
  for (let tick = 210; tick <= 285; tick += 15) {
    body += line(left, y(tick), right, y(tick), tick === 240 ? 'grid-strong' : 'grid');
    body += text(left - 14, y(tick) + 4, String(tick), 'axis', 'end');
  }
  body += text(28, top + plotH / 2, 'RUNNING MEAN', 'eyebrow', 'middle', 'transform="rotate(-90 28 ' + (top + plotH / 2) + ')"');
  [1, 20, 40, 60, 80, 100].forEach(game => {
    body += text(x(game), bottom + 22, String(game), 'axis', game === 1 ? 'start' : game === N ? 'end' : 'middle');
    body += line(x(game), bottom, x(game), bottom + 5, 'axis-line');
  });
  body += text((left + right) / 2, bottom + 44, 'GAME', 'eyebrow', 'middle');

  const evY = y(254.143784);
  body += line(left, evY, right, evY, 'ev');
  body += text(right - 4, evY - 8, 'exact EV 254.14', 'small', 'end');

  series.forEach(item => {
    const pathData = item.values.map((value, index) => (index === 0 ? 'M ' : 'L ') + x(index + 1) + ' ' + y(value)).join(' ');
    body += '<path d="' + pathData + '" fill="none" stroke="' + item.color + '" stroke-width="' +
      (item.dashed ? '1.8' : '2.8') + '" stroke-linejoin="round"' +
      (item.dashed ? ' stroke-dasharray="5 4" opacity=".75"' : '') + '/>';
    const last = item.values[N - 1];
    body += '<circle cx="' + x(N) + '" cy="' + y(last) + '" r="' + (item.dashed ? '3' : '4') + '" fill="' +
      item.color + '" stroke="' + COL.bg + '" stroke-width="2"/>';
  });

  body += legend(574, 58, 'Match-W · player', COL.gold);
  body += legend(712, 58, 'Match-W · CPU', COL.mint);
  body += legend(574, 80, 'Control · player', COL.goldBright, true);
  body += legend(712, 80, 'Control · CPU', '#b8d8c4', true);

  body = footerLine(body, 488);
  body += text(56, 512, 'Final means — Match-W: player 261.04, CPU 248.36. Control: player 253.18, CPU 261.77.', 'small');
  body += text(56, 530, 'The CPU’s average fell 13.41 points. Dice streams diverge once the CPU changes a round-12 hold, so the runs are not paired.', 'small');

  return chart(
    'The CPU’s average fell 13.4 points',
    'Running mean over 100 games. Solid lines are the Match-W endgame; dashed lines are the Exact-W control.',
    body
  );
}

/* ------------------------------------------------------------------ */
/* Chart 3 — final-score distributions                                 */
/* ------------------------------------------------------------------ */

function distributionChart() {
  const left = 70, right = 884, top = 145, bottom = 442;
  const binStart = 120, binSize = 20, binCount = 21;
  const plotW = right - left;
  const plotH = bottom - top;
  const yMax = 28;
  const y = value => bottom - (value / yMax) * plotH;
  const binWidth = plotW / binCount;
  const barWidth = 14;
  const countsPlayer = new Array(binCount).fill(0);
  const countsCpu = new Array(binCount).fill(0);
  tPlayer.forEach(value => {
    countsPlayer[Math.min(binCount - 1, Math.max(0, Math.floor((value - binStart) / binSize)))]++;
  });
  tCpu.forEach(value => {
    countsCpu[Math.min(binCount - 1, Math.max(0, Math.floor((value - binStart) / binSize)))]++;
  });

  let body = '';
  for (let tick = 0; tick <= 25; tick += 5) {
    body += line(left, y(tick), right, y(tick), tick === 0 ? 'axis-line' : 'grid');
    body += text(left - 14, y(tick) + 4, String(tick), 'axis', 'end');
  }
  body += text(28, top + plotH / 2, 'GAMES', 'eyebrow', 'middle', 'transform="rotate(-90 28 ' + (top + plotH / 2) + ')"');

  for (let bin = 0; bin < binCount; bin++) {
    const center = left + (bin + 0.5) * binWidth;
    const xPlayer = center - barWidth - 2;
    const xCpu = center + 2;
    const yPlayer = y(countsPlayer[bin]);
    const yCpu = y(countsCpu[bin]);
    const rangeLabel = (binStart + bin * binSize) + '–' + (binStart + (bin + 1) * binSize - 1);
    if (countsPlayer[bin] > 0) {
      body += '<rect x="' + xPlayer + '" y="' + yPlayer + '" width="' + barWidth + '" height="' + (bottom - yPlayer) + '" rx="2" fill="' + COL.gold + '" opacity=".9"><title>' + rangeLabel + ': ' + countsPlayer[bin] + ' player games</title></rect>';
      body += text(center - 9, yPlayer - 6, String(countsPlayer[bin]), 'num-small', 'middle');
    }
    if (countsCpu[bin] > 0) {
      body += '<rect x="' + xCpu + '" y="' + yCpu + '" width="' + barWidth + '" height="' + (bottom - yCpu) + '" rx="2" fill="' + COL.mint + '" opacity=".86"><title>' + rangeLabel + ': ' + countsCpu[bin] + ' CPU games</title></rect>';
      body += text(center + 9, yCpu - 6, String(countsCpu[bin]), 'num-small', 'middle');
    }
    if (bin % 2 === 0) {
      body += text(left + bin * binWidth, bottom + 22, String(binStart + bin * binSize), 'axis', 'middle');
    }
  }
  body += text(right, bottom + 22, String(binStart + binCount * binSize), 'axis', 'middle');
  body += text((left + right) / 2, bottom + 44, 'FINAL SCORE', 'eyebrow', 'middle');

  const evX = left + ((254.143784 - binStart) / (binCount * binSize)) * plotW;
  body += line(evX, top, evX, bottom, 'ev');
  body += text(evX + 8, top + 22, 'exact EV 254.1', 'small');

  body += legend(700, 58, 'Player', COL.gold);
  body += legend(774, 58, 'CPU', COL.mint);

  body = footerLine(body, 488);
  body += text(56, 512, 'Player: mean 261.04 · median 249.5 · SD 59.8 · range 170–539 · upper bonus 60/100.', 'small');
  body += text(56, 530, 'CPU: mean 248.36 · median 242 · SD 60.3 · range 120–448 · upper bonus 67/100.', 'small');

  return chart(
    'Same spread, 12.7 points apart',
    'Final scores over 100 games. Both histograms are wide and overlapping, with long right tails.',
    body
  );
}

/* ------------------------------------------------------------------ */
/* Chart 4 — margin distribution                                       */
/* ------------------------------------------------------------------ */

function marginChart() {
  const left = 76, right = 884, top = 148, bottom = 442;
  const binStart = -240, binSize = 40, binCount = 14;
  const plotW = right - left;
  const plotH = bottom - top;
  const yMax = 35;
  const y = value => bottom - (value / yMax) * plotH;
  const x = value => left + ((value - binStart) / (binCount * binSize)) * plotW;
  const counts = new Array(binCount).fill(0);
  tMargins.forEach(value => {
    counts[Math.min(binCount - 1, Math.max(0, Math.floor((value - binStart) / binSize)))]++;
  });

  let body = '';
  for (let tick = 0; tick <= 30; tick += 10) {
    body += line(left, y(tick), right, y(tick), tick === 0 ? 'axis-line' : 'grid');
    body += text(left - 14, y(tick) + 4, String(tick), 'axis', 'end');
  }
  body += text(28, top + plotH / 2, 'GAMES', 'eyebrow', 'middle', 'transform="rotate(-90 28 ' + (top + plotH / 2) + ')"');

  for (let bin = 0; bin < binCount; bin++) {
    if (counts[bin] === 0) continue;
    const start = binStart + bin * binSize;
    const barX = x(start) + 3;
    const barWidth = x(start + binSize) - x(start) - 6;
    const barY = y(counts[bin]);
    const color = start < 0 ? COL.coral : COL.gold;
    body += '<rect x="' + barX + '" y="' + barY + '" width="' + barWidth + '" height="' + (bottom - barY) + '" rx="2" fill="' + color + '" opacity=".88"><title>' + start + ' to ' + (start + binSize - 1) + ': ' + counts[bin] + ' games</title></rect>';
    body += text(barX + barWidth / 2, barY - 6, String(counts[bin]), 'num-small', 'middle');
  }

  const zeroX = x(0);
  body += line(zeroX, top, zeroX, bottom, 'grid-strong');
  body += text(zeroX, bottom + 22, '0', 'axis', 'middle');
  for (let value = binStart; value <= binStart + binCount * binSize; value += 80) {
    if (value === 0) continue;
    body += line(x(value), bottom, x(value), bottom + 5, 'axis-line');
    body += text(x(value), bottom + 22, String(value), 'axis', 'middle');
  }
  body += text((left + right) / 2, bottom + 44, 'MARGIN (PLAYER − CPU)', 'eyebrow', 'middle');

  const ciLow = tSummary.margin.ci95[0];
  const ciHigh = tSummary.margin.ci95[1];
  const ciY = 178;
  body += rect(x(ciLow), ciY - 7, Math.max(1, x(ciHigh) - x(ciLow)), 14, COL.gold, 'opacity=".18" rx="4"');
  body += line(x(ciLow), ciY, x(ciHigh), ciY, '', 'stroke="' + COL.gold + '" stroke-width="2"');
  body += line(x(ciLow), ciY - 5, x(ciLow), ciY + 5, '', 'stroke="' + COL.gold + '" stroke-width="2"');
  body += line(x(ciHigh), ciY - 5, x(ciHigh), ciY + 5, '', 'stroke="' + COL.gold + '" stroke-width="2"');
  body += text(x(ciHigh) + 10, ciY + 4, 'mean +12.7 · 95% CI ' + signed1(ciLow) + ' to ' + signed1(ciHigh), 'small');
  body += line(x(tSummary.margin.mean), top, x(tSummary.margin.mean), bottom, '', 'stroke="' + COL.gold + '" stroke-width="1.4" stroke-dasharray="4 4" opacity=".7"');

  body += legend(662, 58, 'Player win', COL.gold);
  body += legend(750, 58, 'Player loss', COL.coral);

  body = footerLine(body, 488);
  body += text(56, 512, 'Player record 51–49 · mean margin +12.68 · SD 78.45 · median +1 · range −231 to +271 · t 1.62.', 'small');
  body += text(56, 530, 'The 95% interval crosses zero, so the 100-game mean is not statistically distinguishable from no edge.', 'small');

  return chart(
    'The average edge is inside the noise',
    'Game margins over 100 matches. The 95% CI for the mean margin runs from −2.9 to +28.2 points.',
    body
  );
}

/* ------------------------------------------------------------------ */
/* Write                                                               */
/* ------------------------------------------------------------------ */

fs.mkdirSync(CHART_DIR, { recursive: true });
const outputs = [
  ['cpu-matchw-record-race.svg', recordChart()],
  ['cpu-matchw-running-average.svg', runningChart()],
  ['cpu-matchw-score-distribution.svg', distributionChart()],
  ['cpu-matchw-margin-distribution.svg', marginChart()]
];
outputs.forEach(([filename, contents]) => {
  fs.writeFileSync(path.join(CHART_DIR, filename), contents, 'utf8');
});

console.log('Wrote ' + outputs.length + ' charts to ' + CHART_DIR);
outputs.forEach(([filename]) => console.log('  ' + filename));
console.log('Match-W: ' + tSummary.record.wins + '-' + tSummary.record.losses + '-' + tSummary.record.ties +
  ', player ' + tSummary.player.mean + ', CPU ' + tSummary.cpu.mean);
console.log('Control: ' + cSummary.record.wins + '-' + cSummary.record.losses + '-' + cSummary.record.ties +
  ', player ' + cSummary.player.mean + ', CPU ' + cSummary.cpu.mean);
