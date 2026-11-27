// Test des paris joueurs NBA et de l'effet des blessés sur les matchs passés (2 saisons).
// Usage : node scripts/nba-props-backtest.mjs
// Écrit data/nba-props-params.json (réglages des paris joueurs + effet des absents), lu par scripts/nba.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, loadGames, runModel, NBA_PARAMS, phi } from './nba-lib.mjs';
import { collectBoxes, boxFile } from './nba-box.mjs';

const games = await loadGames();
const seasons = [...new Set(games.filter((g) => g.stype !== 1).map((g) => g.season))].sort();
const cur = seasons[seasons.length - 1];
const boxes = {};
for (const s of seasons.slice(-2)) {
  const gs = games.filter((g) => g.season === s && g.stype !== 1);
  const { box, fetched } = await collectBoxes(boxFile(s, s === cur), gs, { log: (m) => console.log('  récolte saison', s, m) });
  Object.assign(boxes, box);
  console.log('saison', s, ':', Object.keys(box).length, 'feuilles (', fetched, 'téléchargées )');
}

// Prédictions du modèle d'équipe pour chaque match (sans les blessés) → pour mesurer l'effet des absents
const predOf = new Map();
runModel(games, NBA_PARAMS, (g, pr) => predOf.set(g.id, pr));

const evalGames = games.filter((g) => g.completed && boxes[g.id] && g.stype !== 1 && g.season >= seasons[seasons.length - 2]).sort((a, b) => a.date.localeCompare(b.date));
console.log('matchs testés :', evalGames.length);

// ---------- 1. Paris joueurs ----------
const STATS = { pts: 4, reb: 5, ast: 6, tpm: 9 };
const FLOOR = { pts: 4.5, reb: 2.2, ast: 1.8, tpm: 1.1 };
function runProps(Q) {
  const hist = new Map(); // joueur → valeurs passées
  const res = { all: [], byStat: {} };
  for (const g of evalGames) {
    const b = boxes[g.id];
    for (const [tid, list] of Object.entries(b.t)) {
      for (const r of list) {
        const h = hist.get(r[0]);
        if (h && h.season === g.season && h.g.length >= 5) {
          const mins = h.g.map((x) => x.min), avgMin = mins.reduce((a, c) => a + c, 0) / mins.length;
          if (avgMin >= 20) {
            for (const [k, ix] of Object.entries(STATS)) {
              const vals = h.g.map((x) => x[k]), l10 = vals.slice(-10);
              const mAll = vals.reduce((a, c) => a + c, 0) / vals.length, m10 = l10.reduce((a, c) => a + c, 0) / l10.length;
              const proj = Q.w10 * m10 + (1 - Q.w10) * mAll;
              const sd0 = Math.max(FLOOR[k], Math.sqrt(vals.reduce((a, c) => a + (c - mAll) ** 2, 0) / vals.length));
              const sm = typeof Q.sdMult === 'object' ? Q.sdMult[k] : Q.sdMult, sh = typeof Q.shift === 'object' ? Q.shift[k] : (Q.shift || 0);
              const sd = sd0 * sm, center = proj - sh * sd0;
              const actual = r[ix];
              const minLine = { pts: 9.5, reb: 3.5, ast: 2.5, tpm: 0.5 }[k];
              for (const line of new Set([Math.max(0.5, Math.round(proj) - 0.5), Math.max(0.5, Math.floor(proj - 0.75 * sd0) + 0.5)])) {
                if (line < minLine) continue;
                const pN = 1 - phi((line - center) / sd);
                let p = pN;
                if (Q.emp) { let w = 0, k = 0; vals.forEach((v, i) => { const wt = Math.pow(0.95, vals.length - 1 - i); w += wt; if (v > line) k += wt; }); p = (k + Q.emp * pN) / (w + Q.emp); }
                if (p < 0.5 || p > 0.93) continue;
                const o = { p, win: actual > line };
                res.all.push(o); (res.byStat[k] ||= []).push(o);
              }
            }
          }
        }
        // on enregistre le match APRÈS (pas de triche)
        const e = hist.get(r[0]) && hist.get(r[0]).season === g.season ? hist.get(r[0]) : { season: g.season, g: [] };
        e.g.push({ min: r[3], pts: r[4], reb: r[5], ast: r[6], tpm: r[9] ?? 0 }); hist.set(r[0], e);
      }
    }
  }
  return res;
}
const ll = (arr) => arr.reduce((t, o) => t - Math.log(Math.max(1e-6, o.win ? o.p : 1 - o.p)), 0) / Math.max(1, arr.length);
const calib = (arr) => { const bins = {}; for (const o of arr) { const k = o.p >= 0.8 ? '80+' : o.p >= 0.7 ? '70-80' : o.p >= 0.6 ? '60-70' : o.p >= 0.5 ? '50-60' : '45-50'; const b = (bins[k] ||= { n: 0, w: 0, sp: 0 }); b.n++; b.sp += o.p; if (o.win) b.w++; } return Object.fromEntries(Object.entries(bins).sort().map(([k, b]) => [k, { n: b.n, announced: +(b.sp / b.n).toFixed(3), real: +(b.w / b.n).toFixed(3) }])); };

