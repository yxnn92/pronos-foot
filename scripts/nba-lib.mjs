// NBA : récupération des matchs (ESPN) et modèle de pronostic.
// Le modèle compare : force des équipes (Elo avec écart de points), attaque/défense (points marqués/encaissés),
// avantage du terrain, fatigue (back-to-back), avantage de repos, blessés, forme. Réglages dans NBA_DEFAULTS.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CACHE = path.join(ROOT, 'data', 'cache');
export const NBA = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba';
const H = 3600e3, D = 24 * H;

// Réglés par le test sur 2 439 matchs (oct. 2024 → nov. 2026) : 66,9 % de bons vainqueurs, probabilités bien calibrées.
// Remplacés chaque lundi par le recalibrage automatique (data/nba-params.json).
export const NBA_DEFAULTS = {
  K: 30,           // vitesse de mise à jour de l'Elo
  HA: 50,          // avantage du terrain (points Elo ≈ 1,8 point)
  ELO_PT: 28,      // points Elo par point d'écart
  eloW: 0.85,      // écart prévu : part Elo (le reste : attaque/défense)
  b2b: 1,          // pénalité back-to-back (points) — effet réel mais faible (46 % de victoires)
  restPt: 0.3,     // avantage par jour de repos en plus (plafonné à 2 jours d'écart)
  sigma: 10.5,     // dispersion de l'écart final (points)
  sigmaT: 19,      // dispersion du total de points
  regress: 0.35,   // retour vers la moyenne à chaque nouvelle saison
  formHalf: 15,    // demi-vie (matchs) des moyennes attaque/défense
};
let tunedNba = {};
try { tunedNba = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'nba-params.json'), 'utf8')).params || {}; } catch (e) {}
export const NBA_PARAMS = { ...NBA_DEFAULTS, ...tunedNba };

export async function getJSON(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url, { signal: AbortSignal.timeout(30000), headers: { 'user-agent': 'Mozilla/5.0 (pronos perso)' } }); if (r.ok) return await r.json(); } catch {}
    await new Promise((res) => setTimeout(res, 1000 * (i + 1)));
  }
  return null;
}
export const readJSON = (f, def) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return def; } };
export const writeJSON = (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o)); };

// ---------- matchs ----------
const teamOf = (c) => ({ id: c.team?.id, abbr: c.team?.abbreviation, name: c.team?.displayName, short: c.team?.shortDisplayName, logo: (c.team?.logo || '').replace('/scoreboard/', '/') || `https://a.espncdn.com/i/teamlogos/nba/500/${(c.team?.abbreviation || '').toLowerCase()}.png` });
export function parseGame(e) {
  const c = e.competitions?.[0]; if (!c) return null;
  const h = c.competitors?.find((x) => x.homeAway === 'home'), a = c.competitors?.find((x) => x.homeAway === 'away');
  if (!h || !a) return null;
  const st = e.status?.type || {};
  const head = (c.notes || []).map((n) => n.headline).filter(Boolean).join(' · ');
  const rec = (t, type) => t.records?.find((r) => r.type === type)?.summary || null;
  return {
    id: e.id, date: e.date, season: e.season?.year, stype: e.season?.type, neutral: !!c.neutralSite,
    state: st.state, completed: !!st.completed, detail: st.shortDetail || st.detail, period: e.status?.period, clock: e.status?.displayClock,
    h: teamOf(h), a: teamOf(a),
    hs: h.score != null && h.score !== '' ? +h.score : null, as: a.score != null && a.score !== '' ? +a.score : null,
    lines: { h: (h.linescores || []).map((x) => x.value), a: (a.linescores || []).map((x) => x.value) },
    rec: { h: { all: rec(h, 'total'), home: rec(h, 'home'), road: rec(h, 'road') }, a: { all: rec(a, 'total'), home: rec(a, 'home'), road: rec(a, 'road') } },
    cup: /NBA Cup/i.test(head), note: head || null,
    series: c.series ? { summary: c.series.summary, title: c.series.title || null } : null,
  };
}

