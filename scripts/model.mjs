// Modèle de pronostics : force Elo (qui gagne) + attaque/défense (combien de buts),
// puis loi de Poisson pour obtenir la probabilité de chaque score.
import { LEAGUE_START, START_DEFAULT, HOME_ADV, HOME_ADV_NAT, K_CLUB, K_EURO, MODEL_WEIGHT, VALUE_EDGE, MAX_GAP } from './config.mjs';

const MAXG = 10;
const RHO = -0.06; // correction Dixon-Coles des petits scores (0-0, 1-1 un peu plus fréquents)

function pois(k, l) { let p = Math.exp(-l); for (let i = 1; i <= k; i++) p *= l / i; return p; }

export function scoreMatrix(lh, la) {
  const m = [];
  let tot = 0;
  for (let i = 0; i <= MAXG; i++) {
    m[i] = [];
    for (let j = 0; j <= MAXG; j++) {
      let p = pois(i, lh) * pois(j, la);
      if (i === 0 && j === 0) p *= 1 - lh * la * RHO;
      else if (i === 0 && j === 1) p *= 1 + lh * RHO;
      else if (i === 1 && j === 0) p *= 1 + la * RHO;
      else if (i === 1 && j === 1) p *= 1 - RHO;
      m[i][j] = p; tot += p;
    }
  }
  for (const r of m) for (let j = 0; j < r.length; j++) r[j] /= tot;
  return m;
}

function outcome(m) {
  let h = 0, d = 0, a = 0;
  m.forEach((r, i) => r.forEach((p, j) => { if (i > j) h += p; else if (i === j) d += p; else a += p; }));
  return { h, d, a };
}

// Écart de buts attendu qui donne le même « score attendu » (victoire + ½ nul) que la cible.
function solveSupremacy(total, target) {
  let lo = -total + 0.15, hi = total - 0.15;
  for (let it = 0; it < 40; it++) {
    const s = (lo + hi) / 2;
    const o = outcome(scoreMatrix((total + s) / 2, (total - s) / 2));
    if (o.h + o.d / 2 < target) lo = s; else hi = s;
  }
  return (lo + hi) / 2;
}

// Total de buts attendu qui donne la probabilité « plus de X buts » visée.
function solveTotal(line, pOver, s) {
  let lo = Math.abs(s) + 0.3, hi = 7;
  for (let it = 0; it < 40; it++) {
    const t = (lo + hi) / 2;
    const p = overProb(scoreMatrix((t + s) / 2, (t - s) / 2), line);
    if (p < pOver) lo = t; else hi = t;
  }
  return (lo + hi) / 2;
}

function overProb(m, line) {
  let p = 0; m.forEach((r, i) => r.forEach((q, j) => { if (i + j > line) p += q; })); return p;
}

export const expScore = (dr) => 1 / (1 + Math.pow(10, -dr / 400));

// ---------- Notes Elo des clubs, calculées sur tous les matchs joués ----------
export function buildRatings(results, nationElo) {
  const elo = new Map();
  const form = new Map(); // attaque/défense pondérées (récent = plus important)
  const sorted = [...results].sort((a, b) => a.date.localeCompare(b.date));
  // Championnat national de chaque club = celui où il a joué le plus de matchs.
  const leagueCount = new Map();
  for (const r of sorted) if (LEAGUE_START[r.slug]) for (const t of [r.h, r.a]) {
    const c = leagueCount.get(t) || {}; c[r.slug] = (c[r.slug] || 0) + 1; leagueCount.set(t, c);
  }
  const startOf = (t) => {
    const c = leagueCount.get(t); if (!c) return START_DEFAULT;
    const lg = Object.keys(c).reduce((x, y) => (c[y] > c[x] ? y : x));
    return LEAGUE_START[lg];
  };
  for (const r of sorted) {
    if (r.nat) continue; // sélections : notes eloratings.net
    for (const t of [r.h, r.a]) if (!elo.has(t)) elo.set(t, startOf(t));
    const dr = elo.get(r.h) - elo.get(r.a) + (r.neutral ? 0 : HOME_ADV);
    const we = expScore(dr);
    const w = r.hs > r.as ? 1 : r.hs === r.as ? 0.5 : 0;
    const gd = Math.abs(r.hs - r.as);
    const g = gd <= 1 ? 1 : gd === 2 ? 1.5 : (11 + gd) / 8;
    const k = K_CLUB * (LEAGUE_START[r.slug] ? 1 : K_EURO);
    const delta = k * g * (w - we);
    elo.set(r.h, elo.get(r.h) + delta);
    elo.set(r.a, elo.get(r.a) - delta);
  }
  for (const r of sorted) {
    for (const [t, gf, ga] of [[r.h, r.hs, r.as], [r.a, r.as, r.hs]]) {
      const f = form.get(t) || { gf: 0, ga: 0, n: 0 };
      const decay = 0.93; // demi-vie d'environ 10 matchs
      f.gf = f.gf * decay + gf; f.ga = f.ga * decay + ga; f.n = f.n * decay + 1;
      form.set(t, f);
    }
  }
  const get = (id, nat, name) => {
    if (nat) return nationElo(name) ?? 1500;
    return elo.get(id) ?? START_DEFAULT;
  };
  return { elo, form, get };
}

