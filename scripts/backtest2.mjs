// Test des améliorations du modèle sur les matchs passés : fatigue, terrain par équipe, forme, buts.
// Usage : node scripts/backtest2.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LEAGUE_START, START_DEFAULT } from './config.mjs';
import { scoreMatrix, expScore } from './model.mjs';

const CACHE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'cache');
const SITE = 'https://site.api.espn.com/apis/site/v2/sports/soccer';
const files = fs.readdirSync(CACHE).filter((f) => /-2025\.json$/.test(f));
let ev = [];
for (const f of files) ev.push(...JSON.parse(fs.readFileSync(path.join(CACHE, f))).events.map((e) => ({ ...e, slug: f.replace(/-2025\.json$/, '') })));
const slugs = [...new Set(files.map((f) => f.replace(/-2025\.json$/, '')))];
await Promise.all(slugs.map(async (s) => {
  const j = await (await fetch(`${SITE}/${s}/scoreboard?dates=2026&limit=1000`)).json().catch(() => null);
  for (const e of j?.events || []) {
    const c = e.competitions[0], h = c.competitors.find((x) => x.homeAway === 'home'), a = c.competitors.find((x) => x.homeAway === 'away');
    if (e.status.type.completed) ev.push({ slug: s, date: e.date, neutral: c.neutralSite, h: { id: h.team.id }, a: { id: a.team.id }, hs: +h.score, as: +a.score, completed: true });
  }
}));
ev = ev.filter((e) => e.completed && e.hs != null && !/fifa|nations|euro$|euroq/.test(e.slug)).sort((a, b) => a.date.localeCompare(b.date));
const isEval = (r) => r.date >= '2025-09-01' && (/^(eng|esp|ita|ger|fra)\.1$/.test(r.slug) || /^uefa\.(champions|europa|europa\.conf)$/.test(r.slug));

// Table écart de buts → probabilités (total fixé), pour aller vite
const tables = new Map();
function probsFor(we, total) {
  const T = Math.round(total * 10) / 10;
  if (!tables.has(T)) {
    const t = [];
    for (let s = -3; s <= 3.001; s += 0.02) { const m = scoreMatrix(Math.max(0.05, (T + s) / 2), Math.max(0.05, (T - s) / 2)); let h = 0, d = 0, a = 0, o25 = 0; m.forEach((r, i) => r.forEach((p, j) => { if (i > j) h += p; else if (i === j) d += p; else a += p; if (i + j > 2.5) o25 += p; })); t.push({ we: h + d / 2, h, d, a, o25 }); }
    tables.set(T, t);
  }
  return tables.get(T).reduce((b, x) => (Math.abs(x.we - we) < Math.abs(b.we - we) ? x : b));
}