console.log('\n=== 1. Paris joueurs ===');
let best = null;
for (const w10 of [0.2, 0.3, 0.45]) for (const sdMult of [1, 1.2, 1.4]) {
  const r = runProps({ w10, sdMult, shift: 0.2 }); const L = ll(r.all);
  if (!best || L < best.L) best = { w10, sdMult, L, r };
}
console.log('meilleur réglage :', JSON.stringify({ w10: best.w10, sdMult: best.sdMult }), '· paris testés :', best.r.all.length);
const r0 = runProps({ w10: 0.55, sdMult: 1 });
console.log('réglage actuel (forme 55 %, dispersion ×1) : réussite par tranche');
for (const [k, b] of Object.entries(calib(r0.all))) console.log(`   ${k.padEnd(6)} annoncé ${(100 * b.announced).toFixed(1)} % → réel ${(100 * b.real).toFixed(1)} % (${b.n})`);
console.log('meilleur réglage : réussite par tranche');
const calBest = calib(best.r.all);
for (const [k, b] of Object.entries(calBest)) console.log(`   ${k.padEnd(6)} annoncé ${(100 * b.announced).toFixed(1)} % → réel ${(100 * b.real).toFixed(1)} % (${b.n})`);
// correction par type de stat (multiplicateur de dispersion propre à chaque stat)
const statSd = {};
const statShift = {};
for (const k of Object.keys(STATS)) {
  let bk = null;
  for (const sh of [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]) for (const m of [0.55, 0.65, 0.75, 0.85, 1]) { const r = runProps({ w10: best.w10, sdMult: m, shift: sh }); const L = ll(r.byStat[k] || []); if (!bk || L < bk.L) bk = { m, sh, L, n: (r.byStat[k] || []).length, cal: calib(r.byStat[k] || []) }; }
  statSd[k] = bk.m; statShift[k] = bk.sh;
  console.log(`   ${k} : décalage ${bk.sh}·σ, dispersion ×${bk.m} (${bk.n} paris) →`, Object.entries(bk.cal).map(([b, c]) => `${b}: ${Math.round(c.announced * 100)}→${Math.round(c.real * 100)}`).join(' · '));
}

