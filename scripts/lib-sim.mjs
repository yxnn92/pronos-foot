// Outils de simulation sur les matchs passés (utilisés par le réglage automatique, scripts/tune.mjs).
// On rejoue les matchs dans l'ordre : pour chaque match, le modèle ne connaît que ce qui s'est passé avant.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DISPLAY, RATING_ONLY, LEAGUE_START, START_DEFAULT } from './config.mjs';
import { scoreMatrix, expScore, fitDC } from './model.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, 'data', 'cache');
const SITE = 'https://site.api.espn.com/apis/site/v2/sports/soccer';
const D = 864e5;

export const fair = (o) => { const inv = o.map((x) => 1 / x), s = inv.reduce((a, b) => a + b, 0); return inv.map((x) => x / s); };
const okOdds = (o) => o && o.every((x) => x);

// ---------- données : résultats ESPN + tirs (cache) + cotes passées (football-data) ----------
export async function loadData() {
  const slugs = [...DISPLAY, ...RATING_ONLY].map((c) => c.slug).filter((s) => !/fifa|nations|euro$|euroq|super_cup|charity/.test(s));
  let ev = [];
  for (const s of slugs) {
    const f = path.join(CACHE, `${s}-2025.json`);
    if (fs.existsSync(f)) ev.push(...JSON.parse(fs.readFileSync(f, 'utf8')).events.map((e) => ({ ...e, slug: s })));
  }
  const thisYear = new Date().getUTCFullYear();
  for (let y = 2026; y <= thisYear; y++) await Promise.all(slugs.map(async (s) => {
    const j = await (await fetch(`${SITE}/${s}/scoreboard?dates=${y}&limit=1000`)).json().catch(() => null);
    for (const e of j?.events || []) {
      const c = e.competitions[0], h = c.competitors.find((x) => x.homeAway === 'home'), a = c.competitors.find((x) => x.homeAway === 'away');
      if (e.status.type.completed) ev.push({ id: e.id, slug: s, date: e.date, neutral: c.neutralSite, h: { id: h.team.id, name: h.team.displayName }, a: { id: a.team.id, name: a.team.displayName }, hs: +h.score, as: +a.score, completed: true });
    }
  }));
  const seen = new Set();
  ev = ev.filter((e) => e.completed && !isNaN(e.hs) && !seen.has(e.id) && seen.add(e.id)).sort((a, b) => a.date.localeCompare(b.date));
  const statsFile = path.join(CACHE, 'matchstats.json');
  const stats = fs.existsSync(statsFile) ? JSON.parse(fs.readFileSync(statsFile, 'utf8')) : {};

  const FD_MAP = { E0: 'eng.1', SP1: 'esp.1', I1: 'ita.1', D1: 'ger.1', F1: 'fra.1' };
  const odds = new Map();
  const fdDir = path.join(CACHE, 'fd');
  if (fs.existsSync(fdDir)) for (const f of fs.readdirSync(fdDir)) {
    const slug = FD_MAP[f.split('_')[1]?.replace('.csv', '')]; if (!slug) continue;
    const lines = fs.readFileSync(path.join(fdDir, f), 'utf8').trim().split(/\r?\n/);
    const hd = lines[0].split(','), col = (n) => hd.indexOf(n);
    for (const L of lines.slice(1)) {
      const c = L.split(','); if (!c[col('Date')]) continue;
      const [dd, mm, yy] = c[col('Date')].split('/'); const date = `${yy.length === 2 ? '20' + yy : yy}-${mm}-${dd}`;
      const hs = +c[col('FTHG')], as = +c[col('FTAG')];
      const num = (n) => { const i = col(n); const v = i >= 0 ? parseFloat(c[i]) : NaN; return isFinite(v) && v > 1 ? v : null; };
      const o = { b365: [num('B365H'), num('B365D'), num('B365A')], ouAvg: [num('Avg>2.5'), num('Avg<2.5')] };
      const cands = ev.filter((e) => e.slug === slug && e.hs === hs && e.as === as && Math.abs(Date.parse(e.date.slice(0, 10)) - Date.parse(date)) <= D);
      if (cands.length === 1) odds.set(cands[0].id, o);
    }
  }
  const cnt = new Map();
  for (const r of ev) if (LEAGUE_START[r.slug]) for (const t of [r.h.id, r.a.id]) { const c = cnt.get(t) || {}; c[r.slug] = (c[r.slug] || 0) + 1; cnt.set(t, c); }
  const startOf = (t) => { const c = cnt.get(t); if (!c) return START_DEFAULT; return LEAGUE_START[Object.keys(c).reduce((x, y) => (c[y] > c[x] ? y : x))]; };
  return { ev, stats, odds, startOf };
}

