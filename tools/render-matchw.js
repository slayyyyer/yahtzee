'use strict';

/*
 * Build the Match-W charts from the recorded JSON.
 *
 *   node tools/render-matchw.js
 *
 * No dependencies. Node 18+ (or Bun) is enough.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const REPORTS = path.join(ROOT, 'reports');
const CHART_DIR = path.join(REPORTS, 'charts');

const eval50 = JSON.parse(fs.readFileSync(path.join(REPORTS, 'yahtzee-matchw-evaluation-50.json'), 'utf8'));
const pilot5 = JSON.parse(fs.readFileSync(path.join(REPORTS, 'yahtzee-matchw-evaluation-r11-pilot-5.json'), 'utf8'));
const control = JSON.parse(fs.readFileSync(path.join(REPORTS, 'yahtzee-matchw-control-100.json'), 'utf8'));
const hybrid = JSON.parse(fs.readFileSync(path.join(REPORTS, 'yahtzee-matchw-r12-100.json'), 'utf8'));

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

function t95(df) {
  const table = {
    4: 2.776, 23: 2.069, 24: 2.064, 49: 2.010, 99: 1.984
  };
  return table[df] || 1.96;
}

function pp(x) { return x * 100; }
function fmt(n, digits) { return Number(n).toFixed(digits); }

const round12 = eval50.summary.byRound[12];
const round13 = eval50.summary.byRound[13];
const pilot11 = pilot5.summary.byRound[11];

const bars = [
  {
    group: 'Round 11\npilot (n=5)',
    label: 'overall',
    value: pp(pilot11.diff.mean),
    half: t95(4) * pp(pilot11.diff.se),
    color: COL.goldBright,
    pilot: true
  },
  {
    group: 'Round 12\n(n=50)',
    label: 'behind',
    value: pp(round12.behind.mean),
    half: t95(24) * pp(round12.behind.se),
    color: COL.coral
  },
  {
    group: 'Round 12\n(n=50)',
    label: 'ahead',
    value: pp(round12.ahead.mean),
    half: t95(24) * pp(round12.ahead.se),
    color: COL.mint
  },
  {
    group: 'Round 12\n(n=50)',
    label: 'all',
    value: pp(round12.diff.mean),
    half: t95(49) * pp(round12.diff.se),
    color: COL.gold
  },
  {
    group: 'Round 13\n(n=50)',
    label: 'behind',
    value: pp(round13.behind.mean),
    half: t95(23) * pp(round13.behind.se),
    color: COL.coral
  },
  {
    group: 'Round 13\n(n=50)',
    label: 'ahead',
    value: pp(round13.ahead.mean),
    half: t95(24) * pp(round13.ahead.se),
    color: COL.mint
  },
  {
    group: 'Round 13\n(n=50)',
    label: 'all',
    value: pp(round13.diff.mean),
    half: t95(49) * pp(round13.diff.se),
    color: COL.gold
  }
];

const W = 920;
const H = 540;
const M = { left: 76, right: 36, top: 92, bottom: 104 };
const plotW = W - M.left - M.right;
const plotH = H - M.top - M.bottom;
const yMax = 2.7;
const y = v => M.top + plotH - (v / yMax) * plotH;
const x = i => M.left + (i + 0.5) * (plotW / bars.length);
const barW = 46;

let svg = '';
svg += `<?xml version="1.0" encoding="UTF-8"?>\n`;
svg += `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="title desc">\n`;
svg += `<title id="title">Match-W exact win-probability gain</title>\n`;
svg += `<desc id="desc">Bars show the exact gain in P(win) plus half P(tie) over the shipped Exact-W policy, in percentage points, with 95% confidence intervals.</desc>\n`;
svg += `<rect width="${W}" height="${H}" fill="${COL.bg}"/>\n`;
svg += `<rect x="0" y="0" width="${W}" height="${H}" fill="url(#felt)"/>\n`;
svg += `<defs><radialGradient id="felt" cx="50%" cy="18%" r="85%"><stop offset="0" stop-color="${COL.bg2}" stop-opacity="0"/><stop offset="1" stop-color="${COL.bg2}" stop-opacity="0.55"/></radialGradient></defs>\n`;

svg += `<text x="${M.left}" y="42" fill="${COL.cream}" font-family="Georgia, serif" font-size="25">Match-W: exact gain over Exact-W</text>\n`;
svg += `<text x="${M.left}" y="66" fill="${COL.muted}" font-family="ui-sans-serif, system-ui, sans-serif" font-size="13">P(win) + 0.5 × P(tie), percentage points. Error bars are 95% confidence intervals.</text>\n`;

for (let v = 0; v <= yMax; v += 0.5) {
  const yy = y(v);
  svg += `<line x1="${M.left}" y1="${yy}" x2="${W - M.right}" y2="${yy}" stroke="${v === 0 ? COL.lineStrong : COL.line}" stroke-width="1"/>\n`;
  svg += `<text x="${M.left - 12}" y="${yy + 4}" fill="${COL.muted2}" text-anchor="end" font-family="ui-monospace, monospace" font-size="11">${v.toFixed(1)}</text>\n`;
}
svg += `<text x="18" y="${M.top + plotH / 2}" fill="${COL.muted}" transform="rotate(-90 18 ${M.top + plotH / 2})" text-anchor="middle" font-family="ui-sans-serif, system-ui, sans-serif" font-size="12">percentage points</text>\n`;

bars.forEach((b, i) => {
  const bx = x(i) - barW / 2;
  const by = y(Math.max(0, b.value));
  const bh = Math.max(0, y(0) - by);
  svg += `<rect x="${bx}" y="${by}" width="${barW}" height="${bh}" rx="3" fill="${b.color}" opacity="${b.pilot ? 0.65 : 0.9}"/>\n`;
  const yy = y(b.value);
  svg += `<line x1="${x(i)}" y1="${y(Math.max(0, b.value - b.half))}" x2="${x(i)}" y2="${y(b.value + b.half)}" stroke="${COL.cream}" stroke-width="1.4"/>\n`;
  svg += `<line x1="${x(i) - 7}" y1="${y(b.value + b.half)}" x2="${x(i) + 7}" y2="${y(b.value + b.half)}" stroke="${COL.cream}" stroke-width="1.4"/>\n`;
  svg += `<line x1="${x(i) - 7}" y1="${y(Math.max(0, b.value - b.half))}" x2="${x(i) + 7}" y2="${y(Math.max(0, b.value - b.half))}" stroke="${COL.cream}" stroke-width="1.4"/>\n`;
  svg += `<text x="${x(i)}" y="${yy - 10}" fill="${COL.cream}" text-anchor="middle" font-family="ui-monospace, monospace" font-size="11">+${fmt(b.value, 2)}</text>\n`;
  svg += `<text x="${x(i)}" y="${H - M.bottom + 20}" fill="${COL.muted}" text-anchor="middle" font-family="ui-sans-serif, system-ui, sans-serif" font-size="10">${esc(b.label)}</text>\n`;
});

// Group labels
const groups = [
  { label: 'Round 11 pilot', from: 0, to: 1 },
  { label: 'Round 12', from: 1, to: 4 },
  { label: 'Round 13', from: 4, to: 7 }
];
groups.forEach(g => {
  const x1 = M.left + g.from * (plotW / bars.length);
  const x2 = M.left + g.to * (plotW / bars.length);
  svg += `<text x="${(x1 + x2) / 2}" y="${H - 36}" fill="${COL.cream}" text-anchor="middle" font-family="ui-sans-serif, system-ui, sans-serif" font-size="12" font-weight="600">${esc(g.label)}</text>\n`;
});

const legend = [
  { label: 'behind', color: COL.coral },
  { label: 'ahead', color: COL.mint },
  { label: 'all / overall', color: COL.gold }
];
legend.forEach((l, i) => {
  const lx = M.left + i * 160;
  const ly = H - 14;
  svg += `<rect x="${lx}" y="${ly - 8}" width="10" height="10" fill="${l.color}" rx="2"/>\n`;
  svg += `<text x="${lx + 16}" y="${ly}" fill="${COL.muted}" font-family="ui-sans-serif, system-ui, sans-serif" font-size="11">${esc(l.label)}</text>\n`;
});

svg += `</svg>\n`;
fs.mkdirSync(CHART_DIR, { recursive: true });
fs.writeFileSync(path.join(CHART_DIR, 'matchw-gain.svg'), svg, 'utf8');

/* ------------------------------------------------------------------ */
/* Score cost chart                                                    */
/* ------------------------------------------------------------------ */