// ---------- 1 bis. Double-double et triple-double ----------
// Chance d'atteindre 10 dans chaque stat (fréquence de la saison, pondérée vers le récent, mélangée au calcul)
{
  const hist = new Map(), dd = [], td = [];
  for (const g of evalGames) for (const list of Object.values(boxes[g.id].t)) for (const r of list) {
    const h = hist.get(r[0]);
    if (h && h.season === g.season && h.g.length >= 8 && h.g.reduce((t, x) => t + x.min, 0) / h.g.length >= 24) {
      const p10 = (k) => { let w = 0, c = 0; h.g.forEach((x, i) => { const wt = Math.pow(0.95, h.g.length - 1 - i); w += wt; if (x[k] >= 10) c += wt; }); return (c + 0.5) / (w + 1); };
      const [a1, b1, c1] = ['pts', 'reb', 'ast'].map(p10);
      // les stats d'un même joueur sont liées : on mesure la fréquence réelle du double-double plutôt que de multiplier
      let w = 0, cdd = 0, ctd = 0; h.g.forEach((x, i) => { const wt = Math.pow(0.95, h.g.length - 1 - i); w += wt; const n = (x.pts >= 10) + (x.reb >= 10) + (x.ast >= 10); if (n >= 2) cdd += wt; if (n >= 3) ctd += wt; });
      const pInd = a1 * b1 + a1 * c1 + b1 * c1 - 2 * a1 * b1 * c1;
      const pdd = (cdd + 3 * pInd) / (w + 3), ptd = (ctd + 3 * a1 * b1 * c1) / (w + 3);
      const n = (r[4] >= 10) + (r[5] >= 10) + (r[6] >= 10);
      if (pdd >= 0.2) dd.push({ p: pdd, win: n >= 2 });
      if (ptd >= 0.08) td.push({ p: ptd, win: n >= 3 });
    }
    const e = h && h.season === g.season ? h : { season: g.season, g: [] }; e.g.push({ min: r[3], pts: r[4], reb: r[5], ast: r[6] }); hist.set(r[0], e);
  }
  const show = (name, arr) => { console.log(name + ' :', arr.length, 'cas'); const bins = {}; for (const o of arr) { const k = o.p >= 0.7 ? '70+' : o.p >= 0.5 ? '50-70' : o.p >= 0.3 ? '30-50' : o.p >= 0.15 ? '15-30' : '8-15'; const b = (bins[k] ||= { n: 0, w: 0, sp: 0 }); b.n++; b.sp += o.p; if (o.win) b.w++; } for (const [k, b] of Object.entries(bins).sort()) console.log(`   ${k.padEnd(6)} annoncé ${(100 * b.sp / b.n).toFixed(1)} % → réel ${(100 * b.w / b.n).toFixed(1)} % (${b.n})`); };
  show('Double-double', dd); show('Triple-double', td);
}

// ---------- 2. Effet des absents ----------
console.log('\n=== 2. Effet des joueurs absents ===');
const seen = new Map(); // équipe → joueurs réguliers récents
const rows = [];
for (const g of evalGames) {
  const b = boxes[g.id], pr = predOf.get(g.id); if (!pr) continue;
  const missing = {};
  for (const [side, t] of [['h', g.h.id], ['a', g.a.id]]) {
    const reg = seen.get(t) || new Map();
    const present = new Set((b.t[t] || []).map((r) => r[0]));
    // réguliers : au moins 10 matchs, 26+ minutes de moyenne, et présents à l'un des 3 derniers matchs de l'équipe
    missing[side] = [...reg.values()].filter((p) => p.season === g.season && p.n >= 10 && p.min / p.n >= 26 && p.lastIdx >= (p.teamGames - 3) && !present.has(p.id)).reduce((t, p) => t + p.pts / p.n, 0);
  }
  rows.push({ resid: (g.hs - g.as) - pr.margin, mh: missing.h, ma: missing.a, residT: (g.hs + g.as) - pr.total });
  for (const [t, list] of Object.entries(b.t)) {
    const reg = seen.get(t) || new Map(); const tg = (reg.tg || 0) + 1; reg.tg = tg;
    for (const r of list) { const p = reg.get(r[0]) && reg.get(r[0]).season === g.season ? reg.get(r[0]) : { id: r[0], season: g.season, n: 0, min: 0, pts: 0 }; p.n++; p.min += r[3]; p.pts += r[4]; p.lastIdx = tg; reg.set(r[0], p); }
    for (const p of reg.values()) if (p.id) p.teamGames = tg;
    seen.set(t, reg);
  }
}
// régression : écart réel − écart prévu = c × (points manquants adverses − points manquants de l'équipe)
const xs = rows.map((r) => r.ma - r.mh), ys = rows.map((r) => r.resid);
const c = xs.reduce((t, x, i) => t + x * ys[i], 0) / Math.max(1e-6, xs.reduce((t, x) => t + x * x, 0));
const tot = rows.map((r) => r.mh + r.ma), cT = tot.reduce((t, x, i) => t + x * rows[i].residT, 0) / Math.max(1e-6, tot.reduce((t, x) => t + x * x, 0));
const withMiss = rows.filter((r) => r.mh + r.ma > 0).length;
console.log(`${rows.length} matchs, dont ${withMiss} avec au moins un régulier absent`);
console.log(`effet sur l'écart : ${c.toFixed(3)} point d'écart par point/match du joueur absent (avant : 0,15)`);
console.log(`effet sur le total : ${cT.toFixed(3)} point de total par point/match absent (avant : 0,12)`);
for (const [lo, hi] of [[0, 0.01], [0.01, 15], [15, 25], [25, 99]]) {
  const sel = rows.filter((r) => { const d = r.mh - r.ma; return d >= lo && d < hi; });
  if (sel.length) console.log(`   équipe privée de ${lo}–${hi} pts/match de plus que l'adversaire : écart réel − prévu = ${(sel.reduce((t, r) => t + r.resid, 0) / sel.length).toFixed(2)} (${sel.length} matchs)`);
}

