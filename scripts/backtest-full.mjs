// Test complet du modèle sur les matchs passés, avec les vraies cotes (football-data.co.uk).
// Compare plusieurs versions (Elo, tirs cadrés, Dixon-Coles), le mélange avec le marché, et la rentabilité des value bets.
// Usage : node scripts/backtest-full.mjs   (nécessite data/cache/fd/*.csv et data/cache/matchstats.json)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DISPLAY, RATING_ONLY, LEAGUE_START, START_DEFAULT } from './config.mjs';
import { scoreMatrix, expScore } from './model.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, 'data', 'cache');
const SITE = 'https://site.api.espn.com/apis/site/v2/sports/soccer';
const D = 864e5;

// ---------- données ----------
const slugs = [...DISPLAY, ...RATING_ONLY].map((c) => c.slug).filter((s) => !/fifa|nations|euro$|euroq|super_cup|charity/.test(s));
let ev = [];
for (const s of slugs) {
  const f = path.join(CACHE, `${s}-2025.json`);
  if (fs.existsSync(f)) ev.push(...JSON.parse(fs.readFileSync(f, 'utf8')).events.map((e) => ({ ...e, slug: s })));
}
await Promise.all(slugs.map(async (s) => {
  const j = await (await fetch(`${SITE}/${s}/scoreboard?dates=2026&limit=1000`)).json().catch(() => null);
  for (const e of j?.events || []) {
    const c = e.competitions[0], h = c.competitors.find((x) => x.homeAway === 'home'), a = c.competitors.find((x) => x.homeAway === 'away');
    if (e.status.type.completed) ev.push({ id: e.id, slug: s, date: e.date, neutral: c.neutralSite, h: { id: h.team.id, name: h.team.displayName }, a: { id: a.team.id, name: a.team.displayName }, hs: +h.score, as: +a.score, completed: true, status: e.status.type.name });
  }
}));
ev = ev.filter((e) => e.completed && e.hs != null && !isNaN(e.hs)).sort((a, b) => a.date.localeCompare(b.date));
const byId = new Map(ev.map((e) => [e.id, e]));
const stats = fs.existsSync(path.join(CACHE, 'matchstats.json')) ? JSON.parse(fs.readFileSync(path.join(CACHE, 'matchstats.json'), 'utf8')) : {};
console.log('matchs :', ev.length, '· avec stats de tirs :', Object.values(stats).filter((s) => s.sot?.[0] != null).length);

// cotes football-data → rattachées aux matchs ESPN (même championnat, même date, même score)
const FD_MAP = { E0: 'eng.1', SP1: 'esp.1', I1: 'ita.1', D1: 'ger.1', F1: 'fra.1' };
const odds = new Map();
const fdDir = path.join(CACHE, 'fd');
if (fs.existsSync(fdDir)) for (const f of fs.readdirSync(fdDir)) {
  const slug = FD_MAP[f.split('_')[1].replace('.csv', '')]; if (!slug) continue;
  const lines = fs.readFileSync(path.join(fdDir, f), 'utf8').trim().split(/\r?\n/);
  const hd = lines[0].split(','), col = (n) => hd.indexOf(n);
  for (const L of lines.slice(1)) {
    const c = L.split(','); if (!c[col('Date')]) continue;
    const [dd, mm, yy] = c[col('Date')].split('/'); const date = `${yy.length === 2 ? '20' + yy : yy}-${mm}-${dd}`;
    const hs = +c[col('FTHG')], as = +c[col('FTAG')];
    const num = (n) => { const i = col(n); const v = i >= 0 ? parseFloat(c[i]) : NaN; return isFinite(v) && v > 1 ? v : null; };
    const o = {
      b365: [num('B365H'), num('B365D'), num('B365A')], pin: [num('PSH'), num('PSD'), num('PSA')], avg: [num('AvgH'), num('AvgD'), num('AvgA')],
      pinC: [num('PSCH'), num('PSCD'), num('PSCA')], max: [num('MaxH'), num('MaxD'), num('MaxA')],
      ou: [num('B365>2.5'), num('B365<2.5')], ouAvg: [num('Avg>2.5'), num('Avg<2.5')],
    };
    const cands = ev.filter((e) => e.slug === slug && e.hs === hs && e.as === as && Math.abs(Date.parse(e.date.slice(0, 10)) - Date.parse(date)) <= D);
    if (cands.length === 1) odds.set(cands[0].id, o);
    else if (cands.length > 1) { // départage par le nom
      const n = (s) => s.toLowerCase().replace(/[^a-z]/g, '');
      const hn = n(c[col('HomeTeam')]).slice(0, 5);
      const m = cands.find((e) => n(e.h.name || '').includes(hn)); if (m) odds.set(m.id, o);
    }
  }
}
console.log('matchs avec cotes passées :', odds.size);