const CS = 920;
const CH = 380;
const CM = { left: 190, right: 100, top: 86, bottom: 50 };
const cw = CS - CM.left - CM.right;
const scores = [
  { label: 'Exact-W control · player', value: control.summary.player.mean, color: COL.muted },
  { label: 'Match-W hybrid · player', value: hybrid.summary.player.mean, color: COL.gold },
  { label: 'Exact-W control · CPU', value: control.summary.cpu.mean, color: COL.muted2 },
  { label: 'Match-W hybrid · CPU', value: hybrid.summary.cpu.mean, color: COL.mint }
];
const min = 240;
const max = 270;
const sx = v => CM.left + ((v - min) / (max - min)) * cw;

let s2 = '';
s2 += `<?xml version="1.0" encoding="UTF-8"?>\n`;
s2 += `<svg xmlns="http://www.w3.org/2000/svg" width="${CS}" height="${CH}" viewBox="0 0 ${CS} ${CH}" role="img" aria-labelledby="title2 desc2">\n`;
s2 += `<title id="title2">Match-W score cost over 100 games</title>\n`;
s2 += `<desc id="desc2">Mean score for the Exact-W control and the Match-W hybrid in 100 seeded games. The hybrid player gives up about five points.</desc>\n`;
s2 += `<rect width="${CS}" height="${CH}" fill="${COL.bg}"/>\n`;
s2 += `<text x="${CM.left}" y="42" fill="${COL.cream}" font-family="Georgia, serif" font-size="24">The score cost of playing for the match</text>\n`;
s2 += `<text x="${CM.left}" y="66" fill="${COL.muted}" font-family="ui-sans-serif, system-ui, sans-serif" font-size="13">100 seeded games. Match-W switches at round 12; the CPU always uses Exact-W.</text>\n`;

