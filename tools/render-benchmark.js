'use strict';

/**
 * Build the 45-game benchmark report and SVG charts from the recorded arrays.
 *
 *   node tools/render-benchmark.js
 *
 * No dependencies. Node 18+ (or Bun) is enough.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const INPUT = path.join(ROOT, 'reports', 'yahtzee-benchmark-data-45.json');
const JSON_OUT = path.join(ROOT, 'reports', 'yahtzee-benchmark-2026-10-28.json');
const CHART_DIR = path.join(ROOT, 'reports', 'charts');
const TABLE_OUT = path.join(CHART_DIR, 'games-table.md');

const raw = JSON.parse(fs.readFileSync(INPUT, 'utf8'));
const P = raw.arrays.player.slice();
const C = raw.arrays.cpu.slice();
const PU = raw.arrays.playerUpper.slice();
const CU = raw.arrays.cpuUpper.slice();

if (P.length !== C.length || P.length !== PU.length || P.length !== CU.length) {
  throw new Error('Score arrays have different lengths.');
}
const N = P.length;
if (N !== 45) throw new Error('Expected 45 games, found ' + N + '.');

function sum(a) { return a.reduce((s, x) => s + x, 0); }
function mean(a) { return sum(a) / a.length; }
function sd(a) {
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) * (x - m), 0) / (a.length - 1));
}
function sorted(a) { return a.slice().sort((x, y) => x - y); }
function median(a) {
  const s = sorted(a);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function quantile(a, q) {
  const s = sorted(a);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

// 95% two-sided t critical value, df = 44.
const T95_44 = 2.015367574;
function stats(a, t) {
  const m = mean(a);
  const s = sd(a);
  const se = s / Math.sqrt(a.length);
  const half = (t || 1.96) * se;
  return {
    mean: +m.toFixed(4),
    sd: +s.toFixed(4),
    se: +se.toFixed(4),
    median: +median(a).toFixed(4),
    min: Math.min.apply(null, a),
    max: Math.max.apply(null, a),
    q1: +quantile(a, 0.25).toFixed(4),
    q3: +quantile(a, 0.75).toFixed(4),
    ci95: [+(m - half).toFixed(4), +(m + half).toFixed(4)]
  };
}

function recordOf(players, cpus) {
  const r = { wins: 0, losses: 0, ties: 0 };
  players.forEach((p, i) => {
    if (p > cpus[i]) r.wins++;
    else if (p < cpus[i]) r.losses++;
    else r.ties++;
  });
  return r;
}

const margins = P.map((p, i) => p - C[i]);
const record = recordOf(P, C);
if (record.wins !== 24 || record.losses !== 20 || record.ties !== 1) {
  throw new Error('Unexpected total record: ' + JSON.stringify(record));
}

const slices = [
  { label: raw.meta.sessions[0].label, from: 0, to: 5 },
  { label: raw.meta.sessions[1].label, from: 5, to: 25 },
  { label: raw.meta.sessions[2].label, from: 25, to: 45 }
];
const sessions = slices.map((s, i) => {
  const pp = P.slice(s.from, s.to);
  const cc = C.slice(s.from, s.to);
  const rr = recordOf(pp, cc);
  const expected = raw.meta.sessions[i].record;
  if (rr.wins !== expected.wins || rr.losses !== expected.losses || rr.ties !== expected.ties) {
    throw new Error('Session record mismatch for ' + s.label + ': ' + JSON.stringify(rr));
  }
  if (pp.length !== raw.meta.sessions[i].games) {
    throw new Error('Session game count mismatch for ' + s.label + '.');
  }
  return {
    label: s.label,
    games: pp.length,
    record: rr,
    playerMean: +mean(pp).toFixed(4),
    cpuMean: +mean(cc).toFixed(4),
    marginMean: +mean(pp.map((p, j) => p - cc[j])).toFixed(4)
  };
});

const playerStats = stats(P, T95_44);
const cpuStats = stats(C, T95_44);
const marginStats = stats(margins, T95_44);

function count(a, fn) { return a.filter(fn).length; }
const computedCounts = {
  player300: count(P, x => x >= 300),
  player350: count(P, x => x >= 350),
  player400: count(P, x => x >= 400),
  cpu300: count(C, x => x >= 300),
  cpu350: count(C, x => x >= 350),
  playerUnder200: count(P, x => x < 200),
  cpuUnder200: count(C, x => x < 200),
  margin50: count(margins, x => x >= 50),
  marginLoss50: count(margins, x => x <= -50)
};
Object.keys(computedCounts).forEach(k => {
  if (computedCounts[k] !== raw.counts[k]) {
    throw new Error('Count mismatch for ' + k + ': ' + computedCounts[k] + ' vs ' + raw.counts[k]);
  }
});

const catOrder = ['ones', 'twos', 'threes', 'fours', 'fives', 'sixes',
  'threeKind', 'fourKind', 'fullHouse', 'smallStraight', 'largeStraight', 'yahtzee', 'chance'];
const catLabels = {
  ones: 'Ones',
  twos: 'Twos',
  threes: 'Threes',
  fours: 'Fours',
  fives: 'Fives',
  sixes: 'Sixes',
  threeKind: 'Three of a kind',
  fourKind: 'Four of a kind',
  fullHouse: 'Full house',
  smallStraight: 'Small straight',
  largeStraight: 'Large straight',
  yahtzee: 'Yahtzee',
  chance: 'Chance'
};

const catPlayer = raw.categoryAverages.player;
const catCpu = raw.categoryAverages.cpu;
const upperPlayer = sum(catOrder.slice(0, 6).map(k => catPlayer[k]));
const upperCpu = sum(catOrder.slice(0, 6).map(k => catCpu[k]));
const lowerPlayer = sum(catOrder.slice(6).map(k => catPlayer[k]));
const lowerCpu = sum(catOrder.slice(6).map(k => catCpu[k]));
const boxPlayer = upperPlayer + lowerPlayer;
const boxCpu = upperCpu + lowerCpu;
const upperBonusPlayer = raw.bonusCounts.playerUpperBonus * 35 / N;
const upperBonusCpu = raw.bonusCounts.cpuUpperBonus * 35 / N;
const yahtzeeBonusPlayer = raw.bonusCounts.playerYahtzeeBonusPoints / N;
const yahtzeeBonusCpu = raw.bonusCounts.cpuYahtzeeBonusPoints / N;
const impliedPlayer = boxPlayer + upperBonusPlayer + yahtzeeBonusPlayer;
const impliedCpu = boxCpu + upperBonusCpu + yahtzeeBonusCpu;
if (Math.abs(impliedPlayer - playerStats.mean) > 0.01) {
  throw new Error('Player category averages do not add up: ' + impliedPlayer + ' vs ' + playerStats.mean);
}
if (Math.abs(impliedCpu - cpuStats.mean) > 0.01) {
  throw new Error('CPU category averages do not add up: ' + impliedCpu + ' vs ' + cpuStats.mean);
}

const summary = {
  n: N,
  record,
  browserRecord: { wins: record.wins, losses: record.losses + 1, ties: record.ties },
  winRate: +(100 * record.wins / N).toFixed(2),
  exactEV: 254.143784,
  player: playerStats,
  cpu: cpuStats,
  margin: Object.assign({}, marginStats, {
    t: +(marginStats.mean / marginStats.se).toFixed(3)
  }),
  sessions,
  boxes: {
    player: { upper: +upperPlayer.toFixed(3), lower: +lowerPlayer.toFixed(3), total: +boxPlayer.toFixed(3) },
    cpu: { upper: +upperCpu.toFixed(3), lower: +lowerCpu.toFixed(3), total: +boxCpu.toFixed(3) }
  },
  bonuses: {
    playerUpperBonusGames: raw.bonusCounts.playerUpperBonus,
    cpuUpperBonusGames: raw.bonusCounts.cpuUpperBonus,
    playerUpperBonusPointsPerGame: +upperBonusPlayer.toFixed(3),
    cpuUpperBonusPointsPerGame: +upperBonusCpu.toFixed(3),
    playerYahtzee50: raw.bonusCounts.playerYahtzee50,
    cpuYahtzee50: raw.bonusCounts.cpuYahtzee50,
    playerYahtzeeBonusPoints: raw.bonusCounts.playerYahtzeeBonusPoints,
    cpuYahtzeeBonusPoints: raw.bonusCounts.cpuYahtzeeBonusPoints,
    playerYahtzeeBonusPerGame: +yahtzeeBonusPlayer.toFixed(3),
    cpuYahtzeeBonusPerGame: +yahtzeeBonusCpu.toFixed(3)
  },
  counts: raw.counts,
  categoryAverages: raw.categoryAverages,
  categoryDifferences: Object.fromEntries(catOrder.map(k => [k, +(catPlayer[k] - catCpu[k]).toFixed(3)]))
};

const games = P.map((p, i) => ({
  id: i + 1,
  player: p,
  cpu: C[i],
  margin: p - C[i],
  result: p > C[i] ? 'win' : p < C[i] ? 'loss' : 'tie',
  playerUpper: PU[i],
  cpuUpper: CU[i]
}));

const report = {
  meta: Object.assign({}, raw.meta, {
    benchmarkRecord: record,
    allTimeRecord: { wins: record.wins, losses: record.losses + 1, ties: record.ties },
    sample: N + ' complete 13-round games on the deployed GitHub Pages build.'
  }),
  summary,
  games,
  arrays: raw.arrays,
  categoryAverages: raw.categoryAverages,
  progressionMean: raw.progressionMean,
  progressionSd: raw.progressionSd
};

fs.mkdirSync(CHART_DIR, { recursive: true });
fs.writeFileSync(JSON_OUT, JSON.stringify(report, null, 2) + '\n', 'utf8');

/* ------------------------------------------------------------------ */
/* SVG helpers                                                         */
/* ------------------------------------------------------------------ */