// ---------- outils ----------
const fair = (o) => { const inv = o.map((x) => 1 / x), s = inv.reduce((a, b) => a + b, 0); return inv.map((x) => x / s); };
const okOdds = (o) => o && o.every((x) => x);
function probs(lh, la) {
  const m = scoreMatrix(Math.max(0.05, lh), Math.max(0.05, la)); let h = 0, d = 0, a = 0, o25 = 0, o15 = 0, o35 = 0, o05 = 0, btts = 0;
  m.forEach((r, i) => r.forEach((p, j) => { if (i > j) h += p; else if (i === j) d += p; else a += p; if (i + j > 2.5) o25 += p; if (i + j > 1.5) o15 += p; if (i + j > 3.5) o35 += p; if (i + j > 0.5) o05 += p; if (i > 0 && j > 0) btts += p; }));
  return { h, d, a, o25, o15, o35, o05, btts };
}
function solveS(total, target) { let lo = -total + 0.1, hi = total - 0.1; for (let k = 0; k < 30; k++) { const s = (lo + hi) / 2, p = probs((total + s) / 2, (total - s) / 2); if (p.h + p.d / 2 < target) lo = s; else hi = s; } return (lo + hi) / 2; }
const isEval = (r) => r.date >= '2025-09-01' && /^(eng|esp|ita|ger|fra)\.1$|^uefa\.(champions|europa|europa\.conf)$/.test(r.slug);
const startOfTeam = (() => { const cnt = new Map(); for (const r of ev) if (LEAGUE_START[r.slug]) for (const t of [r.h.id, r.a.id]) { const c = cnt.get(t) || {}; c[r.slug] = (c[r.slug] || 0) + 1; cnt.set(t, c); } return (t) => { const c = cnt.get(t); if (!c) return START_DEFAULT; return LEAGUE_START[Object.keys(c).reduce((x, y) => (c[y] > c[x] ? y : x))]; }; })();

// ---------- Dixon-Coles (forces attaque/défense pondérées dans le temps), recalculé chaque semaine ----------
function fitDC(matches, cutoff, { xi, k, useShots, alpha }) {
  const att = new Map(), def = new Map(); let home = 1.25;
  const data = [];
  for (const r of matches) {
    const t = Date.parse(r.date); if (t >= cutoff || cutoff - t > 400 * D) continue;
    const w = Math.exp(-xi * (cutoff - t) / D);
    let gh = r.hs, ga = r.as;
    const st = useShots && stats[r.id];
    if (st && st.sot?.[0] != null && st.sot?.[1] != null) { gh = alpha * r.hs + (1 - alpha) * st.sot[0] * 0.32; ga = alpha * r.as + (1 - alpha) * st.sot[1] * 0.32; }
    data.push({ h: r.h.id, a: r.a.id, gh, ga, w, n: r.neutral });
    for (const x of [r.h.id, r.a.id]) { if (!att.has(x)) { att.set(x, 1); def.set(x, 1); } }
  }
  const mu = data.reduce((s, x) => s + x.w * (x.gh + x.ga), 0) / data.reduce((s, x) => s + 2 * x.w, 0);
  for (let it = 0; it < 12; it++) {
    const nA = new Map(), dA = new Map(), nD = new Map(), dD = new Map(); let hn = 0, hd = 0;
    for (const x of data) {
      const hf = x.n ? 1 : home;
      nA.set(x.h, (nA.get(x.h) || 0) + x.w * x.gh); dA.set(x.h, (dA.get(x.h) || 0) + x.w * mu * hf * def.get(x.a));
      nA.set(x.a, (nA.get(x.a) || 0) + x.w * x.ga); dA.set(x.a, (dA.get(x.a) || 0) + x.w * mu * def.get(x.h));
      nD.set(x.a, (nD.get(x.a) || 0) + x.w * x.gh); dD.set(x.a, (dD.get(x.a) || 0) + x.w * mu * hf * att.get(x.h));
      nD.set(x.h, (nD.get(x.h) || 0) + x.w * x.ga); dD.set(x.h, (dD.get(x.h) || 0) + x.w * mu * att.get(x.a));
      if (!x.n) { hn += x.w * x.gh; hd += x.w * mu * att.get(x.h) * def.get(x.a); }
    }
    for (const t of att.keys()) { att.set(t, ((nA.get(t) || 0) + k) / ((dA.get(t) || 0) + k)); def.set(t, ((nD.get(t) || 0) + k) / ((dD.get(t) || 0) + k)); }
    // échelle fixée : moyenne des attaques et des défenses = 1 (sinon le calcul dérive)
    const ma = [...att.values()].reduce((x, y) => x + y, 0) / att.size, md = [...def.values()].reduce((x, y) => x + y, 0) / def.size;
    for (const t of att.keys()) { att.set(t, att.get(t) / ma); def.set(t, def.get(t) / md); }
    home = hd ? hn / hd : home;
  }
  return { att, def, home, mu };
}