// ---------- probabilités d'un match ----------
export function probs(lh, la) {
  const m = scoreMatrix(Math.max(0.05, lh), Math.max(0.05, la)); let h = 0, d = 0, a = 0, o25 = 0, o15 = 0, o35 = 0, o05 = 0, btts = 0;
  m.forEach((r, i) => r.forEach((p, j) => { if (i > j) h += p; else if (i === j) d += p; else a += p; if (i + j > 2.5) o25 += p; if (i + j > 1.5) o15 += p; if (i + j > 3.5) o35 += p; if (i + j > 0.5) o05 += p; if (i > 0 && j > 0) btts += p; }));
  return { h, d, a, o25, o15, o35, o05, btts };
}
function solveS(total, target) { let lo = -total + 0.1, hi = total - 0.1; for (let k = 0; k < 28; k++) { const s = (lo + hi) / 2, p = probs((total + s) / 2, (total - s) / 2); if (p.h + p.d / 2 < target) lo = s; else hi = s; } return (lo + hi) / 2; }

// ---------- simulation chronologique avec un jeu de paramètres ----------
// P : { K, HA, KE, eloMix, formAlpha, dcAlpha, dcXi, from }
export function simulate(ctx, P) {
  const { ev, stats, startOf } = ctx;
  const elo = new Map(), form = new Map();
  let dc = null, dcWeek = -1;
  const out = [];
  const isEval = (r) => r.date >= P.from && /^(eng|esp|ita|ger|fra)\.1$|^uefa\.(champions|europa|europa\.conf)$/.test(r.slug);
  const dcRes = ev.map((r) => ({ id: r.id, date: r.date, h: r.h.id, a: r.a.id, hs: r.hs, as: r.as, neutral: r.neutral }));
  for (const r of ev) {
    const t0 = Date.parse(r.date);
    for (const t of [r.h.id, r.a.id]) if (!elo.has(t)) elo.set(t, startOf(t));
    if (isEval(r)) {
      const wk = Math.floor(t0 / (7 * D));
      if (wk !== dcWeek) { dc = fitDC(dcRes, stats, wk * 7 * D, { xi: P.dcXi, k: 3, alpha: P.dcAlpha }); dcWeek = wk; }
      const we = expScore(elo.get(r.h.id) - elo.get(r.a.id) + (r.neutral ? 0 : P.HA));
      const F = (id) => { const f = form.get(id); const n = f?.n || 0, sh = n / (n + 30); return f && n > 0.5 ? { a: 1 + sh * (f.gf / n / 1.35 - 1), d: 1 + sh * (f.ga / n / 1.35 - 1) } : { a: 1, d: 1 }; };
      const A = F(r.h.id), B = F(r.a.id);
      const total = Math.min(4.2, Math.max(1.7, 1.35 * (A.a * B.d + B.a * A.d)));
      let s = solveS(total, we);
      if (dc?.att.has(r.h.id) && dc?.att.has(r.a.id)) {
        const hf = r.neutral ? 1 : dc.home;
        const sD = dc.mu * hf * dc.att.get(r.h.id) * dc.def.get(r.a.id) - dc.mu * dc.att.get(r.a.id) * dc.def.get(r.h.id);
        s = P.eloMix * s + (1 - P.eloMix) * Math.max(-total + 0.2, Math.min(total - 0.2, sD));
      }
      out.push({ r, p: probs((total + s) / 2, (total - s) / 2) });
    }
    const we = expScore(elo.get(r.h.id) - elo.get(r.a.id) + (r.neutral ? 0 : P.HA));
    const res = r.hs > r.as ? 1 : r.hs === r.as ? 0.5 : 0, gd = Math.abs(r.hs - r.as), g = gd <= 1 ? 1 : gd === 2 ? 1.5 : (11 + gd) / 8;
    const k = P.K * (LEAGUE_START[r.slug] ? 1 : P.KE) * g * (res - we);
    elo.set(r.h.id, elo.get(r.h.id) + k); elo.set(r.a.id, elo.get(r.a.id) - k);
    const st = stats[r.id], hasSot = st?.sot?.[0] != null && st?.sot?.[1] != null;
    for (const [t, gf, ga, i] of [[r.h.id, r.hs, r.as, 0], [r.a.id, r.as, r.hs, 1]]) {
      const sgf = hasSot ? P.formAlpha * gf + (1 - P.formAlpha) * st.sot[i] * 0.32 : gf;
      const sga = hasSot ? P.formAlpha * ga + (1 - P.formAlpha) * st.sot[1 - i] * 0.32 : ga;
      const f = form.get(t) || { gf: 0, ga: 0, n: 0 }; form.set(t, { gf: f.gf * 0.98 + sgf, ga: f.ga * 0.98 + sga, n: f.n * 0.98 + 1 });
    }
  }
  return out;
}