const COL = {
  bg: '#10251d',
  bg2: '#0a1712',
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

function esc(s) {
  return String(s).replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));
}
function fmt1(n) { return Number(n).toFixed(1); }
function fmt0(n) { return String(Math.round(n)); }
function signed1(n) {
  const v = Number(n);
  return (v > 0 ? '+' : '') + v.toFixed(1);
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
function chart(title, subtitle, body, wide) {
  const W = wide || 960;
  const H = 560;
  return '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-labelledby="chart-title chart-desc">\n' +
    '<title id="chart-title">' + esc(title) + '</title>\n' +
    '<desc id="chart-desc">' + esc(subtitle) + '</desc>\n' +
    '<defs>\n' +
    '<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#132a20"/><stop offset=".55" stop-color="#10251d"/><stop offset="1" stop-color="#0a1712"/></linearGradient>\n' +
    '<radialGradient id="glow" cx="72%" cy="-8%" r="72%"><stop offset="0" stop-color="#d9b567" stop-opacity=".18"/><stop offset="1" stop-color="#d9b567" stop-opacity="0"/></radialGradient>\n' +
    '<clipPath id="plotClip"><rect x="70" y="130" width="820" height="340"/></clipPath>\n' +
    '<style>\n' +
    '.title{font-family:Georgia,"Times New Roman",serif;font-size:28px;font-weight:600;fill:#f5eeda;letter-spacing:.2px}\n' +
    '.sub{font-family:"Segoe UI",Arial,sans-serif;font-size:13px;fill:#a4b3a8}\n' +
    '.eyebrow{font-family:"Segoe UI",Arial,sans-serif;font-size:10px;font-weight:700;letter-spacing:2.2px;fill:#d9b567}\n' +
    '.axis{font-family:"Segoe UI",Arial,sans-serif;font-size:11px;fill:#7f9187}\n' +
    '.axis-strong{font-family:"Segoe UI",Arial,sans-serif;font-size:11px;fill:#a4b3a8}\n' +
    '.label{font-family:"Segoe UI",Arial,sans-serif;font-size:12px;fill:#f5eeda}\n' +
    '.small{font-family:"Segoe UI",Arial,sans-serif;font-size:10px;fill:#a4b3a8}\n' +
    '.tiny{font-family:"Segoe UI",Arial,sans-serif;font-size:9px;fill:#7f9187}\n' +
    '.num{font-family:Consolas,"Cascadia Mono",monospace;font-size:12px;fill:#f5eeda}\n' +
    '.num-small{font-family:Consolas,"Cascadia Mono",monospace;font-size:10px;fill:#a4b3a8}\n' +
    '.gold{fill:#d9b567}.mint{fill:#8ec9a6}.coral{fill:#dd7b5d}.cream{fill:#f5eeda}.muted{fill:#7f9187}\n' +
    '.grid{stroke:#f5eeda;stroke-opacity:.08;stroke-width:1}\n' +
    '.grid-strong{stroke:#f5eeda;stroke-opacity:.16;stroke-width:1}\n' +
    '.axis-line{stroke:#f5eeda;stroke-opacity:.25;stroke-width:1}\n' +
    '.ev{stroke:#f5eeda;stroke-opacity:.55;stroke-width:1.2;stroke-dasharray:4 4}\n' +
    '.band{fill:#d9b567;fill-opacity:.10}\n' +
    '.bar-player{fill:#d9b567}.bar-cpu{fill:#8ec9a6}\n' +
    '</style>\n' +
    '</defs>\n' +
    '<rect width="' + W + '" height="' + H + '" fill="url(#bg)"/>\n' +
    '<rect width="' + W + '" height="' + H + '" fill="url(#glow)"/>\n' +
    '<rect x="0" y="0" width="' + W + '" height="4" fill="#d9b567"/>\n' +
    '<text x="56" y="47" class="eyebrow">YAHTZEE · EXACT-AI BENCHMARK</text>\n' +
    text(56, 82, title, 'title') + '\n' +
    text(56, 107, subtitle, 'sub') + '\n' +
    body + '\n' +
    text(904, 47, 'de6cf68 · 45 games', 'tiny', 'end') + '\n' +
    '</svg>\n';
}

function legend(x, y, label, color) {
  return '<rect x="' + x + '" y="' + (y - 8) + '" width="10" height="10" rx="2" fill="' + color + '"/>' +
    text(x + 16, y, label, 'small');
}

/* ------------------------------------------------------------------ */
/* Chart 1 — score distribution                                        */
/* ------------------------------------------------------------------ */

function distributionChart() {
  const left = 70, right = 890, top = 130, bottom = 450;
  const binStart = 140, binSize = 20, binCount = 14;
  const plotW = right - left;
  const plotH = bottom - top;
  const maxY = 14;
  const countsP = new Array(binCount).fill(0);
  const countsC = new Array(binCount).fill(0);
  P.forEach(v => { countsP[Math.min(binCount - 1, Math.max(0, Math.floor((v - binStart) / binSize)))]++; });
  C.forEach(v => { countsC[Math.min(binCount - 1, Math.max(0, Math.floor((v - binStart) / binSize)))]++; });
  const y = v => bottom - (v / maxY) * plotH;
  const binW = plotW / binCount;
  const barW = 17;
  let body = '';
  body += '<g>';
  for (let t = 0; t <= maxY; t += 2) {
    body += line(left, y(t), right, y(t), t === 0 ? 'axis-line' : 'grid');
    body += text(left - 12, y(t) + 4, String(t), 'axis', 'end');
  }
  body += text(28, top + plotH / 2, 'GAMES', 'eyebrow', 'middle', 'transform="rotate(-90 28 ' + (top + plotH / 2) + ')"');
  body += '</g>';

  for (let i = 0; i < binCount; i++) {
    const center = left + (i + 0.5) * binW;
    const xP = center - barW - 2;
    const xC = center + 2;
    const yP = y(countsP[i]);
    const yC = y(countsC[i]);
    if (countsP[i] > 0) {
      body += '<rect class="bar-player" x="' + xP + '" y="' + yP + '" width="' + barW + '" height="' + (bottom - yP) + '" rx="2" opacity=".92"><title>' + (binStart + i * binSize) + '–' + (binStart + (i + 1) * binSize - 1) + ': ' + countsP[i] + ' games</title></rect>';
      body += text(center - 10, yP - 6, String(countsP[i]), 'num-small', 'middle');
    }
    if (countsC[i] > 0) {
      body += '<rect class="bar-cpu" x="' + xC + '" y="' + yC + '" width="' + barW + '" height="' + (bottom - yC) + '" rx="2" opacity=".88"><title>' + (binStart + i * binSize) + '–' + (binStart + (i + 1) * binSize - 1) + ': ' + countsC[i] + ' games</title></rect>';
      body += text(center + 10, yC - 6, String(countsC[i]), 'num-small', 'middle');
    }
    if (i % 2 === 0 || i === binCount - 1) {
      body += text(center, bottom + 22, String(binStart + i * binSize), 'axis', 'middle');
    }
  }
  const evX = left + ((254.143784 - binStart) / (binCount * binSize)) * plotW;
  body += line(evX, top, evX, bottom, 'ev');
  body += text(evX + 8, top + 34, 'exact EV 254.1', 'small', 'start');

  body += legend(620, 58, 'You', COL.gold);
  body += legend(690, 58, 'CPU', COL.mint);
  body += '<rect x="56" y="490" width="848" height="1" fill="' + COL.line + '"/>';
  body += text(56, 514, 'You: mean ' + fmt1(playerStats.mean) + ' · median ' + fmt0(playerStats.median) + ' · SD ' + fmt1(playerStats.sd) + ' · range ' + playerStats.min + '–' + playerStats.max, 'small');
  body += text(56, 534, 'CPU: mean ' + fmt1(cpuStats.mean) + ' · median ' + fmt0(cpuStats.median) + ' · SD ' + fmt1(cpuStats.sd) + ' · range ' + cpuStats.min + '–' + cpuStats.max, 'small');

  return chart(
    'Final scores: 45 games',
    'Most games land in the 220–280 band; the long right tail belongs to Yahtzee-bonus games.',
    body
  );
}

/* ------------------------------------------------------------------ */
/* Chart 2 — running average                                           */
/* ------------------------------------------------------------------ */

function runningChart() {
  const left = 78, right = 842, top = 130, bottom = 450;
  const plotW = right - left;
  const plotH = bottom - top;
  const yMin = 190, yMax = 310;
  const y = v => bottom - ((v - yMin) / (yMax - yMin)) * plotH;
  const x = n => left + ((n - 1) / (N - 1)) * plotW;

  function running(a) {
    const out = [];
    for (let i = 1; i <= a.length; i++) out.push(mean(a.slice(0, i)));
    return out;
  }
  const rp = running(P);
  const rc = running(C);
  const upper = [];
  const lower = [];
  for (let i = 2; i <= N; i++) {
    const m = rp[i - 1];
    const s = sd(P.slice(0, i));
    const half = 1.96 * s / Math.sqrt(i);
    upper.push([i, m + half]);
    lower.push([i, m - half]);
  }

  let body = '';
  for (let t = 200; t <= 300; t += 20) {
    body += line(left, y(t), right, y(t), t === 240 ? 'grid-strong' : 'grid');
    body += text(left - 12, y(t) + 4, String(t), 'axis', 'end');
  }
  body += text(28, top + plotH / 2, 'MEAN SCORE', 'eyebrow', 'middle', 'transform="rotate(-90 28 ' + (top + plotH / 2) + ')"');
  [1, 5, 10, 15, 20, 25, 30, 35, 40, 45].forEach(function (n) {
    body += text(x(n), bottom + 22, String(n), 'axis', 'middle');
    body += line(x(n), bottom, x(n), bottom + 5, 'axis-line');
  });

  let band = 'M ' + x(upper[0][0]) + ' ' + y(upper[0][1]);
  upper.slice(1).forEach(pt => { band += ' L ' + x(pt[0]) + ' ' + y(pt[1]); });
  lower.slice().reverse().forEach(pt => { band += ' L ' + x(pt[0]) + ' ' + y(pt[1]); });
  band += ' Z';

  body += '<g clip-path="url(#plotClip)"><path class="band" d="' + band + '"/></g>';

  const evY = y(254.143784);
  body += line(left, evY, right, evY, 'ev');
  body += text(right - 4, evY - 8, 'exact EV 254.14', 'small', 'end');

  function pathFor(arr) {
    return arr.map((v, i) => (i === 0 ? 'M ' : 'L ') + x(i + 1) + ' ' + y(v)).join(' ');
  }
  body += '<g clip-path="url(#plotClip)">';
  body += '<path d="' + pathFor(rp) + '" fill="none" stroke="' + COL.gold + '" stroke-width="2.6" stroke-linejoin="round"/>';
  body += '<path d="' + pathFor(rc) + '" fill="none" stroke="' + COL.mint + '" stroke-width="2.6" stroke-linejoin="round"/>';
  body += '</g>';

  [5, 25, 45].forEach(n => {
    body += '<circle cx="' + x(n) + '" cy="' + y(rp[n - 1]) + '" r="3.6" fill="' + COL.gold + '" stroke="' + COL.bg + '" stroke-width="2"/>';
    body += '<circle cx="' + x(n) + '" cy="' + y(rc[n - 1]) + '" r="3.6" fill="' + COL.mint + '" stroke="' + COL.bg + '" stroke-width="2"/>';
  });

  body += text(x(N) + 14, y(rp[N - 1]) + 4, fmt1(rp[N - 1]), 'num', 'start');
  body += text(x(N) + 14, y(rc[N - 1]) + 4, fmt1(rc[N - 1]), 'num', 'start');
  body += legend(628, 58, 'You', COL.gold);
  body += legend(698, 58, 'CPU', COL.mint);
  body += '<rect x="780" y="50" width="12" height="9" fill="' + COL.gold + '" opacity=".16"/>' + text(798, 58, '95% band (you)', 'small');

  body += '<rect x="56" y="492" width="848" height="1" fill="' + COL.line + '"/>';
  body += text(56, 516, 'After 5: You 270.2 · CPU 251.6', 'small');
  body += text(340, 516, 'After 25: You 259.4 · CPU 242.7', 'small');
  body += text(650, 516, 'After 45: You 256.6 · CPU 240.8', 'small');
  body += text(56, 534, 'The band is the 95% confidence interval of the running mean. The final mean is 2.4 points above the exact value.', 'small');

  return chart(
    'The long run converges on 254',
    'Early 5- and 25-game averages ran hot; the 45-game mean sits close to the table value.',
    body
  );
}

/* ------------------------------------------------------------------ */
/* Chart 3 — cumulative record                                         */
/* ------------------------------------------------------------------ */

function recordChart() {
  const left = 70, right = 860, top = 130, bottom = 450;
  const plotW = right - left;
  const plotH = bottom - top;
  const yMax = 25;
  const y = v => bottom - (v / yMax) * plotH;
  const x = n => left + (n / N) * plotW;

  let body = '';
  for (let t = 0; t <= yMax; t += 5) {
    body += line(left, y(t), right, y(t), t === 0 ? 'axis-line' : 'grid');
    body += text(left - 12, y(t) + 4, String(t), 'axis', 'end');
  }
  body += text(28, top + plotH / 2, 'GAMES', 'eyebrow', 'middle', 'transform="rotate(-90 28 ' + (top + plotH / 2) + ')"');
  for (let n = 0; n <= N; n += 5) {
    body += text(x(n), bottom + 22, String(n), 'axis', 'middle');
    if (n > 0) body += line(x(n), bottom, x(n), bottom + 5, 'axis-line');
  }
  let wins = 0, losses = 0;
  let tieWins = 0, tieLosses = 0;
  let pathW = 'M ' + x(0) + ' ' + y(0);
  let pathL = 'M ' + x(0) + ' ' + y(0);
  for (let i = 0; i < N; i++) {
    if (P[i] > C[i]) wins++;
    else if (P[i] < C[i]) losses++;
    else { tieWins = wins; tieLosses = losses; }
    pathW += ' H ' + x(i + 1) + ' V ' + y(wins);
    pathL += ' H ' + x(i + 1) + ' V ' + y(losses);
  }
  body += '<path d="' + pathW + '" fill="none" stroke="' + COL.gold + '" stroke-width="2.8" stroke-linejoin="round"/>';
  body += '<path d="' + pathL + '" fill="none" stroke="' + COL.coral + '" stroke-width="2.8" stroke-linejoin="round"/>';

  const tieIndex = P.findIndex((p, i) => p === C[i]);
  if (tieIndex >= 0) {
    body += '<circle cx="' + x(tieIndex + 1) + '" cy="' + y(tieLosses) + '" r="4" fill="' + COL.cream + '" stroke="' + COL.bg + '" stroke-width="2"><title>Tie: ' + P[tieIndex] + '–' + C[tieIndex] + '</title></circle>';
    body += text(x(tieIndex + 1) - 8, y(tieLosses) - 8, 'tie ' + P[tieIndex] + '–' + C[tieIndex], 'tiny', 'end');
  }

  body += text(x(N) + 10, y(wins) + 4, String(wins), 'num', 'start');
  body += text(x(N) + 10, y(losses) + 4, String(losses), 'num', 'start');
  body += legend(662, 58, 'Wins', COL.gold);
  body += legend(728, 58, 'Losses', COL.coral);

  const mid = slices[1];
  const midRecord = recordOf(P.slice(0, mid.to), C.slice(0, mid.to));
  const markerX = x(mid.to);
  body += line(markerX, top, markerX, bottom, 'ev');
  body += text(markerX - 8, top + 18, 'game 25: ' + midRecord.wins + '–' + midRecord.losses + '–' + midRecord.ties, 'small', 'end');

  body += '<rect x="56" y="492" width="848" height="1" fill="' + COL.line + '"/>';
  body += text(56, 516, 'Final: 24–20–1 across the 45 benchmark games. The browser all-time record is 24–21–1.', 'small');
  body += text(56, 534, 'The one tie was game 15: 245–245. Wins and losses are cumulative; a tie moves neither line.', 'small');

  return chart(
    'The record was a coin flip',
    'A 14–6 finish turned a 10–14–1 start into 24–20–1; both players use the same solver.',
    body
  );
}

/* ------------------------------------------------------------------ */
/* Chart 4 — category averages                                         */
/* ------------------------------------------------------------------ */

function categoryChart() {
  const left = 190, right = 748, top = 140;
  const rowH = 25;
  const gap = 20;
  const xMax = 40;
  const x = v => left + (v / xMax) * (right - left);

  let body = '';
  for (let t = 0; t <= xMax; t += 10) {
    body += line(x(t), top - 18, x(t), 480, t === 0 ? 'axis-line' : 'grid');
    body += text(x(t), 482, String(t), 'axis', 'middle');
  }
  body += text(820, 104, 'YOU − CPU', 'eyebrow', 'middle');

  const upperCats = catOrder.slice(0, 6);
  const lowerCats = catOrder.slice(6);
  let row = 0;

  body += text(left - 20, top - 22, 'UPPER SECTION', 'eyebrow', 'end');
  upperCats.forEach(k => {
    const yy = top + row * rowH;
    body += text(left - 20, yy + 9, catLabels[k], 'label', 'end');
    const pv = catPlayer[k], cv = catCpu[k];
    body += '<rect class="bar-player" x="' + x(0) + '" y="' + (yy - 8) + '" width="' + Math.max(0.5, x(pv) - x(0)) + '" height="8" rx="2"/>';
    body += '<rect class="bar-cpu" x="' + x(0) + '" y="' + (yy + 2) + '" width="' + Math.max(0.5, x(cv) - x(0)) + '" height="8" rx="2"/>';
    body += text(x(pv) + 6, yy - 2, fmt1(pv), 'num-small');
    body += text(x(cv) + 6, yy + 13, fmt1(cv), 'num-small');
    const d = pv - cv;
    body += text(820, yy + 8, signed1(d), 'num', 'middle', 'fill="' + (d > 0.05 ? COL.gold : d < -0.05 ? COL.coral : COL.muted) + '"');
    row++;
  });

  const lowerTop = top + row * rowH + gap;
  body += text(left - 20, lowerTop - 22, 'LOWER SECTION', 'eyebrow', 'end');
  lowerCats.forEach(k => {
    const yy = lowerTop + (row - 6) * rowH;
    body += text(left - 20, yy + 9, catLabels[k], 'label', 'end');
    const pv = catPlayer[k], cv = catCpu[k];
    body += '<rect class="bar-player" x="' + x(0) + '" y="' + (yy - 8) + '" width="' + Math.max(0.5, x(pv) - x(0)) + '" height="8" rx="2"/>';
    body += '<rect class="bar-cpu" x="' + x(0) + '" y="' + (yy + 2) + '" width="' + Math.max(0.5, x(cv) - x(0)) + '" height="8" rx="2"/>';
    body += text(x(pv) + 6, yy - 2, fmt1(pv), 'num-small');
    body += text(x(cv) + 6, yy + 13, fmt1(cv), 'num-small');
    const d = pv - cv;
    body += text(820, yy + 8, signed1(d), 'num', 'middle', 'fill="' + (d > 0.05 ? COL.gold : d < -0.05 ? COL.coral : COL.muted) + '"');
    row++;
  });

  body += legend(548, 58, 'You', COL.gold);
  body += legend(618, 58, 'CPU', COL.mint);

  body += '<rect x="56" y="498" width="848" height="1" fill="' + COL.line + '"/>';
  body += text(56, 518, 'Box averages: You ' + fmt1(boxPlayer) + ' · CPU ' + fmt1(boxCpu) + ' (difference ' + signed1(boxPlayer - boxCpu) + ').', 'small');
  body += text(56, 536, 'Upper bonus: ' + raw.bonusCounts.playerUpperBonus + '/45 vs ' + raw.bonusCounts.cpuUpperBonus + '/45 · Yahtzee bonus: +' + raw.bonusCounts.playerYahtzeeBonusPoints + ' vs +' + raw.bonusCounts.cpuYahtzeeBonusPoints + '.', 'small');

  return chart(
    'Where the points came from',
    'Four of a kind and the Yahtzee box supplied most of the scoring gap; small straight slightly favoured the CPU.',
    body
  );
}

/* ------------------------------------------------------------------ */
/* Games table                                                         */
/* ------------------------------------------------------------------ */

function gamesTable() {
  const lines = [
    '| # | You | CPU | Result | Margin | Upper (you / CPU) |',
    '|---:|---:|---:|:---:|---:|---:|'
  ];
  games.forEach(g => {
    const result = g.result === 'win' ? 'Win' : g.result === 'loss' ? 'Loss' : 'Tie';
    lines.push('| ' + g.id + ' | ' + g.player + ' | ' + g.cpu + ' | ' + result + ' | ' + (g.margin > 0 ? '+' : '') + g.margin + ' | ' + g.playerUpper + ' / ' + g.cpuUpper + ' |');
  });
  return lines.join('\n') + '\n';
}

/* ------------------------------------------------------------------ */
/* Write                                                               */
/* ------------------------------------------------------------------ */

fs.writeFileSync(path.join(CHART_DIR, 'score-distribution.svg'), distributionChart(), 'utf8');
fs.writeFileSync(path.join(CHART_DIR, 'running-average.svg'), runningChart(), 'utf8');
fs.writeFileSync(path.join(CHART_DIR, 'record-race.svg'), recordChart(), 'utf8');
fs.writeFileSync(path.join(CHART_DIR, 'category-averages.svg'), categoryChart(), 'utf8');
fs.writeFileSync(TABLE_OUT, gamesTable(), 'utf8');

console.log('Wrote ' + JSON_OUT);
console.log('Wrote 4 charts and games-table.md in ' + CHART_DIR);
console.log('Record: ' + record.wins + '-' + record.losses + '-' + record.ties);
console.log('Means: player ' + playerStats.mean + ', CPU ' + cpuStats.mean + ', margin ' + marginStats.mean);