// ---------- simulation chronologique ----------
function simulate(P) {
  const elo = new Map(), form = new Map(), sform = new Map();
  let dc = null, dcWeek = -1;
  const out = [];
  for (const r of ev) {
    const t0 = Date.parse(r.date);
    for (const t of [r.h.id, r.a.id]) if (!elo.has(t)) elo.set(t, startOfTeam(t));
    if (isEval(r)) {
      // Dixon-Coles recalculé une fois par semaine (sur les matchs d'avant)
      const wk = Math.floor(t0 / (7 * D));
      if (P.dc && wk !== dcWeek) { dc = fitDC(ev, wk * 7 * D, P.dc); dcWeek = wk; }
      const we = expScore(elo.get(r.h.id) - elo.get(r.a.id) + (r.neutral ? 0 : 50));
      const F = (m, id) => { const f = m.get(id); const n = f?.n || 0, sh = n / (n + 30); return f && n > 0.5 ? { a: 1 + sh * (f.gf / n / 1.35 - 1), d: 1 + sh * (f.ga / n / 1.35 - 1) } : { a: 1, d: 1 }; };
      const src = P.shotsTotal ? sform : form;
      const A = F(src, r.h.id), B = F(src, r.a.id);
      let total = Math.min(4.2, Math.max(1.7, 1.35 * (A.a * B.d + B.a * A.d)));
      let lh, la;
      if (P.dc && dc && dc.att.has(r.h.id) && dc.att.has(r.a.id)) {
        const hf = r.neutral ? 1 : dc.home;
        const dlh = dc.mu * hf * dc.att.get(r.h.id) * dc.def.get(r.a.id), dla = dc.mu * dc.att.get(r.a.id) * dc.def.get(r.h.id);
        if (P.mix === 'dc') { lh = dlh; la = dla; }
        else { // mélange : supériorité Elo / Dixon-Coles, total Dixon-Coles
          const T = P.formTotal ? total : dlh + dla;
          const sE = solveS(T, we), sD = dlh - dla, s = P.mix * sE + (1 - P.mix) * sD;
          lh = (T + s) / 2; la = (T - s) / 2;
        }
      } else { const s = solveS(total, we); lh = (total + s) / 2; la = (total - s) / 2; }
      out.push({ r, p: probs(lh, la), lh, la });
    }
    // mise à jour Elo
    const we = expScore(elo.get(r.h.id) - elo.get(r.a.id) + (r.neutral ? 0 : 50));
    const res = r.hs > r.as ? 1 : r.hs === r.as ? 0.5 : 0, gd = Math.abs(r.hs - r.as), g = gd <= 1 ? 1 : gd === 2 ? 1.5 : (11 + gd) / 8;
    const k = 20 * (LEAGUE_START[r.slug] ? 1 : 1.5) * g * (res - we);
    elo.set(r.h.id, elo.get(r.h.id) + k); elo.set(r.a.id, elo.get(r.a.id) - k);
    // formes buts / tirs
    const st = stats[r.id];
    for (const [t, gf, ga, i] of [[r.h.id, r.hs, r.as, 0], [r.a.id, r.as, r.hs, 1]]) {
      const f = form.get(t) || { gf: 0, ga: 0, n: 0 }; form.set(t, { gf: f.gf * 0.98 + gf, ga: f.ga * 0.98 + ga, n: f.n * 0.98 + 1 });
      let sgf = gf, sga = ga;
      if (st?.sot?.[0] != null && st?.sot?.[1] != null) { const al = P.alpha ?? 0.5; sgf = al * gf + (1 - al) * st.sot[i] * 0.32; sga = al * ga + (1 - al) * st.sot[1 - i] * 0.32; }
      const s2 = sform.get(t) || { gf: 0, ga: 0, n: 0 }; sform.set(t, { gf: s2.gf * 0.98 + sgf, ga: s2.ga * 0.98 + sga, n: s2.n * 0.98 + 1 });
    }
  }
  return out;
}