function attDef(form, id) {
  const f = form.get(id);
  const base = 1.35;
  if (!f || f.n < 0.5) return { a: 1, d: 1 };
  const shrink = f.n / (f.n + 6);
  return {
    a: 1 + shrink * (f.gf / f.n / base - 1),
    d: 1 + shrink * (f.ga / f.n / base - 1),
  };
}

// Retire la marge du bookmaker.
export function fair(odds) {
  const inv = odds.map((o) => 1 / o);
  const s = inv.reduce((a, b) => a + b, 0);
  return inv.map((x) => x / s);
}

// ---------- Prédiction complète d'un match ----------
export function predict({ hId, aId, hName, aName, nat, neutral, ratings, market }) {
  const eh = ratings.get(hId, nat, hName), ea = ratings.get(aId, nat, aName);
  const adv = neutral ? 0 : nat ? HOME_ADV_NAT : HOME_ADV;
  const weModel = expScore(eh - ea + adv);
  const A = attDef(ratings.form, hId), B = attDef(ratings.form, aId);
  let total = 1.35 * (A.a * B.d + B.a * A.d) * (neutral ? 0.97 : 1);
  total = Math.min(4.2, Math.max(1.7, total));

  const sModel = solveSupremacy(total, weModel);
  const mModel = scoreMatrix((total + sModel) / 2, (total - sModel) / 2);
  const model = outcome(mModel);

  // Mélange avec le marché quand des cotes existent : plus prudent et plus fiable.
  let s = sModel, t = total, mk = null, ouGap = null;
  if (market?.ou) {
    const [po] = fair([market.ou.over, market.ou.under]);
    ouGap = Math.abs(overProb(mModel, market.ou.line) - po);
  }
  if (market?.x12) {
    const [ph, pd, pa] = fair(market.x12);
    mk = { h: ph, d: pd, a: pa };
    const we = MODEL_WEIGHT * (model.h + model.d / 2) + (1 - MODEL_WEIGHT) * (ph + pd / 2);
    if (market.ou) {
      const [po] = fair([market.ou.over, market.ou.under]);
      const tMk = solveTotal(market.ou.line, po, sModel);
      t = MODEL_WEIGHT * total + (1 - MODEL_WEIGHT) * tMk;
    }
    s = solveSupremacy(t, we);
  }
  const lh = (t + s) / 2, la = (t - s) / 2;
  const m = scoreMatrix(lh, la);
  const o = outcome(m);

  const sum = (f) => { let p = 0; m.forEach((r, i) => r.forEach((q, j) => { if (f(i, j)) p += q; })); return p; };
  const goals = {};
  for (const L of [0.5, 1.5, 2.5, 3.5, 4.5]) goals[L] = sum((i, j) => i + j > L);
  const teamGoals = { h: {}, a: {} };
  for (const L of [0.5, 1.5, 2.5]) { teamGoals.h[L] = sum((i) => i > L); teamGoals.a[L] = sum((i, j) => j > L); }
  const exact = [0, 1, 2, 3, 4].map((n) => sum((i, j) => i + j === n));
  exact.push(1 - exact.reduce((a, b) => a + b, 0));
  const btts = sum((i, j) => i > 0 && j > 0);
  const scores = [];
  m.forEach((r, i) => r.forEach((q, j) => scores.push({ s: `${i}-${j}`, p: q })));
  scores.sort((x, y) => y.p - x.p);

  return {
    elo: [Math.round(eh), Math.round(ea)],
    xg: [r2(lh), r2(la)],
    p: { h: r3(o.h), d: r3(o.d), a: r3(o.a) },
    model: { h: r3(model.h), d: r3(model.d), a: r3(model.a) },
    market: mk && { h: r3(mk.h), d: r3(mk.d), a: r3(mk.a) },
    dc: { '1N': r3(o.h + o.d), 'N2': r3(o.d + o.a), '12': r3(o.h + o.a) },
    goals: map3(goals), teamGoals: { h: map3(teamGoals.h), a: map3(teamGoals.a) },
    exact: exact.map(r3), btts: r3(btts), ouGap: ouGap == null ? null : r3(ouGap), scores: scores.slice(0, 3).map((x) => ({ s: x.s, p: r3(x.p) })),
  };
}

const r2 = (x) => Math.round(x * 100) / 100;
const r3 = (x) => Math.round(x * 1000) / 1000;
const map3 = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, r3(v)]));

// ---------- Choix des pronos, étoiles et value bets ----------
const STAR_THRESH = {
  '1N2': [0.42, 0.5, 0.6, 0.7],
  'DC': [0.7, 0.78, 0.85, 0.9],
  'Buts': [0.55, 0.62, 0.68, 0.75],
  'BTTS': [0.55, 0.62, 0.68, 0.75],
  'Value': [0.3, 0.4, 0.5, 0.6],
};
export function stars(type, p) {
  const t = STAR_THRESH[type];
  return 1 + t.filter((x) => p >= x).length;
}