let final = runProps({ w10: best.w10, sdMult: statSd, shift: statShift }), empK = 0;
for (const emp of [3, 6, 10]) { const r = runProps({ w10: best.w10, sdMult: statSd, shift: statShift, emp }); if (ll(r.all) < ll(final.all)) { final = r; empK = emp; } }
console.log('méthode empirique (fréquence réelle) :', empK ? 'adoptée, poids du calcul = ' + empK + ' matchs' : 'pas meilleure');
console.log('réglage final (par stat) : réussite par tranche');
const calFinal = calib(final.all);
for (const [k, b] of Object.entries(calFinal)) console.log(`   ${k.padEnd(6)} annoncé ${(100 * b.announced).toFixed(1)} % → réel ${(100 * b.real).toFixed(1)} % (${b.n})`);
// Table de correction par stat : probabilité calculée → réussite réelle observée (tranches de 5 points)
const map = {};
for (const k of Object.keys(STATS)) {
  const arr = (final.byStat[k] || []).slice().sort((x, y) => x.p - y.p);
  const pts = [];
  for (let lo = 0.5; lo < 0.95; lo += 0.05) { const sel = arr.filter((o) => o.p >= lo && o.p < lo + 0.05); if (sel.length >= 150) pts.push([+(sel.reduce((t, o) => t + o.p, 0) / sel.length).toFixed(3), +(sel.filter((o) => o.win).length / sel.length).toFixed(3)]); }
  // la réussite doit monter avec la probabilité calculée (on lisse les petites inversions)
  for (let i = 1; i < pts.length; i++) if (pts[i][1] < pts[i - 1][1]) pts[i][1] = pts[i - 1][1] = +((pts[i][1] + pts[i - 1][1]) / 2).toFixed(3);
  map[k] = pts;
  console.log('   correction', k, ':', pts.map(([x, y]) => Math.round(x * 100) + '→' + Math.round(y * 100)).join(' · '));
}
const interp = (pts, p) => { if (!pts.length) return p; if (p <= pts[0][0]) return pts[0][1]; for (let i = 1; i < pts.length; i++) if (p <= pts[i][0]) { const [x0, y0] = pts[i - 1], [x1, y1] = pts[i]; return y0 + (y1 - y0) * (p - x0) / (x1 - x0); } return pts[pts.length - 1][1]; };
const corrected = Object.entries(final.byStat).flatMap(([k, arr]) => arr.map((o) => ({ p: interp(map[k], o.p), win: o.win })));
console.log('après correction : réussite par tranche');
const calCorr = calib(corrected);
for (const [kk, b] of Object.entries(calCorr)) console.log(`   ${kk.padEnd(6)} annoncé ${(100 * b.announced).toFixed(1)} % → réel ${(100 * b.real).toFixed(1)} % (${b.n})`);
const out = { updatedAt: new Date().toISOString(), props: { w10: best.w10, sdMult: statSd, shift: statShift, emp: empK, map, calibration: calCorr, tested: final.all.length }, injuries: { margin: +Math.max(0, Math.min(0.6, c)).toFixed(3), total: +Math.max(0, Math.min(0.8, cT)).toFixed(3), games: rows.length, withMissing: withMiss } };
fs.writeFileSync(path.join(ROOT, 'data', 'nba-props-params.json'), JSON.stringify(out, null, 2));
console.log('\nenregistré :', JSON.stringify(out.props.sdMult), JSON.stringify(out.injuries));