// ---------- évaluation ----------
function evaluate(out, label, w = null, oddsKey = 'pin') {
  let ll = 0, llG = 0, n = 0, hit = 0, nG = 0, hitG = 0;
  for (const { r, p: p0 } of out) {
    let p = p0;
    if (w != null) { // mélange avec le marché, seulement sur les matchs avec cotes
      const o = odds.get(r.id); if (!o || !okOdds(o[oddsKey])) continue;
      const [mh, md, ma] = fair(o[oddsKey]);
      p = { h: w * p0.h + (1 - w) * mh, d: w * p0.d + (1 - w) * md, a: w * p0.a + (1 - w) * ma, o25: p0.o25 };
      if (okOdds(o.ouAvg)) { const [mo] = fair(o.ouAvg); p.o25 = w * p0.o25 + (1 - w) * mo; }
    }
    const res = r.hs > r.as ? 'h' : r.hs === r.as ? 'd' : 'a';
    ll += -Math.log(Math.max(p[res], 1e-6)); n++;
    if (['h', 'd', 'a'].reduce((x, y) => (p[y] > p[x] ? y : x)) === res) hit++;
    const over = r.hs + r.as > 2.5; llG += -Math.log(Math.max(over ? p.o25 : 1 - p.o25, 1e-6)); nG++; if ((p.o25 >= 0.5) === over) hitG++;
  }
  const row = { label, n, ll1x2: +(ll / n).toFixed(4), acc1x2: +(100 * hit / n).toFixed(1), llGoals: +(llG / nG).toFixed(4), accGoals: +(100 * hitG / nG).toFixed(1) };
  console.log(JSON.stringify(row));
  return row;
}

// Rentabilité des value bets : misés à la cote France estimée (0,91 / proba marché Bet365), 1 unité par pari.
function valueROI(out, w, edge, maxGap, frPayout = 0.91, src = 'b365') {
  let n = 0, profit = 0, wins = 0;
  for (const { r, p: p0 } of out) {
    const o = odds.get(r.id); if (!o || !okOdds(o[src])) continue;
    const fm = fair(o[src]), frOdds = fm.map((x) => frPayout / x);
    const res = r.hs > r.as ? 0 : r.hs === r.as ? 1 : 2;
    ['h', 'd', 'a'].forEach((k, i) => {
      const p = w * p0[k] + (1 - w) * fm[i];
      if (Math.abs(p0[k] - fm[i]) > maxGap || frOdds[i] > 6 || p < 0.2) return;
      if (p * frOdds[i] >= 1 + edge) { n++; if (res === i) { profit += frOdds[i] - 1; wins++; } else profit -= 1; }
    });
  }
  return { n, wins, roi: n ? +(100 * profit / n).toFixed(1) : 0, profit: +profit.toFixed(1) };
}

const args = process.argv.slice(2);
console.log('\n=== 1. Versions du modèle (modèle seul) ===');
const runs = {};
runs.base = simulate({}); evaluate(runs.base, 'actuel (Elo + buts)');
runs.shots = simulate({ shotsTotal: true, alpha: 0.5 }); evaluate(runs.shots, 'Elo + total buts/tirs cadrés (50/50)');
runs.shots3 = simulate({ shotsTotal: true, alpha: 0.3 }); evaluate(runs.shots3, 'Elo + total buts/tirs cadrés (30/70)');
for (const [xi, k] of [[0.003, 3], [0.005, 3], [0.008, 3]]) {
  const key = `dc_${xi}`; runs[key] = simulate({ dc: { xi, k, useShots: false }, mix: 'dc' }); evaluate(runs[key], `Dixon-Coles (oubli ${xi})`);
}
for (const al of [0.5, 0.3]) { const key = `dcs_${al}`; runs[key] = simulate({ dc: { xi: 0.005, k: 3, useShots: true, alpha: al }, mix: 'dc' }); evaluate(runs[key], `Dixon-Coles + tirs cadrés (${al * 100}/${100 - al * 100})`); }
for (const mix of [0.4, 0.6]) { const key = `mixf_${mix}`; runs[key] = simulate({ dc: { xi: 0.005, k: 3, useShots: true, alpha: 0.5 }, mix, shotsTotal: true, alpha: 0.3, formTotal: true }); evaluate(runs[key], `Elo ${mix * 100} % + DC tirs, total buts/tirs 30/70`); }
for (const mix of [0.5]) { const key = `mix_${mix}`; runs[key] = simulate({ dc: { xi: 0.005, k: 3, useShots: true, alpha: 0.5 }, mix }); evaluate(runs[key], `Elo ${mix * 100} % + Dixon-Coles tirs ${100 - mix * 100} %`); }