function run(P) {
  const elo = new Map(), cnt = new Map(), last = new Map(), homeRes = new Map(), formR = new Map(), gf = new Map();
  for (const r of ev) if (LEAGUE_START[r.slug]) for (const t of [r.h.id, r.a.id]) { const c = cnt.get(t) || {}; c[r.slug] = (c[r.slug] || 0) + 1; cnt.set(t, c); }
  const st = (t) => { const c = cnt.get(t); if (!c) return START_DEFAULT; const lg = Object.keys(c).reduce((x, y) => (c[y] > c[x] ? y : x)); return LEAGUE_START[lg]; };
  let ll = 0, n = 0, hit = 0, llG = 0;
  for (const r of ev) {
    for (const t of [r.h.id, r.a.id]) if (!elo.has(t)) elo.set(t, st(t));
    const t0 = Date.parse(r.date);
    const rest = (t) => (last.has(t) ? (t0 - last.get(t)) / 864e5 : 7);
    const fat = (t) => (rest(t) < P.restDays ? P.restPen : 0);
    const hr = homeRes.get(r.h.id) || { s: 0, n: 0 };
    const teamHA = r.neutral ? 0 : P.HA + (P.teamHA ? P.teamHA * (hr.s / (hr.n + 10)) : 0);
    const fh = (formR.get(r.h.id) || 0) * P.form, fa = (formR.get(r.a.id) || 0) * P.form;
    const dr = elo.get(r.h.id) - elo.get(r.a.id) + teamHA - fat(r.h.id) + fat(r.a.id) + fh - fa;
    const we = expScore(dr);
    // total de buts : attaque/défense pondérées
    const G = (t) => gf.get(t) || { f: 0, a: 0, n: 0 };
    const gh = G(r.h.id), ga = G(r.a.id);
    const att = (g) => (g.n < 0.5 ? 1 : 1 + (g.n / (g.n + P.gShrink)) * (g.f / g.n / 1.35 - 1));
    const def = (g) => (g.n < 0.5 ? 1 : 1 + (g.n / (g.n + P.gShrink)) * (g.a / g.n / 1.35 - 1));
    const total = Math.min(4.2, Math.max(1.7, 1.35 * (att(gh) * def(ga) + att(ga) * def(gh)) * P.gScale));
    const res = r.hs > r.as ? 'h' : r.hs === r.as ? 'd' : 'a';
    if (isEval(r)) {
      const p = probsFor(we, P.useTotal ? total : 2.7);
      ll += -Math.log(Math.max(p[res], 1e-6)); n++;
      if (['h', 'd', 'a'].reduce((x, y) => (p[y] > p[x] ? y : x)) === res) hit++;
      const over = r.hs + r.as > 2.5; llG += -Math.log(Math.max(over ? p.o25 : 1 - p.o25, 1e-6));
    }
    const w = res === 'h' ? 1 : res === 'd' ? 0.5 : 0, gd = Math.abs(r.hs - r.as);
    const g = gd <= 1 ? 1 : gd === 2 ? 1.5 : (11 + gd) / 8;
    const k = P.K * (LEAGUE_START[r.slug] ? 1 : P.KE) * g * (w - we);
    elo.set(r.h.id, elo.get(r.h.id) + k); elo.set(r.a.id, elo.get(r.a.id) - k);
    if (!r.neutral) { hr.s += (w - we); hr.n++; homeRes.set(r.h.id, hr); const ar = homeRes.get(r.a.id) || { s: 0, n: 0 }; ar.s += 0; homeRes.set(r.a.id, ar); }
    formR.set(r.h.id, (formR.get(r.h.id) || 0) * P.formDecay + (w - we));
    formR.set(r.a.id, (formR.get(r.a.id) || 0) * P.formDecay - (w - we));
    for (const [t, f, a] of [[r.h.id, r.hs, r.as], [r.a.id, r.as, r.hs]]) { const x = G(t); gf.set(t, { f: x.f * P.gDecay + f, a: x.a * P.gDecay + a, n: x.n * P.gDecay + 1 }); }
    last.set(r.h.id, t0); last.set(r.a.id, t0);
  }
  return { ll: +(ll / n).toFixed(4), acc: +(hit / n).toFixed(3), llGoals: +(llG / n).toFixed(4), n };
}

const BASE = { K: 20, KE: 1.5, HA: 50, restDays: 0, restPen: 0, teamHA: 0, form: 0, formDecay: 0.7, useTotal: true, gShrink: 6, gDecay: 0.93, gScale: 1 };
const show = (label, P) => console.log(label.padEnd(44), JSON.stringify(run({ ...BASE, ...P })));
console.log('matchs', ev.length);
show('base (modèle actuel)', {});
for (const [d, p] of [[3, 15], [3, 30], [4, 20], [4, 40]]) show(`fatigue <${d} j : -${p} Elo`, { restDays: d, restPen: p });
for (const c of [100, 200, 400]) show(`terrain par équipe ×${c}`, { teamHA: c });
for (const [f, dcy] of [[10, 0.7], [20, 0.7], [20, 0.5], [40, 0.5], [-10, 0.7]]) show(`forme ×${f} (oubli ${dcy})`, { form: f, formDecay: dcy });
for (const [s, dcy, sc] of [[6, 0.93, 1], [10, 0.93, 1], [6, 0.96, 1], [12, 0.96, 1], [6, 0.93, 1.03], [6, 0.93, 0.97]]) show(`buts : rétrécir ${s}, oubli ${dcy}, échelle ${sc}`, { gShrink: s, gDecay: dcy, gScale: sc });
show('buts : total fixe 2,7', { useTotal: false });
