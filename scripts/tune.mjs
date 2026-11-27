// Réglage automatique du modèle (lancé chaque semaine par GitHub, fichier .github/workflows/recalibrage.yml).
// On rejoue les matchs des 12 derniers mois avec différents réglages et on garde le meilleur,
// SEULEMENT s'il est nettement meilleur que le réglage actuel (sinon on suivrait le hasard d'une semaine).
// Résultat : data/params.json (lu par scripts/config.mjs) et data/calibration.json (« Les quasi-sûrs »).
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, loadData, simulate, score, calibration } from './lib-sim.mjs';
import { PARAMS } from './config.mjs';

const t0 = Date.now();
const ctx = await loadData();
const from = new Date(Date.now() - 365 * 864e5).toISOString().slice(0, 10);
const start = from < '2025-09-01' ? '2025-09-01' : from; // il faut ~8 mois d'historique avant de juger
console.log('matchs :', ctx.ev.length, '· avec cotes passées :', ctx.odds.size, '· période testée depuis', start);

const cur = { ...PARAMS, from: start };
const cache = new Map();
const evalP = (P) => {
  const key = JSON.stringify({ ...P, MODEL_WEIGHT: 0 });
  let out = cache.get(key); if (!out) { out = simulate(ctx, P); cache.set(key, out); }
  return { out, s: score(ctx, out, P.MODEL_WEIGHT) };
};

const before = evalP(cur).s;
console.log('réglage actuel :', JSON.stringify(before));

// Valeurs essayées pour chaque réglage (on part du réglage actuel et on améliore un réglage à la fois)
const GRID = {
  MODEL_WEIGHT: [0, 0.05, 0.1, 0.15, 0.2, 0.3],
  HA: [35, 50, 65],
  K: [15, 20, 25],
  eloMix: [0.4, 0.6, 0.8],
  formAlpha: [0.2, 0.3, 0.5],
  dcAlpha: [0.3, 0.5, 0.7],
};
let best = { ...cur }, bestS = before;
for (let pass = 0; pass < 2; pass++) {
  for (const [name, values] of Object.entries(GRID)) {
    for (const v of values) {
      if (best[name] === v) continue;
      const P = { ...best, [name]: v };
      const { s } = evalP(P);
      if (s.loss < bestS.loss - 1e-5) { best = P; bestS = s; console.log(`  mieux : ${name} = ${v} →`, JSON.stringify(s)); }
    }
  }
}

// On ne change que si le gain est net (≥ 0,2 % de perte en moins), pour ne pas suivre le hasard
const gain = before.loss - bestS.loss;
const adopt = gain >= 0.002 * before.loss;
const chosen = adopt ? best : cur;
const chosenS = adopt ? bestS : before;
console.log(adopt ? 'NOUVEAU RÉGLAGE ADOPTÉ' : 'réglage inchangé (gain trop faible : ' + gain.toFixed(5) + ')', JSON.stringify(chosen));

const { from: _f, ...keep } = chosen;
const params = {
  updatedAt: new Date().toISOString(),
  period: { from: start, matches: chosenS.n },
  adopted: adopt,
  params: keep,
  before: { ...before, params: Object.fromEntries(Object.keys(GRID).map((k) => [k, cur[k]])) },
  after: chosenS,
};
fs.writeFileSync(path.join(ROOT, 'data', 'params.json'), JSON.stringify(params, null, 2));

// Calibration des paris très probables avec le réglage retenu
const out = evalP(chosen).out;
fs.writeFileSync(path.join(ROOT, 'data', 'calibration.json'), JSON.stringify({ updatedAt: new Date().toISOString(), from: start, matches: out.length, bins: calibration(ctx, out, chosen.MODEL_WEIGHT) }));
console.log('terminé en', Math.round((Date.now() - t0) / 1000), 's');