export function buildPicks(pr, odds, names) {
  const picks = [];
  const lab = { h: `Victoire ${names.h}`, d: 'Match nul', a: `Victoire ${names.a}` };
  const oddIdx = { h: 0, d: 1, a: 2 };
  // 1N2 : l'issue la plus probable
  const best = ['h', 'd', 'a'].reduce((x, y) => (pr.p[y] > pr.p[x] ? y : x));
  let st = stars('1N2', pr.p[best]);
  if (pr.market && Math.abs(pr.model[best] - pr.market[best]) > 0.12) st = Math.max(1, st - 1);
  picks.push({ type: '1N2', key: best, label: lab[best], p: pr.p[best], odds: odds?.x12?.[oddIdx[best]] ?? null, stars: st });

  // Double chance
  const dcLab = { '1N': `${names.h} ou nul`, 'N2': `Nul ou ${names.a}`, '12': `${names.h} ou ${names.a}` };
  const dcKey = Object.keys(pr.dc).reduce((x, y) => (pr.dc[y] > pr.dc[x] ? y : x));
  let dcOdds = null;
  if (odds?.x12) {
    const [o1, oN, o2] = odds.x12;
    const pair = { '1N': [o1, oN], 'N2': [oN, o2], '12': [o1, o2] }[dcKey];
    dcOdds = r2(1 / (1 / pair[0] + 1 / pair[1]));
  }
  picks.push({ type: 'DC', key: dcKey, label: dcLab[dcKey], p: pr.dc[dcKey], odds: dcOdds, est: true, stars: stars('DC', pr.dc[dcKey]) });

  // Plus / moins 2,5 buts
  const over = pr.goals['2.5'] >= 0.5;
  const pG = over ? pr.goals['2.5'] : r3(1 - pr.goals['2.5']);
  let gOdds = null;
  if (odds?.ou && odds.ou.line === 2.5) gOdds = over ? odds.ou.over : odds.ou.under;
  picks.push({ type: 'Buts', key: over ? 'o2.5' : 'u2.5', label: over ? 'Plus de 2,5 buts' : 'Moins de 2,5 buts', p: pG, odds: gOdds, stars: stars('Buts', pG) });

  // Les deux équipes marquent
  const yes = pr.btts >= 0.5;
  const pB = yes ? pr.btts : r3(1 - pr.btts);
  picks.push({ type: 'BTTS', key: yes ? 'yes' : 'no', label: yes ? 'Les deux équipes marquent' : 'Une équipe ne marque pas', p: pB, odds: null, stars: stars('BTTS', pB) });

  // Value bets : notre probabilité × la cote ≥ 1,05
  if (odds?.x12) {
    for (const k of ['h', 'd', 'a']) {
      const o = odds.x12[oddIdx[k]], p = pr.p[k];
      // Un très gros désaccord avec le marché vient souvent d'une info que le modèle n'a pas
      // (blessés, rotation) : on ne le compte pas comme value.
      const gap = pr.market ? Math.abs(pr.model[k] - pr.market[k]) : 0;
      if (o && o <= 6 && p >= 0.2 && gap <= MAX_GAP && p * o >= 1 + VALUE_EDGE) {
        picks.push({ type: 'Value', key: k, label: lab[k], p, odds: o, edge: r3(p * o - 1), stars: stars('Value', p) });
      }
    }
  }
  if (odds?.ou) {
    const { line, over: oo, under: ou } = odds.ou;
    if (pr.goals[String(line)] != null && (pr.ouGap ?? 0) <= 0.1) {
      const po = pr.goals[String(line)], pu = 1 - po;
      const L = String(line).replace('.', ',');
      if (oo <= 6 && po * oo >= 1 + VALUE_EDGE) picks.push({ type: 'Value', key: `o${line}`, label: `Plus de ${L} buts`, p: r3(po), odds: oo, edge: r3(po * oo - 1), stars: stars('Value', po) });
      if (ou <= 6 && pu * ou >= 1 + VALUE_EDGE) picks.push({ type: 'Value', key: `u${line}`, label: `Moins de ${L} buts`, p: r3(pu), odds: ou, edge: r3(pu * ou - 1), stars: stars('Value', pu) });
    }
  }
  return picks;
}

// Corrige un prono une fois le match terminé (score à la fin du temps réglementaire).
export function grade(pick, hs, as) {
  const tot = hs + as;
  const res = hs > as ? 'h' : hs === as ? 'd' : 'a';
  switch (pick.type) {
    case '1N2': return pick.key === res;
    case 'DC': return { '1N': res !== 'a', 'N2': res !== 'h', '12': res !== 'd' }[pick.key];
    case 'BTTS': return pick.key === 'yes' ? hs > 0 && as > 0 : !(hs > 0 && as > 0);
    case 'Buts':
    case 'Value': {
      if (/^[oub]/.test(pick.key) && pick.key.length > 1 && !['h', 'd', 'a'].includes(pick.key)) {
        const line = parseFloat(pick.key.slice(1));
        return pick.key[0] === 'o' ? tot > line : tot < line;
      }
      return pick.key === res;
    }
  }
  return null;
}