console.log('\n=== 2. Prono complet : mélange avec le marché (matchs Top 5 avec cotes Pinnacle) ===');
const best = Object.entries(runs).map(([k, o]) => [k, evaluate(o, '  ' + k, 1, 'pin')]).sort((a, b) => a[1].ll1x2 - b[1].ll1x2)[0][0];
console.log('meilleure version modèle seul sur ces matchs :', best);
for (const w of [0, 0.15, 0.3, 0.45, 0.6]) evaluate(runs[best], `${best} · part modèle ${w * 100} %`, w, 'pin');
evaluate(runs.base, `actuel · part modèle 45 %`, 0.45, 'pin');
console.log('--- avec les cotes Bet365 (celles du site) :');
for (const w of [0, 0.15, 0.3, 0.45]) evaluate(runs[best], `${best} · part modèle ${w * 100} % (Bet365)`, w, 'b365');
for (const w of [0, 0.15, 0.3]) evaluate(runs.shots3, `tirs 30/70 · part modèle ${w * 100} % (Bet365)`, w, 'b365');

console.log('\n=== 3. Value bets (cote France estimée, 1 unité par pari) ===');
for (const [label, run] of [['actuel', runs.base], [best, runs[best]]]) for (const w of [0.45, 0.3]) for (const edge of [0.03, 0.05, 0.08, 0.12]) {
  const r = valueROI(run, w, edge, 0.15);
  console.log(`${label.padEnd(10)} part ${w * 100} % · seuil +${edge * 100} % → ${r.n} paris, ${r.wins} gagnés, ROI ${r.roi} %`);
}
const rb = valueROI(runs.base, 0.45, 0.05, 0.15, 1.0, 'max');
console.log(`référence : réglage actuel mais à la MEILLEURE cote du marché (pas une cote France) → ${rb.n} paris, ROI ${rb.roi} %`);

// ---------- 4. Effet réel des absents ----------
// Pour chaque équipe : part de ses buts (+ ½ passes) des 365 derniers jours apportée par des joueurs NON titulaires ce jour-là.
console.log("=== 4. Effet réel des absents (buts marqués / buts attendus par le modèle) ===");
const contrib = new Map(); // équipe → Map(joueur → [{t, v}])
const recentXI = new Map(); // équipe → 6 dernières listes de titulaires
const statsSorted = Object.entries(stats).sort((a, b) => a[1].date.localeCompare(b[1].date));
const outById = new Map(runs.base.map((o) => [o.r.id, o]));
const bins = {};
let teamGoalsTot = new Map();
for (const [id, st] of statsSorted) {
  const e = byId.get(id); if (!e) continue;
  const t0 = Date.parse(st.date);
  const o = outById.get(id);
  if (o && st.starters?.h?.length && st.starters?.a?.length) for (const [side, tid, lam, goals] of [["h", e.h.id, o.lh, e.hs], ["a", e.a.id, o.la, e.as]]) {
    const pl = contrib.get(tid); if (!pl) continue;
    let tot = 0, miss = 0;
    const recent = new Set((recentXI.get(tid) || []).flat());
    if ((recentXI.get(tid) || []).length < 3) continue;
    for (const [pid, arr] of pl) { if (!recent.has(pid)) continue; const v = arr.filter((x) => t0 - x.t < 365 * D).reduce((a, x) => a + x.v, 0); tot += v; if (!st.starters[side].includes(pid)) miss += v; }
    const share = miss / (tot + 6);
    const k = share < 0.02 ? "0-2 %" : share < 0.08 ? "2-8 %" : share < 0.15 ? "8-15 %" : share < 0.25 ? "15-25 %" : "25 % +";
    const b = bins[k] ||= { n: 0, g: 0, lam: 0, sh: 0 }; b.n++; b.g += goals; b.lam += lam; b.sh += share;
  }
  for (const [side, tid] of [["h", e.h.id], ["a", e.a.id]]) if (st.starters?.[side]?.length) { const l = recentXI.get(tid) || []; l.unshift(st.starters[side]); recentXI.set(tid, l.slice(0, 6)); }
  // on ajoute les buts/passes de ce match APRÈS (pas de triche)
  for (const g of st.goals || []) {
    if (g.og || !g.t) continue; const tid = g.t === "h" ? e.h.id : e.a.id;
    const pl = contrib.get(tid) || new Map(); contrib.set(tid, pl);
    if (g.s) { const a = pl.get(g.s) || []; a.push({ t: t0, v: 1 }); pl.set(g.s, a); }
    if (g.a) { const a = pl.get(g.a) || []; a.push({ t: t0, v: 0.5 }); pl.set(g.a, a); }
  }
}
for (const k of ["0-2 %", "2-8 %", "8-15 %", "15-25 %", "25 % +"]) { const b = bins[k]; if (b) console.log(k.padEnd(8), "part manquante moy.", (100 * b.sh / b.n).toFixed(1) + " %", "· buts réels / attendus =", (b.g / b.lam).toFixed(3), "(", b.n, "équipes-matchs )"); }