// Probabilités « comme sur le site » : part w du modèle, le reste aux cotes Bet365 quand elles existent.
export function blended(ctx, o, w) {
  const { r, p: p0 } = o; const p = { ...p0 };
  const od = ctx.odds.get(r.id);
  if (od && okOdds(od.b365)) { const [mh, md, ma] = fair(od.b365); p.h = w * p0.h + (1 - w) * mh; p.d = w * p0.d + (1 - w) * md; p.a = w * p0.a + (1 - w) * ma; }
  if (od && okOdds(od.ouAvg)) { const [mo] = fair(od.ouAvg); p.o25 = w * p0.o25 + (1 - w) * mo; }
  return p;
}

// Note d'un réglage : perte logarithmique 1N2 + buts (plus bas = meilleur), et taux de réussite.
export function score(ctx, out, w) {
  let ll = 0, llG = 0, n = 0, hit = 0, hitG = 0;
  for (const o of out) {
    const p = blended(ctx, o, w), r = o.r;
    const res = r.hs > r.as ? 'h' : r.hs === r.as ? 'd' : 'a';
    ll += -Math.log(Math.max(p[res], 1e-6)); n++;
    if (['h', 'd', 'a'].reduce((x, y) => (p[y] > p[x] ? y : x)) === res) hit++;
    const over = r.hs + r.as > 2.5; llG += -Math.log(Math.max(over ? p.o25 : 1 - p.o25, 1e-6)); if ((p.o25 >= 0.5) === over) hitG++;
  }
  return { n, loss: +((ll + llG) / n).toFixed(5), ll1x2: +(ll / n).toFixed(4), llGoals: +(llG / n).toFixed(4), acc1x2: +(100 * hit / n).toFixed(1), accGoals: +(100 * hitG / n).toFixed(1) };
}

// Réussite réelle des paris annoncés à 70 % / 80 % ou plus (pour « Les quasi-sûrs »).
export function calibration(ctx, out, w) {
  const cal = {};
  const add = (type, p, win) => { if (p < 0.7) return; const k = p >= 0.8 ? '80' : '70'; const c = (cal[type] ||= {}); const b = (c[k] ||= { n: 0, w: 0, sp: 0 }); b.n++; b.sp += p; if (win) b.w++; };
  for (const o of out) {
    const p = blended(ctx, o, w), r = o.r, res = r.hs > r.as ? 'h' : r.hs === r.as ? 'd' : 'a', tot = r.hs + r.as;
    const best = ['h', 'd', 'a'].reduce((x, y) => (p[y] > p[x] ? y : x)); add('1N2', p[best], best === res);
    const dc = { '1N': p.h + p.d, 'N2': p.d + p.a, '12': p.h + p.a }; const dk = Object.keys(dc).reduce((x, y) => (dc[y] > dc[x] ? y : x));
    add('DC', dc[dk], (dk === '1N' && res !== 'a') || (dk === 'N2' && res !== 'h') || (dk === '12' && res !== 'd'));
    for (const [L, key] of [[0.5, 'o05'], [1.5, 'o15'], [2.5, 'o25'], [3.5, 'o35']]) { const po = p[key]; if (po >= 0.5) add('Buts', po, tot > L); else add('Buts', 1 - po, tot < L); }
    add('BTTS', Math.max(p.btts, 1 - p.btts), p.btts >= 0.5 ? r.hs > 0 && r.as > 0 : !(r.hs > 0 && r.as > 0));
  }
  const res = {};
  for (const [t, c] of Object.entries(cal)) { res[t] = {}; for (const [k, b] of Object.entries(c)) res[t][k] = { n: b.n, announced: +(b.sp / b.n).toFixed(3), real: +(b.w / b.n).toFixed(3) }; }
  return res;
}
