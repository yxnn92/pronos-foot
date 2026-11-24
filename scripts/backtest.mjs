// Test du modèle sur les matchs passés (sans cotes) pour régler ses paramètres.
// Usage : node scripts/backtest.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LEAGUE_START, START_DEFAULT } from './config.mjs';
import { scoreMatrix, expScore } from './model.mjs';

const CACHE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'cache');
const SITE = 'https://site.api.espn.com/apis/site/v2/sports/soccer';
const files = fs.readdirSync(CACHE).filter((f) => /-2025\.json$/.test(f));
let ev = [];
for (const f of files) {
  const slug = f.replace(/-2025\.json$/, '');
  ev.push(...JSON.parse(fs.readFileSync(path.join(CACHE, f))).events.map((e) => ({ ...e, slug })));
}
// Année en cours
const slugs = [...new Set(files.map((f) => f.replace(/-2025\.json$/, '')))];
for (const s of slugs) {
  const j = await (await fetch(`${SITE}/${s}/scoreboard?dates=2026&limit=1000`)).json().catch(() => null);
  for (const e of j?.events || []) {
    const c = e.competitions[0], h = c.competitors.find((x) => x.homeAway === 'home'), a = c.competitors.find((x) => x.homeAway === 'away');
    if (e.status.type.completed) ev.push({ slug: s, date: e.date, neutral: c.neutralSite, h: { id: h.team.id }, a: { id: a.team.id }, hs: +h.score, as: +a.score, completed: true });
  }
}
ev = ev.filter((e) => e.completed && e.hs != null && !/fifa|nations|euro$|euroq/.test(e.slug)).sort((a, b) => a.date.localeCompare(b.date));
console.log('matchs', ev.length);

// table We → (pH, pD, pA) pré-calculée pour aller vite
const table = [];
for (let s = -3; s <= 3.001; s += 0.02) {
  const t = 2.7, m = scoreMatrix((t + s) / 2, (t - s) / 2);
  let h = 0, d = 0, a = 0; m.forEach((r, i) => r.forEach((p, j) => { if (i > j) h += p; else if (i === j) d += p; else a += p; }));
  table.push({ we: h + d / 2, h, d, a });
}
const probs = (we) => table.reduce((b, x) => (Math.abs(x.we - we) < Math.abs(b.we - we) ? x : b));

function run({ K, HA, KE, start }) {
  const elo = new Map(); const cnt = new Map();
  for (const r of ev) if (LEAGUE_START[r.slug]) for (const t of [r.h.id, r.a.id]) { const c = cnt.get(t) || {}; c[r.slug] = (c[r.slug] || 0) + 1; cnt.set(t, c); }
  const st = (t) => { const c = cnt.get(t); if (!c) return START_DEFAULT; const lg = Object.keys(c).reduce((x, y) => (c[y] > c[x] ? y : x)); return start(lg); };
  let ll = 0, n = 0, hit = 0;
  for (const r of ev) {
    for (const t of [r.h.id, r.a.id]) if (!elo.has(t)) elo.set(t, st(t));
    const we = expScore(elo.get(r.h.id) - elo.get(r.a.id) + (r.neutral ? 0 : HA));
    const res = r.hs > r.as ? 'h' : r.hs === r.as ? 'd' : 'a';
    if (r.date >= '2025-09-01' && (/^(eng|esp|ita|ger|fra)\.1$/.test(r.slug) || /^uefa\.(champions|europa|europa\.conf)$/.test(r.slug))) {
      const p = probs(we); ll += -Math.log(Math.max(p[res], 1e-6)); n++;
      if (['h', 'd', 'a'].reduce((x, y) => (p[y] > p[x] ? y : x)) === res) hit++;
    }
    const w = res === 'h' ? 1 : res === 'd' ? 0.5 : 0, gd = Math.abs(r.hs - r.as);
    const g = gd <= 1 ? 1 : gd === 2 ? 1.5 : (11 + gd) / 8;
    const k = K * (LEAGUE_START[r.slug] ? 1 : KE) * g * (w - we);
    elo.set(r.h.id, elo.get(r.h.id) + k); elo.set(r.a.id, elo.get(r.a.id) - k);
  }
  return { ll: (ll / n).toFixed(4), acc: (hit / n).toFixed(3), n };
}

const spread = (f) => (lg) => 1500 + (LEAGUE_START[lg] - 1500) * f;
for (const K of [10, 15, 20, 25]) for (const HA of [50, 70]) for (const KE of [1, 1.5, 2]) for (const f of [1, 1.3]) {
  console.log(`K=${K} HA=${HA} KE=${KE} ecart=${f}`, run({ K, HA, KE, start: spread(f) }));
}