// ---------- 5. Calibration des paris très probables (pour « Les quasi-sûrs ») ----------
// Probabilités comme sur le site : 10 % modèle (meilleure version) + 90 % cotes Bet365 quand elles existent.
console.log("=== 5. Paris annoncés très probables : réussite réelle ===");
const calRun = runs["mixf_0.6"] || runs.base;
const cal = {};
const addCal = (type, p, win) => { if (p < 0.7) return; const k = p >= 0.8 ? "80" : "70"; const c = (cal[type] ||= {}); const b = (c[k] ||= { n: 0, w: 0, sp: 0 }); b.n++; b.sp += p; if (win) b.w++; };
for (const { r, p: p0 } of calRun) {
  let p = { ...p0 };
  const o = odds.get(r.id);
  if (o && okOdds(o.b365)) { const [mh, md, ma] = fair(o.b365); p.h = 0.1 * p0.h + 0.9 * mh; p.d = 0.1 * p0.d + 0.9 * md; p.a = 0.1 * p0.a + 0.9 * ma; }
  if (o && okOdds(o.ouAvg)) { const [mo] = fair(o.ouAvg); p.o25 = 0.1 * p0.o25 + 0.9 * mo; }
  const res = r.hs > r.as ? "h" : r.hs === r.as ? "d" : "a", tot = r.hs + r.as;
  const best = ["h", "d", "a"].reduce((x, y) => (p[y] > p[x] ? y : x)); addCal("1N2", p[best], best === res);
  const dc = { "1N": p.h + p.d, "N2": p.d + p.a, "12": p.h + p.a }; const dk = Object.keys(dc).reduce((x, y) => (dc[y] > dc[x] ? y : x));
  addCal("DC", dc[dk], (dk === "1N" && res !== "a") || (dk === "N2" && res !== "h") || (dk === "12" && res !== "d"));
  for (const [L, key] of [[0.5, "o05"], [1.5, "o15"], [2.5, "o25"], [3.5, "o35"]]) { const po = p[key]; if (po >= 0.5) addCal("Buts", po, tot > L); else addCal("Buts", 1 - po, tot < L); }
  addCal("BTTS", Math.max(p.btts, 1 - p.btts), p.btts >= 0.5 ? r.hs > 0 && r.as > 0 : !(r.hs > 0 && r.as > 0));
}
const calOut = {};
for (const [t, c] of Object.entries(cal)) { calOut[t] = {}; for (const [k, b] of Object.entries(c)) { calOut[t][k] = { n: b.n, announced: +(b.sp / b.n).toFixed(3), real: +(b.w / b.n).toFixed(3) }; console.log(t.padEnd(5), k + " %+", "annoncé", (100 * b.sp / b.n).toFixed(1) + " %", "→ réel", (100 * b.w / b.n).toFixed(1) + " %", "(", b.n, ")"); } }
fs.writeFileSync(path.join(ROOT, "data", "calibration.json"), JSON.stringify({ updatedAt: new Date().toISOString(), matches: calRun.length, from: "2025-09-01", bins: calOut }));
