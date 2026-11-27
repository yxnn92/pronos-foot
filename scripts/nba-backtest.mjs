// Test du modèle NBA sur les saisons passées : réussite sur le vainqueur et sur le total de points.
// Usage : node scripts/nba-backtest.mjs
import fs from 'node:fs';
import path from 'node:path';
import { loadGames, runModel, NBA_DEFAULTS, NBA_PARAMS, ROOT } from './nba-lib.mjs';

const games = await loadGames();
const done = games.filter((g) => g.completed && g.hs != null && g.stype !== 1);
console.log('matchs NBA joués :', done.length, '·', done[0]?.date.slice(0, 10), '→', done[done.length - 1]?.date.slice(0, 10));

function evaluate(P, from = '2025-01-01') {
  let n = 0, ll = 0, hit = 0, llT = 0, maeT = 0, b2bN = 0, b2bLoss = 0;
  const cal = {};
  runModel(games, P, (g, pr) => {
    if (!g.completed || g.hs == null || g.stype === 1 || g.date < from) return;
    const pH = Math.min(0.99, Math.max(0.01, pr.pH)), win = g.hs > g.as;
    ll += -Math.log(win ? pH : 1 - pH); n++;
    if ((pH >= 0.5) === win) hit++;
    const tot = g.hs + g.as; maeT += Math.abs(tot - pr.total);
    const pdf = Math.exp(-0.5 * ((tot - pr.total) / P.sigmaT) ** 2) / (P.sigmaT * Math.sqrt(2 * Math.PI)); llT += -Math.log(Math.max(pdf, 1e-9));
    const pb = Math.max(pH, 1 - pH), k = pb >= 0.8 ? '80+' : pb >= 0.7 ? '70-80' : pb >= 0.6 ? '60-70' : '50-60';
    const c = (cal[k] ||= { n: 0, w: 0, sp: 0 }); c.n++; c.sp += pb; if ((pH >= 0.5) === win) c.w++;
    if (pr.rest.b2bH !== pr.rest.b2bA) { b2bN++; if ((pr.rest.b2bA && !win) || (pr.rest.b2bH && win)) b2bLoss++; }
  });
  return { n, ll: +(ll / n).toFixed(4), acc: +(100 * hit / n).toFixed(1), maeTotal: +(maeT / n).toFixed(1), llT: +(llT / n).toFixed(3), cal, b2b: `${b2bN} matchs avec 1 seule équipe en back-to-back : elle perd ${(100 * b2bLoss / Math.max(1, b2bN)).toFixed(0)} %` };
}

const base = evaluate(NBA_PARAMS);
console.log('\nréglage de départ :', JSON.stringify({ ...base, cal: undefined }));
// Réglage automatique (un paramètre à la fois, 2 passages)
const GRID = { K: [12, 18, 24, 30], HA: [50, 70, 90], eloW: [0.3, 0.5, 0.7, 0.85], b2b: [0, 1, 1.8, 2.6], restPt: [0, 0.3, 0.6, 1], sigma: [9.5, 10, 10.5, 11, 11.5, 12.5], regress: [0.15, 0.25, 0.35], formHalf: [10, 15, 25], sigmaT: [15, 17, 19] };
let best = { ...NBA_PARAMS }, bestS = base;
const loss = (s) => s.ll + 0.15 * s.llT;
for (let pass = 0; pass < 2; pass++) for (const [k, vals] of Object.entries(GRID)) for (const v of vals) {
  if (best[k] === v) continue;
  const s = evaluate({ ...best, [k]: v });
  if (loss(s) < loss(bestS) - 1e-5) { best = { ...best, [k]: v }; bestS = s; console.log(`  mieux : ${k} = ${v} → réussite ${s.acc} %, perte ${s.ll}, total ±${s.maeTotal} pts`); }
}
console.log('\nMEILLEUR RÉGLAGE :', JSON.stringify(best));
console.log('résultat :', JSON.stringify({ ...bestS, cal: undefined }));
console.log('\nCalibration (annoncé → réel) :');
for (const [k, c] of Object.entries(bestS.cal).sort()) console.log(`  ${k.padEnd(6)} annoncé ${(100 * c.sp / c.n).toFixed(1)} % → réel ${(100 * c.w / c.n).toFixed(1)} % (${c.n} matchs)`);
console.log('\n' + bestS.b2b);
console.log('PARAMS_JSON ' + JSON.stringify(best));

// Enregistrement : on n'adopte un nouveau réglage que s'il est nettement meilleur (sinon on suit le hasard)
const gainPct = (loss(base) - loss(bestS)) / loss(base);
const adopted = gainPct >= 0.002;
const cal = Object.fromEntries(Object.entries((adopted ? bestS : base).cal).map(([k, c]) => [k, { n: c.n, announced: +(c.sp / c.n).toFixed(3), real: +(c.w / c.n).toFixed(3) }]));
fs.writeFileSync(path.join(ROOT, 'data', 'nba-params.json'), JSON.stringify({ updatedAt: new Date().toISOString(), adopted, params: adopted ? best : NBA_PARAMS, before: { ...base, cal: undefined }, after: { ...(adopted ? bestS : base), cal: undefined }, calibration: cal }, null, 2));
console.log(adopted ? 'nouveau réglage NBA enregistré' : 'réglage NBA conservé');