// Tous les matchs depuis octobre 2024 (les mois terminés sont gardés en cache)
export async function loadGames(now = Date.now()) {
  const out = []; const months = [];
  for (let d = new Date(Date.UTC(2024, 9, 1)); d.getTime() <= now + 3 * D; d.setUTCMonth(d.getUTCMonth() + 1)) months.push(`${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  for (const m of months) {
    const y = +m.slice(0, 4), mo = +m.slice(4) - 1;
    const monthEnd = Date.UTC(y, mo + 1, 1);
    if (mo >= 6 && mo <= 8) continue; // pas de NBA en juillet-septembre (hors été)
    const f = path.join(CACHE, `nba-${m}.json`);
    const done = monthEnd < now - 3 * D;
    let games = done ? readJSON(f, null) : null;
    if (!games) {
      const j = await getJSON(`${NBA}/scoreboard?dates=${m}&limit=500`);
      games = (j?.events || []).map(parseGame).filter(Boolean);
      if (done && games.length) writeJSON(f, games);
    }
    out.push(...games);
  }
  const seen = new Set();
  return out.filter((g) => !seen.has(g.id) && seen.add(g.id)).sort((a, b) => a.date.localeCompare(b.date));
}

// ---------- outils statistiques ----------
export function phi(x) { // fonction de répartition de la loi normale
  const t = 1 / (1 + 0.2316419 * Math.abs(x)), d = 0.3989423 * Math.exp(-x * x / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}
const r3 = (x) => Math.round(x * 1000) / 1000;

// ---------- modèle : on rejoue tous les matchs dans l'ordre ----------
// onGame(g, pred) est appelé AVANT la mise à jour (le modèle ne connaît que le passé).
export function runModel(games, P = NBA_DEFAULTS, onGame = null) {
  const elo = new Map(), off = new Map(), def = new Map(), last = new Map(), seasonOf = new Map(), recent = new Map();
  let lg = 114; // points moyens par équipe
  const decay = Math.pow(0.5, 1 / P.formHalf);
  const ew = (m, t, v) => { const x = m.get(t) || { s: 0, n: 0 }; m.set(t, { s: x.s * decay + v, n: x.n * decay + 1 }); };
  const avg = (m, t) => { const x = m.get(t); if (!x || x.n < 0.5) return lg; const sh = x.n / (x.n + 5); return lg + sh * (x.s / x.n - lg); };
  const state = { elo, off, def, last, recent, get lg() { return lg; } };

  const predict = (g) => {
    for (const t of [g.h.id, g.a.id]) {
      if (!elo.has(t)) elo.set(t, 1500);
      if (seasonOf.get(t) !== g.season) { if (seasonOf.has(t)) elo.set(t, 1500 + (elo.get(t) - 1500) * (1 - P.regress)); seasonOf.set(t, g.season); }
    }
    const t0 = Date.parse(g.date);
    const rest = (t) => (last.has(t) ? Math.floor((t0 - last.get(t)) / D + 0.25) - 1 : 3); // jours de repos complets
    const rh = Math.max(0, Math.min(5, rest(g.h.id))), ra = Math.max(0, Math.min(5, rest(g.a.id)));
    const ha = g.neutral ? 0 : P.HA;
    const eloMargin = (elo.get(g.h.id) - elo.get(g.a.id) + ha) / P.ELO_PT;
    const oh = avg(off, g.h.id), dh = avg(def, g.h.id), oa = avg(off, g.a.id), da = avg(def, g.a.id);
    const ptsH = (oh + da) / 2, ptsA = (oa + dh) / 2;
    const ptsMargin = ptsH - ptsA + (g.neutral ? 0 : P.HA / P.ELO_PT);
    let margin = P.eloW * eloMargin + (1 - P.eloW) * ptsMargin;
    // fatigue et repos
    const b2bH = rh === 0, b2bA = ra === 0;
    margin += (b2bA ? P.b2b : 0) - (b2bH ? P.b2b : 0);
    margin += P.restPt * Math.max(-2, Math.min(2, rh - ra));
    const total = ptsH + ptsA - (b2bH ? 0.8 : 0) - (b2bA ? 0.8 : 0);
    return { margin, total, pH: phi(margin / P.sigma), rest: { h: rh, a: ra, b2bH, b2bA }, elo: [Math.round(elo.get(g.h.id)), Math.round(elo.get(g.a.id))], off: [oh, oa], def: [dh, da] };
  };

  for (const g of games) {
    if (!g.completed || g.hs == null || g.stype === 1) { if (onGame) onGame(g, predict(g), state); continue; }
    const pr = predict(g);
    if (onGame) onGame(g, pr, state);
    // mise à jour Elo avec l'écart de points (formule FiveThirtyEight)
    const diff = g.hs - g.as, we = 1 / (1 + Math.pow(10, -(elo.get(g.h.id) - elo.get(g.a.id) + (g.neutral ? 0 : P.HA)) / 400));
    const eloDiff = (diff > 0 ? 1 : -1) * (elo.get(g.h.id) - elo.get(g.a.id) + (g.neutral ? 0 : P.HA));
    const mult = Math.pow(Math.abs(diff) + 3, 0.8) / (7.5 + 0.006 * eloDiff);
    const delta = P.K * mult * ((diff > 0 ? 1 : 0) - we);
    elo.set(g.h.id, elo.get(g.h.id) + delta); elo.set(g.a.id, elo.get(g.a.id) - delta);
    ew(off, g.h.id, g.hs); ew(def, g.h.id, g.as); ew(off, g.a.id, g.as); ew(def, g.a.id, g.hs);
    lg = lg * 0.995 + 0.005 * (g.hs + g.as) / 2;
    const t0 = Date.parse(g.date); last.set(g.h.id, t0); last.set(g.a.id, t0);
    for (const [t, w] of [[g.h.id, diff > 0], [g.a.id, diff < 0]]) { const l = recent.get(t) || []; l.unshift({ w, d: g.date, s: t === g.h.id ? `${g.hs}-${g.as}` : `${g.as}-${g.hs}`, opp: t === g.h.id ? g.a.abbr : g.h.abbr, home: t === g.h.id }); recent.set(t, l.slice(0, 10)); }
  }
  return state;
}

export const overProb = (total, line, sigmaT) => 1 - phi((line - total) / sigmaT);
export { r3 };