for (let v = min; v <= max; v += 5) {
  const xx = sx(v);
  s2 += `<line x1="${xx}" y1="${CM.top - 10}" x2="${xx}" y2="${CH - CM.bottom}" stroke="${v === 250 ? COL.lineStrong : COL.line}" stroke-width="1"/>\n`;
  s2 += `<text x="${xx}" y="${CH - CM.bottom + 20}" fill="${COL.muted2}" text-anchor="middle" font-family="ui-monospace, monospace" font-size="10">${v}</text>\n`;
}

scores.forEach((s, i) => {
  const yy = CM.top + i * 58;
  s2 += `<text x="${CM.left - 14}" y="${yy + 16}" fill="${COL.cream}" text-anchor="end" font-family="ui-sans-serif, system-ui, sans-serif" font-size="12">${esc(s.label)}</text>\n`;
  s2 += `<rect x="${CM.left}" y="${yy}" width="${Math.max(2, sx(s.value) - CM.left)}" height="24" rx="4" fill="${s.color}" opacity="0.82"/>\n`;
  s2 += `<text x="${sx(s.value) + 10}" y="${yy + 17}" fill="${COL.cream}" font-family="ui-monospace, monospace" font-size="12">${fmt(s.value, 2)}</text>\n`;
});

s2 += `<text x="${CM.left}" y="${CH - 12}" fill="${COL.muted2}" font-family="ui-sans-serif, system-ui, sans-serif" font-size="11">Player −4.98 points; win rate 50.0% → 46.0% (the exact paired edge is +0.43 pp at round 12).</text>\n`;
s2 += `</svg>\n`;
fs.writeFileSync(path.join(CHART_DIR, 'matchw-score-cost.svg'), s2, 'utf8');

console.log('Wrote reports/charts/matchw-gain.svg and reports/charts/matchw-score-cost.svg');
