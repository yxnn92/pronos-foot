// Mise à jour complète du site : récupère les données ESPN, calcule les pronos,
// met à jour l'historique. Lancé automatiquement par GitHub (aucune IA, 0 crédit).
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DISPLAY, RATING_ONLY, STANDINGS, DAYS_AHEAD, DAYS_BACK } from './config.mjs';
import { buildRatings, predict, buildPicks, grade } from './model.mjs';
import { extractStats, STAT_SLUGS } from './collect.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const CACHE = path.join(DATA, 'cache');
const SITE = 'https://site.api.espn.com/apis/site/v2/sports/soccer';
const STAND = 'https://site.api.espn.com/apis/v2/sports/soccer';
const NOW = Date.now();
const H = 3600e3, D = 24 * H;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ---------- outils ----------
async function getJSON(url, tries = 3) {
  for (let i = 1; i <= tries; i++) {
    try {
      const r = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (pronos-foot perso)' }, signal: AbortSignal.timeout(30000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      if (i === tries) { log('échec', url, e.message); return null; }
      await new Promise((res) => setTimeout(res, 1500 * i));
    }
  }
}
async function getText(url) {
  try { const r = await fetch(url, { signal: AbortSignal.timeout(30000) }); return r.ok ? await r.text() : null; } catch { return null; }
}
async function pool(items, n, fn) {
  const out = []; let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } }));
  return out;
}
async function readJSON(f, def) { try { return JSON.parse(await fs.readFile(f, 'utf8')); } catch { return def; } }
async function writeJSON(f, obj) { await fs.mkdir(path.dirname(f), { recursive: true }); await fs.writeFile(f, JSON.stringify(obj)); }
const amToDec = (s) => {
  if (s == null || s === '' || s === 'EVEN') return s === 'EVEN' ? 2 : null;
  const v = parseFloat(String(s).replace('+', ''));
  if (!isFinite(v) || v === 0) return null;
  return Math.round((v > 0 ? 1 + v / 100 : 1 + 100 / -v) * 100) / 100;
};
// Cote anglaise « 8/15 » → cote européenne 1,53
const fracToDec = (s) => {
  const m = /^(\d+)\/(\d+)$/.exec(String(s || '').trim());
  if (m) return Math.round((1 + +m[1] / +m[2]) * 100) / 100;
  if (/^evs?$/i.test(String(s || '').trim())) return 2;
  const v = parseFloat(s); return isFinite(v) && v > 1 ? v : null;
};
const SUMMARY_VERSION = 2; // à augmenter quand on extrait de nouvelles infos (force le rechargement)
// ---------- cotes « France » ----------
// Comparaison faite le 25/11/2026 sur 9 matchs de LDC : Betclic reverse ≈ 91 % des mises sur le 1N2, Bet365 ≈ 94,4 %.
// On garde les probabilités du marché (sans marge) et on applique le taux de retour français.
const FR_PAYOUT = 0.91;
const FR_SCORER = 0.86; // Raphinha buteur : 1,53 chez Bet365, 1,31 chez Betclic
const r2 = (x) => Math.round(x * 100) / 100;
function toFr(odds) {
  if (!odds?.length || odds.some((o) => !o)) return null;
  const inv = odds.map((o) => 1 / o), s = inv.reduce((a, b) => a + b, 0);
  return inv.map((x) => r2(Math.max(1.01, FR_PAYOUT / (x / s))));
}
const frScorer = (o) => r2(Math.max(1.01, o * FR_SCORER));
const PLAYER_EDGE = 0.1;   // value buteur si probabilité × cote ≥ 1,10 (marges plus fortes sur ce marché)
const logo = (t) => t?.logo || t?.logos?.[0]?.href || (t?.id ? `https://a.espncdn.com/i/teamlogos/soccer/500/${t.id}.png` : '');

// ---------- 1. calendriers et résultats ----------
const ALL = [
  ...DISPLAY.map((c) => ({ ...c, show: true })),
  ...RATING_ONLY.map((c) => ({ ...c, type: 'league', show: false })),
];
const thisYear = new Date(NOW).getUTCFullYear();
const years = [thisYear - 1, thisYear];
if (new Date(NOW + DAYS_AHEAD * D).getUTCFullYear() > thisYear) years.push(thisYear + 1);

function parseEvent(e, comp) {
  const c = e.competitions?.[0];
  if (!c) return null;
  const home = c.competitors?.find((x) => x.homeAway === 'home'), away = c.competitors?.find((x) => x.homeAway === 'away');
  if (!home || !away) return null;
  const st = e.status?.type || {};
  const team = (x) => ({ id: x.team?.id, name: x.team?.displayName, short: x.team?.shortDisplayName || x.team?.displayName, abbr: x.team?.abbreviation, logo: logo(x.team) });
  return {
    id: e.id, slug: comp.slug, date: e.date, season: e.season?.year,
    state: st.state, completed: !!st.completed, status: st.name, detail: st.shortDetail || st.detail,
    neutral: !!c.neutralSite, h: team(home), a: team(away),
    hs: home.score != null && home.score !== '' ? Number(home.score) : null,
    as: away.score != null && away.score !== '' ? Number(away.score) : null,
  };
}

async function loadCompetition(comp) {
  const events = [];
  let leagueLogo = '';
  for (const y of years) {
    const cacheFile = path.join(CACHE, `${comp.slug}-${y}.json`);
    // Les années terminées ne changent plus : on les garde en cache.
    if (y < thisYear) {
      const cached = await readJSON(cacheFile, null);
      if (cached) { events.push(...cached.events); leagueLogo ||= cached.logo; continue; }
    }
    const j = await getJSON(`${SITE}/${comp.slug}/scoreboard?dates=${y}&limit=1000`);
    if (!j) continue;
    const evs = (j.events || []).map((e) => parseEvent(e, comp)).filter(Boolean);
    const lg = j.leagues?.[0]?.logos?.[0]?.href || '';
    leagueLogo ||= lg;
    events.push(...evs);
    if (y < thisYear) await writeJSON(cacheFile, { logo: lg, events: evs });
  }
  return { comp, events, leagueLogo };
}

// ---------- 2. notes des sélections (eloratings.net) ----------
const norm = (s) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\band\b|&/g, '').replace(/[^a-z]/g, '');
const NAT_ALIAS = { czechia: 'czechrepublic', turkiye: 'turkey', republicofireland: 'ireland', cotedivoire: 'ivorycoast', korearepublic: 'southkorea', usa: 'unitedstates', bosniaherzegovina: 'bosniaherzegovina', northmacedonia: 'northmacedonia', capeverdeislands: 'capeverde' };
async function loadNationElo() {
  const [world, names] = await Promise.all([getText('https://www.eloratings.net/World.tsv'), getText('https://www.eloratings.net/en.teams.tsv')]);
  const byCode = new Map(), byName = new Map();
  if (world) for (const line of world.split('\n')) { const c = line.split('\t'); if (c[2] && c[3]) byCode.set(c[2], Number(c[3])); }
  if (names) for (const line of names.split('\n')) {
    const c = line.split('\t'); const code = c[0];
    for (const n of c.slice(1)) if (n && byCode.has(code)) byName.set(norm(n), byCode.get(code));
  }
  log('sélections notées :', byName.size);
  return (name) => { const k = norm(name); return byName.get(k) ?? byName.get(NAT_ALIAS[k] || '') ?? null; };
}

// ---------- 3. détails d'un match (cotes, compos, forme, buteurs) ----------
function extractSummary(s) {
  if (!s) return null;
  const out = { v: SUMMARY_VERSION, odds: {}, form: {}, leaders: {}, lineup: {}, scorers: [] };
  for (const o of s.odds || []) {
    const name = o.provider?.name || '';
    if (/bet ?365/i.test(name)) {
      const h = o.homeTeamOdds?.odds?.value, a = o.awayTeamOdds?.odds?.value, d = o.drawOdds?.value;
      if (h && a && d) out.odds.b365 = [h, d, a].map(Number);
      // Cotes buteur Bet365 : à tout moment, premier buteur
      const po = o.bettingOdds?.playerOdds || {};
      const first = new Map((po.preMatchFirstGoalScorer || []).map((x) => [x.player, fracToDec(x.value)]));
      out.scorers = (po.preMatchAnyTimeGoalScorer || [])
        .map((x) => ({ name: x.player, o: fracToDec(x.value), first: first.get(x.player) || null }))
        .filter((x) => x.name && x.o)
        .sort((a, b) => a.o - b.o);
    }
  }
  const dk = (s.pickcenter || []).find((p) => /draftkings/i.test(p.provider?.name || '')) || (s.pickcenter || [])[0];
  if (dk?.moneyline) {
    const ml = dk.moneyline;
    const close = [ml.home?.close?.odds, ml.draw?.close?.odds, ml.away?.close?.odds].map(amToDec);
    const open = [ml.home?.open?.odds, ml.draw?.open?.odds, ml.away?.open?.odds].map(amToDec);
    if (close.every(Boolean)) out.odds.dk = close;
    if (open.every(Boolean)) out.odds.dkOpen = open;
  }
  if (dk?.total?.over?.close) {
    const line = parseFloat(String(dk.total.over.close.line || dk.overUnder).replace(/[ou]/, ''));
    const over = amToDec(dk.total.over.close.odds), under = amToDec(dk.total.under?.close?.odds);
    if (isFinite(line) && over && under) out.odds.ou = { line, over, under };
  }
  for (const f of s.lastFiveGames || []) {
    out.form[f.team?.id] = (f.events || []).map((e) => ({
      d: e.gameDate, res: e.gameResult, score: e.score, opp: e.opponent?.displayName, oppLogo: e.opponent?.logo,
      ha: e.atVs === '@' ? 'ext' : 'dom', comp: e.leagueAbbreviation || e.leagueName,
    })).sort((a, b) => (b.d || '').localeCompare(a.d || '')); // le plus récent d'abord
  }
  for (const L of s.leaders || []) {
    const tid = L.team?.id; if (!tid) continue;
    const row = {};
    for (const cat of L.leaders || []) {
      if (!/goals|assists/i.test(cat.name)) continue;
      row[/goals/i.test(cat.name) ? 'g' : 'a'] = (cat.leaders || []).map((x) => {
        const m = /Matches:\s*(\d+)/.exec(x.displayValue || ''), v = /(Goals|Assists):\s*(\d+)/.exec(x.displayValue || '');
        return { id: x.athlete?.id, name: x.athlete?.displayName, m: m ? +m[1] : null, v: v ? +v[2] : Number(x.value) || 0 };
      });
    }
    out.leaders[tid] = row;
  }
  for (const r of s.rosters || []) {
    const tid = r.team?.id; if (!tid || !r.roster?.length) continue;
    out.lineup[tid] = {
      formation: r.formation || '',
      xi: r.roster.filter((p) => p.starter).map((p) => ({ id: p.athlete?.id, name: p.athlete?.displayName, pos: p.position?.abbreviation, n: p.jersey })),
      subs: r.roster.filter((p) => !p.starter).map((p) => ({ id: p.athlete?.id, name: p.athlete?.displayName })),
    };
  }
  return out;
}

// ---------- 4. joueurs décisifs ----------
// Retrouve la cote buteur d'un joueur (les noms ESPN et Bet365 peuvent différer un peu).
function scorerOdds(name, scorers) {
  if (!scorers?.length || !name) return null;
  const n = norm(name);
  let hit = scorers.find((s) => norm(s.name) === n);
  if (!hit) {
    const last = norm(name.split(' ').slice(-1)[0]);
    const cands = scorers.filter((s) => norm(s.name.split(' ').slice(-1)[0]) === last);
    if (cands.length === 1) hit = cands[0];
  }
  return hit || null;
}

// ---------- 4 bis. blessés et suspendus ----------
// Premier League : API officielle du jeu Fantasy Premier League (gratuite, publique).
async function loadFpl() {
  const j = await getJSON('https://fantasy.premierleague.com/api/bootstrap-static/');
  if (!j?.elements) { log('FPL indisponible'); return []; }
  const teams = new Map(j.teams.map((t) => [t.id, t.name]));
  const kinds = { i: 'blessé', d: 'incertain', s: 'suspendu' };
  const out = j.elements.filter((p) => kinds[p.status]).map((p) => ({
    team: teams.get(p.team), name: `${p.first_name} ${p.second_name}`, alt: p.web_name, kind: kinds[p.status],
    chance: p.chance_of_playing_next_round, info: frNews(p.news || ''), src: 'Fantasy Premier League',
  }));
  log('FPL : joueurs absents ou incertains', out.length);
  return out;
}
// Traduction des infos FPL (anglais) en français
const MONTHS = { Jan: 'janv.', Feb: 'févr.', Mar: 'mars', Apr: 'avr.', May: 'mai', Jun: 'juin', Jul: 'juil.', Aug: 'août', Sep: 'sept.', Oct: 'oct.', Nov: 'nov.', Dec: 'déc.' };
const BODY = { knee: 'genou', calf: 'mollet', hamstring: 'ischio-jambiers', thigh: 'cuisse', ankle: 'cheville', foot: 'pied', groin: 'aine', shoulder: 'épaule', back: 'dos', achilles: "tendon d'Achille", hip: 'hanche', muscle: 'musculaire', head: 'tête', knock: 'coup', hand: 'main', wrist: 'poignet', toe: 'orteil', rib: 'côtes', neck: 'cou', leg: 'jambe', heel: 'talon', abdominal: 'abdominaux', quad: 'quadriceps', adductor: 'adducteurs', arm: 'bras', chest: 'poitrine', face: 'visage', concussion: 'commotion', muscular: 'musculaire', unspecified: 'non précisée', foot_: 'pied' };
function frNews(t) {
  return t
    .replace(/(\w+) injury/gi, (m, b) => (BODY[b.toLowerCase()] ? `blessure (${BODY[b.toLowerCase()]})` : `blessure (${b})`))
    .replace(/Knock/gi, 'coup').replace(/Illness/gi, 'malade').replace(/Suspended until/gi, 'suspendu jusqu\'au').replace(/Suspended/gi, 'suspendu')
    .replace(/Expected back (\d+) (\w{3})/gi, (m, d, mo) => `retour prévu le ${d} ${MONTHS[mo] || mo}`)
    .replace(/Unknown return date/gi, 'date de retour inconnue')
    .replace(/(\d+)% chance of playing/gi, '$1 % de chances de jouer')
    .replace(/Has joined (.+?) permanently/gi, 'a rejoint $1').replace(/on loan/gi, 'en prêt').replace(/International duty/gi, 'en sélection')
    .replace(/Lack of match fitness/gi, 'manque de rythme').replace(/Personal reasons/gi, 'raisons personnelles');
}
const TEAM_ALIAS = { spurs: 'tottenham', nottmforest: 'nottingham', manutd: 'manchesterunited', mancity: 'manchestercity', wolves: 'wolverhampton', sheffieldutd: 'sheffieldunited' };
function sameTeam(fplName, t) {
  const n = norm(fplName), a = TEAM_ALIAS[n] || n;
  return [norm(t.name), norm(t.short)].some((c) => c && (c === n || c.includes(a) || a.includes(c)));
}
const samePlayer = (name, abs) => {
  const n = norm(name), last = norm(name.split(' ').slice(-1)[0]);
  return norm(abs.name) === n || norm(abs.alt || '') === n || (last.length > 3 && (norm(abs.name).endsWith(last) || norm(abs.alt || '') === last));
};
// Cartons rouges : lus dans les temps forts ESPN du dernier match de l'équipe dans la même compétition.
function redCards(summary) {
  return (summary?.keyEvents || []).filter((k) => /red-card/.test(k.type?.type || '')) // rouge direct ou 2e jaune
    .map((k) => ({ team: k.team?.id, name: k.participants?.[0]?.athlete?.displayName, clock: k.clock?.displayValue }))
    .filter((x) => x.team && x.name);
}

// Impact des absences sur l'attaque : part des buts (+ ½ passes) de l'équipe qui manque.
// Le remplaçant compense environ la moitié → baisse des buts attendus = ½ × part manquante (plafonnée).
// Réglage prudent, non testé sur le passé (pas d'historique des compos) : effet volontairement modéré.
function absenceImpact(teamId, leaders, lineup, absents, teamStats) {
  const L = leaders?.[teamId];
  if (!L || !teamStats?.gf) return { f: 1, who: [] };
  const byId = new Map();
  for (const kind of ['g', 'a']) for (const p of L[kind] || []) {
    if (!p.id || !p.v) continue;
    const x = byId.get(p.id) || { id: p.id, name: p.name, g: 0, a: 0 };
    x[kind] = p.v; byId.set(p.id, x);
  }
  const xi = lineup?.[teamId]?.xi?.map((p) => p.id), subs = lineup?.[teamId]?.subs?.map((p) => p.id);
  let lost = 0; const who = [];
  for (const p of byId.values()) {
    const abs = absents.find((a) => samePlayer(p.name, a));
    let miss = 0, why = '';
    if (xi?.length) { if (!xi.includes(p.id)) { miss = subs?.includes(p.id) ? 0.7 : 1; why = subs?.includes(p.id) ? 'remplaçant' : 'absent de la compo'; } }
    else if (abs) { miss = abs.kind === 'incertain' ? 1 - (abs.chance ?? 50) / 100 : 1; why = abs.kind; }
    if (miss > 0) {
      const share = Math.min(1, (p.g + 0.5 * p.a) / (teamStats.gf + 6)); // +6 : amortit les petits échantillons (début de LDC…)
      lost += miss * share;
      who.push({ name: p.name, g: p.g, a: p.a, why, share: r3(miss * share) });
    }
  }
  lost = Math.min(lost, 0.6);
  // Backtest sur ~5 000 cas (25/11/2026) : aucun effet mesurable des buteurs absents sur les buts marqués
  // (rotations, remplaçants). On n'ajuste donc plus le prono : f = 1. On garde la liste pour l'affichage.
  return { f: 1, who, lost: r3(lost) };
}

const de = (n) => (/^[aeiouyhéèâî]/i.test(n) ? `d'${n}` : `de ${n}`);
// ---------- combiné du jour ----------
// Le plus probable possible pour une cote totale entre 1,85 et 2,50 (cotes France estimées),
// 2 à 4 paris sur des matchs différents, parmi 1N2 / double chance / buts.
const boring = (l) => (l.type === 'DC' && l.key === '12') || (l.type === 'Buts' && /^u/.test(l.key || ''));
function dailyCombo(ms) {
  const legs = [];
  for (const m of ms) {
    const cands = m.picks.filter((p) => ['1N2', 'DC', 'Buts'].includes(p.type) && p.odds && p.odds >= 1.12 && p.p >= 0.55)
      .sort((a, b) => b.p - a.p).slice(0, 2);
    for (const p of cands) legs.push({ mid: m.id, type: p.type, key: p.key, label: p.label, p: p.p, odds: p.odds, est: !!p.est, match: `${m.h.short} - ${m.a.short}`, date: m.date, slug: m.slug });
  }
  legs.sort((a, b) => b.p - a.p);
  const L = legs.slice(0, 24);
  let best = null;
  const rec = (start, chosen, o, p) => {
    if (chosen.length >= 2 && o >= 1.85 && o <= 2.5 && (!best || p > best.p)) best = { legs: [...chosen], odds: o, p };
    if (chosen.length === 4 || o > 2.5) return;
    for (let i = start; i < L.length; i++) {
      if (chosen.some((c) => c.mid === L[i].mid)) continue;
      // au plus 1 pari « moins de … buts » ou « X ou Y » (peu intéressants) par combiné
      if (boring(L[i]) && chosen.some(boring)) continue;
      if (L[i].type === 'Buts' && chosen.some((c) => c.type === 'Buts')) continue; // 1 pari de buts maximum
      chosen.push(L[i]); rec(i + 1, chosen, o * L[i].odds, p * L[i].p); chosen.pop();
    }
  };
  rec(0, [], 1, 1);
  if (!best) return null;
  best.legs.sort((a, b) => a.date.localeCompare(b.date));
  return { legs: best.legs, odds: r2(best.odds), p: r3(best.p) };
}

// ---------- séries et tendances (toutes compétitions, du plus récent au plus ancien) ----------
function teamTrends(team, hist, venue) {
  const n = team.short, out = [];
  const res = (r) => { const me = r.h.id === team.id; const f = me ? r.hs : r.as, a = me ? r.as : r.hs; return { f, a, w: f > a, d: f === a, l: f < a, home: me, tot: r.hs + r.as }; };
  const L = hist.map(res);
  const streak = (pred) => { let k = 0; for (const x of L) { if (pred(x)) k++; else break; } return k; };
  const countIn = (k, pred) => L.slice(0, k).filter(pred).length;
  const add = (score, text, kind) => out.push({ score, text, kind });
  if (L.length < 4) return out;
  const w = streak((x) => x.w), unb = streak((x) => !x.l), lo = streak((x) => x.l), winless = streak((x) => !x.w);
  const sc = streak((x) => x.f > 0), cs = streak((x) => x.a === 0), noSc = countIn(5, (x) => x.f === 0);
  const o25 = countIn(6, (x) => x.tot > 2.5), btts = countIn(6, (x) => x.f > 0 && x.a > 0);
  if (w >= 3) add(w * 2, `${n} reste sur ${w} victoires de suite`, 'up');
  else if (unb >= 5) add(unb * 1.4, `${n} invaincu depuis ${unb} matchs`, 'up');
  if (lo >= 3) add(lo * 2, `${n} reste sur ${lo} défaites de suite`, 'down');
  else if (winless >= 4) add(winless * 1.4, `${n} sans victoire depuis ${winless} matchs`, 'down');
  if (sc >= 6) add(sc, `${n} a marqué lors de ses ${sc} derniers matchs`, 'goals');
  if (noSc >= 3) add(noSc * 2, `${n} n'a pas marqué dans ${noSc} de ses 5 derniers matchs`, 'nogoals');
  if (cs >= 3) add(cs * 2, `${n} n'a pas encaissé de but depuis ${cs} matchs`, 'nogoals');
  if (o25 >= 5) add(o25 + 1, `${o25} des 6 derniers matchs ${de(n)} : plus de 2,5 buts`, 'goals');
  if (o25 <= 1) add(6 - o25, `${6 - o25} des 6 derniers matchs ${de(n)} : moins de 2,5 buts`, 'nogoals');
  if (btts >= 5) add(btts, `Les deux équipes ont marqué dans ${btts} des 6 derniers matchs ${de(n)}`, 'goals');
  if (btts <= 1) add(5 - btts, `Une seule équipe (ou aucune) a marqué dans ${6 - btts} des 6 derniers matchs ${de(n)}`, 'nogoals');
  // à domicile / à l'extérieur
  const V = L.filter((x) => x.home === (venue === 'h')).slice(0, 8);
  const vs = (pred) => { let k = 0; for (const x of V) { if (pred(x)) k++; else break; } return k; };
  const vu = vs((x) => !x.l), vl = vs((x) => x.l), vw = vs((x) => x.w);
  const where = venue === 'h' ? 'à domicile' : "à l'extérieur";
  if (vw >= 4) add(vw * 1.8, `${n} a gagné ses ${vw} derniers matchs ${where}`, 'up');
  else if (vu >= 6) add(vu * 1.2, `${n} invaincu ${where} depuis ${vu} matchs`, 'up');
  if (vl >= 3) add(vl * 1.8, `${n} a perdu ses ${vl} derniers matchs ${where}`, 'down');
  return out;
}

// ---------- explication du prono en une phrase ----------
function explain(e, pr, picks, hHist, aHist, imp, h2h) {
  const mp = picks.find((p) => p.type === '1N2');
  const form = (hist, t) => { const l = hist.slice(0, 5).map((r) => { const me = r.h.id === t.id; const f = me ? r.hs : r.as, a = me ? r.as : r.hs; return f > a ? 'V' : f === a ? 'N' : 'D'; }); return { w: l.filter((x) => x === 'V').length, l: l.filter((x) => x === 'D').length, n: l.length }; };
  const fh = form(hHist, e.h), fa = form(aHist, e.a);
  const [eh, ea] = pr.elo, diff = eh - ea;
  const reasons = [];
  let lead;
  if (mp.key === 'd') lead = `Match serré : le nul est l'issue la plus probable (${Math.round(mp.p * 100)} %)`;
  else {
    const fav = mp.key === 'h' ? e.h : e.a, opp = mp.key === 'h' ? e.a : e.h, side = mp.key;
    const pf = Math.round(mp.p * 100);
    lead = `${fav.short} ${pf >= 60 ? 'nettement favori' : pf >= 45 ? 'favori' : 'légèrement favori'} (${pf} %)`;
    const d = side === 'h' ? diff : -diff;
    if (d > 60) reasons.push(`plus fort sur la durée (note ${side === 'h' ? eh : ea} contre ${side === 'h' ? ea : eh})`);
    else if (d < -40) reasons.push(`pourtant moins bien noté que ${opp.short} (${side === 'h' ? eh : ea} contre ${side === 'h' ? ea : eh})`);
    const F = side === 'h' ? fh : fa, O = side === 'h' ? fa : fh;
    if (F.n >= 4 && F.w >= 4) reasons.push(`en grande forme (${F.w} victoires sur ses ${F.n} derniers matchs)`);
    else if (F.n >= 4 && F.l >= 3) reasons.push(`malgré une mauvaise passe (${F.l} défaites sur ${F.n})`);
    if (O.n >= 4 && O.l >= 3) reasons.push(`${opp.short} en difficulté (${O.l} défaites sur ${O.n})`);
    else if (O.n >= 4 && O.w >= 4) reasons.push(`face à ${opp.short}, en forme (${O.w} victoires sur ${O.n})`);
    if (side === 'h' && !e.neutral) reasons.push('à domicile');
    const oppImp = imp[side === 'h' ? 'a' : 'h'], myImp = imp[side];
    if (oppImp.who.length) reasons.push(`${opp.short} privé de ${oppImp.who.slice(0, 2).map((w) => w.name).join(' et ')}`);
    if (myImp.who.length) reasons.push(`mais sans ${myImp.who.slice(0, 2).map((w) => w.name).join(' ni ')}`);
    if (pr.market) { const dm = pr.model[side] - pr.market[side]; if (dm > 0.08) reasons.push('notre modèle y croit plus que les bookmakers'); else if (dm < -0.08) reasons.push('les bookmakers y croient encore plus que notre modèle'); }
  }
  // buts
  const xg = pr.xg[0] + pr.xg[1];
  const goals = xg >= 3.1 ? `Match ouvert attendu (≈ ${xg.toFixed(1).replace('.', ',')} buts)` : xg <= 2.3 ? `Match plutôt fermé attendu (≈ ${xg.toFixed(1).replace('.', ',')} buts)` : '';
  const h2 = h2h.length >= 2 ? (() => { const g = h2h.reduce((t, r) => t + r.hs + r.as, 0) / h2h.length; return g >= 3.2 ? `leurs ${h2h.length} derniers duels ont donné ${g.toFixed(1).replace('.', ',')} buts en moyenne` : ''; })() : '';
  const val = picks.find((p) => p.type === 'Value');
  let txt = lead + (reasons.length ? ' : ' + reasons.slice(0, 3).join(', ') : '') + '.';
  if (goals) txt += ` ${goals}${h2 ? ', ' + h2 : ''}.`;
  if (val) txt += ` Value repérée : ${val.label} à ${String(val.odds).replace('.', ',')}.`;
  return txt;
}

function players(teamId, lambda, leaders, lineup, teamStats, scorers, absents = []) {
  const L = leaders?.[teamId];
  if (!L) return [];
  // Rythme habituel de l'équipe dans la compétition → on ajuste selon les buts attendus ce match-ci.
  const teamAvg = teamStats?.m ? teamStats.gf / teamStats.m : 1.35;
  const factor = Math.min(2, Math.max(0.5, lambda / Math.max(teamAvg, 0.6)));
  const map = new Map();
  for (const kind of ['g', 'a']) for (const p of L[kind] || []) {
    if (!p.id || !p.v) continue;
    const x = map.get(p.id) || { id: p.id, name: p.name, g: 0, a: 0, m: p.m };
    x[kind] = p.v; x.m = Math.max(x.m || 0, p.m || 0);
    map.set(p.id, x);
  }
  const xi = lineup?.[teamId]?.xi?.map((p) => p.id);
  const subs = lineup?.[teamId]?.subs?.map((p) => p.id);
  const out = [];
  for (const p of map.values()) {
    let status = 'probable', f = 1;
    const abs = absents.find((a) => samePlayer(p.name, a));
    if (abs) {
      if (abs.kind === 'incertain') { status = 'incertain'; f = abs.chance != null ? abs.chance / 100 : 0.5; }
      else { status = 'absent'; f = 0; }
      p.absInfo = `${abs.kind}${abs.info ? ' · ' + abs.info : ''}`;
    }
    if (xi?.length) {
      if (xi.includes(p.id)) status = 'titulaire';
      else if (subs?.includes(p.id)) { status = 'remplaçant'; f = 0.3; }
      else { status = 'absent'; f = 0; }
    }
    // Buts (passes) par match du joueur, tirés vers une petite valeur s'il a peu joué.
    const m = Math.max(p.m || 0, 1);
    const lg = ((p.g + 0.08 * 6) / (m + 6)) * factor * f;
    const la = ((p.a + 0.07 * 6) / (m + 6)) * factor * f;
    const pg = r3(1 - Math.exp(-lg));
    const so = scorerOdds(p.name, scorers);
    const row = { ...p, status, pg, pa: r3(1 - Math.exp(-la)), pd: r3(1 - Math.exp(-(lg + la))) };
    if (so) {
      // Cote buteur France estimée : les books français sont nettement plus bas que Bet365 sur ce marché.
      row.oRaw = so.o; row.o = frScorer(so.o); row.oFirst = so.first ? frScorer(so.first) : null;
      // Probabilité du marché sans la marge (environ 15 % sur les cotes buteur Bet365), puis mélange 45 % modèle / 55 % marché.
      const pm = Math.min(0.95, (1 / so.o) * 0.85);
      row.pgModel = pg; row.pgMarket = r3(pm);
      if (status !== 'absent') row.pg = r3(0.45 * pg + 0.55 * pm);
      // Value seulement pour un vrai buteur régulier : au moins 2 buts en 5 matchs ou plus,
      // et au moins 25 % de chances selon le modèle (écarte les défenseurs buteurs sur coups de pied arrêtés).
      if (status !== 'absent' && p.g >= 2 && (p.m || 0) >= 5 && pg >= 0.25 && row.o <= 6 && Math.abs(pg - pm) <= 0.15 && row.pg * row.o >= 1 + PLAYER_EDGE) {
        row.value = true; row.edge = r3(row.pg * row.o - 1);
      }
    }
    out.push(row);
  }
  return out.sort((x, y) => y.pd - x.pd);
}
const r3 = (x) => Math.round(x * 1000) / 1000;

// ---------- 5. classements ----------
async function loadStandings(slug) {
  const j = await getJSON(`${STAND}/${slug}/standings`);
  if (!j) return null;
  const groups = (j.children || []).map((g) => ({
    name: g.name,
    rows: (g.standings?.entries || []).map((e) => {
      const st = Object.fromEntries((e.stats || []).map((s) => [s.name, s.value]));
      return {
        id: e.team?.id, name: e.team?.displayName, short: e.team?.shortDisplayName, logo: logo(e.team),
        rank: st.rank, pj: st.gamesPlayed, g: st.wins, n: st.ties, p: st.losses,
        bp: st.pointsFor, bc: st.pointsAgainst, diff: st.pointDifferential, pts: st.points,
        note: e.note?.description || '', color: e.note?.color || '',
      };
    }).sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99)),
  }));
  return { slug, groups };
}

// ---------- 6. classement des buteurs et passeurs ----------
async function loadScorers(slug) {
  const j = await getJSON(`https://site.web.api.espn.com/apis/site/v2/sports/soccer/${slug}/statistics`);
  if (!j?.stats) return null;
  const pick = (name, kind) => (j.stats.find((c) => c.name === name)?.leaders || []).slice(0, 30).map((l) => {
    const m = /Matches:\s*(\d+)/.exec(l.displayValue || '');
    const t = l.athlete?.team || l.team || {};
    return { id: l.athlete?.id, name: l.athlete?.displayName, team: t.shortDisplayName || t.displayName || '', logo: t.logos?.[0]?.href || logo(t), v: Number(l.value) || 0, m: m ? +m[1] : null, kind };
  });
  return { slug, goals: pick('goalsLeaders', 'g'), assists: pick('assistsLeaders', 'a') };
}

// ---------- programme principal ----------
async function main() {
  await fs.mkdir(CACHE, { recursive: true });
  log('Récupération des calendriers…');
  const comps = await pool(ALL, 4, loadCompetition);
  const nationElo = await loadNationElo();

  const compInfo = {}, all = [];
  for (const { comp, events, leagueLogo } of comps) {
    if (comp.show) compInfo[comp.slug] = { name: comp.name, short: comp.short, logo: leagueLogo, type: comp.type };
    for (const e of events) { e.tier = comp.tier; e.nat = comp.type === 'nations'; all.push(e); }
  }
  const byId = new Map(all.map((e) => [e.id, e]));
  const results = [...byId.values()].filter((e) => e.completed && e.hs != null && e.as != null);
  log('matchs joués utilisés pour le modèle :', results.length);
  // Tirs cadrés des matchs joués (Top 5 + coupes d'Europe) : on complète le cache avec les nouveaux matchs.
  const statsFile = path.join(CACHE, 'matchstats.json');
  const mstats = await readJSON(statsFile, {});
  const newStats = results.filter((e) => STAT_SLUGS.includes(e.slug) && !mstats[e.id]);
  await pool(newStats, 4, async (e) => {
    const s = await getJSON(`${SITE}/${e.slug}/summary?event=${e.id}`);
    if (s) mstats[e.id] = { slug: e.slug, date: e.date, ...extractStats(s, e) };
  });
  if (newStats.length) await writeJSON(statsFile, mstats);
  log('stats de tirs :', Object.keys(mstats).length, 'matchs (', newStats.length, 'nouveaux )');
  const ratings = buildRatings(
    results.map((e) => ({ id: e.id, date: e.date, slug: e.slug, h: e.h.id, a: e.a.id, hs: e.hs, as: e.as, neutral: e.neutral, nat: e.nat })),
    nationElo, mstats,
  );

  // Stats par équipe dans chaque compétition (saison en cours)
  const teamComp = new Map();
  for (const e of results) {
    for (const [t, gf, ga, home] of [[e.h.id, e.hs, e.as, true], [e.a.id, e.as, e.hs, false]]) {
      const k = `${e.slug}|${e.season}|${t}`;
      const s = teamComp.get(k) || { gf: 0, ga: 0, m: 0, hm: 0, hgf: 0, hga: 0, am: 0, agf: 0, aga: 0 };
      s.gf += gf; s.ga += ga; s.m++;
      if (home) { s.hm++; s.hgf += gf; s.hga += ga; } else { s.am++; s.agf += gf; s.aga += ga; }
      teamComp.set(k, s);
    }
  }

  // Fenêtre affichée : 2 jours avant → 7 jours après
  const shownSlugs = new Set(DISPLAY.map((c) => c.slug));
  const window = [...byId.values()].filter((e) => shownSlugs.has(e.slug) && Math.abs(Date.parse(e.date) - NOW) < (Date.parse(e.date) > NOW ? DAYS_AHEAD : DAYS_BACK) * D)
    .sort((a, b) => a.date.localeCompare(b.date));
  log('matchs dans la fenêtre :', window.length);

  // Détails ESPN (mis en cache pour ne pas tout recharger à chaque passage)
  const sumCache = await readJSON(path.join(CACHE, 'summaries.json'), {});
  await pool(window, 4, async (e) => {
    const c = sumCache[e.id];
    const kick = Date.parse(e.date) - NOW;
    const maxAge = kick < 3 * H ? 0 : kick < D ? 2 * H : 6 * H;
    const stale = !c || c.v !== SUMMARY_VERSION;
    const needed = e.state === 'pre' ? (stale || NOW - c.ts > maxAge) : (stale || (e.completed && !c.final));
    if (!needed) return;
    const s = await getJSON(`${SITE}/${e.slug}/summary?event=${e.id}`);
    const x = extractSummary(s);
    if (x) sumCache[e.id] = { ts: NOW, final: e.completed, ...x };
  });
  for (const id of Object.keys(sumCache)) if (!window.find((e) => e.id === id)) delete sumCache[id];
  await writeJSON(path.join(CACHE, 'summaries.json'), sumCache);

  // Blessés / suspendus
  const fpl = window.some((e) => e.slug === 'eng.1' && e.state === 'pre') ? await loadFpl() : [];
  const cards = await readJSON(path.join(CACHE, 'cards.json'), {});
  const lastMatch = (e, t) => results.filter((r) => r.slug === e.slug && (r.h.id === t || r.a.id === t) && r.date < e.date)
    .sort((a, b) => b.date.localeCompare(a.date))[0];
  const needCards = new Map();
  for (const e of window) if (e.state === 'pre' && Date.parse(e.date) - NOW < 6 * D) for (const t of [e.h.id, e.a.id]) {
    const l = lastMatch(e, t); if (l && !(l.id in cards)) needCards.set(l.id, l);
  }
  await pool([...needCards.values()], 4, async (l) => {
    const s = await getJSON(`${SITE}/${l.slug}/summary?event=${l.id}`);
    if (s) cards[l.id] = redCards(s);
  });
  await writeJSON(path.join(CACHE, 'cards.json'), cards);
  log('cartons rouges vérifiés sur', needCards.size, 'nouveaux matchs');
  const dFr = (d) => new Date(d).toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris', day: '2-digit', month: '2-digit' });
  function absentsFor(e, side) {
    const t = e[side], out = [];
    if (e.state !== 'pre') return out;
    const l = lastMatch(e, t.id);
    for (const c of (l && cards[l.id]) || []) if (c.team === t.id) {
      const opp = l.h.id === t.id ? l.a.short : l.h.short;
      out.push({ name: c.name, kind: 'suspendu', info: `carton rouge le ${dFr(l.date)} contre ${opp} (suspension probable)`, src: 'ESPN' });
    }
    if (e.slug === 'eng.1') for (const a of fpl) if (sameTeam(a.team, t) && !out.some((x) => samePlayer(x.name, a))) out.push(a);
    return out;
  }

  // Historique des pronos
  const history = await readJSON(path.join(DATA, 'history.json'), {});

  const matches = window.map((e) => {
    const sum = sumCache[e.id] || { odds: {}, form: {}, leaders: {}, lineup: {} };
    const absents = { h: absentsFor(e, 'h'), a: absentsFor(e, 'a') };
    // Cotes du marché (Bet365 / DraftKings, sites étrangers) → cotes « France » estimées,
    // plus basses car les bookmakers français reversent moins (≈ 91 % au lieu de ≈ 94 %).
    const x12 = sum.odds.b365 || sum.odds.dk || null;
    const ouRaw = sum.odds.ou || null;
    const frOu = ouRaw ? (() => { const [po, pu] = toFr([ouRaw.over, ouRaw.under]); return { line: ouRaw.line, over: po, under: pu }; })() : null;
    const odds = { x12: toFr(x12), ou: frOu, src: x12 ? 'France estimée' : null, rawSrc: sum.odds.b365 ? 'Bet365' : sum.odds.dk ? 'DraftKings' : null, rawOu: ouRaw };
    const sh = teamComp.get(`${e.slug}|${e.season}|${e.h.id}`), sa = teamComp.get(`${e.slug}|${e.season}|${e.a.id}`);
    // Absences → baisse des buts attendus (matchs pas encore commencés)
    const imp = e.state === 'pre'
      ? { h: absenceImpact(e.h.id, sum.leaders, sum.lineup, absents.h, sh), a: absenceImpact(e.a.id, sum.leaders, sum.lineup, absents.a, sa) }
      : { h: { f: 1, who: [] }, a: { f: 1, who: [] } };
    const pr = predict({ hId: e.h.id, aId: e.a.id, hName: e.h.name, aName: e.a.name, nat: e.nat, neutral: e.neutral, ratings, market: x12 ? { x12, ou: ouRaw } : null, absAdj: { h: imp.h.f, a: imp.a.f } });
    pr.abs = imp;
    // historique de chaque équipe (toutes compétitions) avant ce match
    const histOf = (t) => results.filter((r) => (r.h.id === t || r.a.id === t) && r.date < e.date).sort((x, y) => y.date.localeCompare(x.date)).slice(0, 40);
    const hHist = histOf(e.h.id), aHist = histOf(e.a.id);
    const picks = buildPicks(pr, odds, { h: e.h.short, a: e.a.short });

    const h2h = results.filter((r) => (r.h.id === e.h.id && r.a.id === e.a.id) || (r.h.id === e.a.id && r.a.id === e.h.id))
      .sort((a, b) => b.date.localeCompare(a.date)).slice(0, 5)
      .map((r) => ({ d: r.date, h: r.h.short, a: r.a.short, hs: r.hs, as: r.as, comp: compInfo[r.slug]?.short || r.slug }));

    // Historique : on fige le prono au coup d'envoi, puis on le corrige à la fin du match.
    let hist = history[e.id];
    if (e.state === 'pre') {
      hist = history[e.id] = {
        ...(hist || {}), id: e.id, slug: e.slug, date: e.date, h: e.h.short, a: e.a.short, hLogo: e.h.logo, aLogo: e.a.logo,
        picks: picks.map(({ type, key, label, p, odds: o, stars, est }) => ({ type, key, label, p, odds: o, stars, est })),
        snaps: hist?.snaps || [],
      };
      const last = hist.snaps[hist.snaps.length - 1];
      if (x12 && (!last || last.x12.join() !== x12.join())) hist.snaps.push({ t: new Date(NOW).toISOString(), x12 });
      if (hist.snaps.length > 30) hist.snaps.splice(1, hist.snaps.length - 30);
    }
    if (hist && e.completed && !hist.result) {
      if (/AET|PEN/i.test(e.status || '')) hist.result = { hs: e.hs, as: e.as, void: true, note: 'Prolongation : pronos non comptés' };
      else {
        hist.result = { hs: e.hs, as: e.as };
        for (const p of hist.picks) p.win = grade(p, e.hs, e.as);
      }
    }

    // Évolution des cotes : première cote vue (ou ouverture DraftKings) → cote actuelle
    const first = toFr(hist?.snaps?.[0]?.x12 || sum.odds.dkOpen || null); // l'historique garde les cotes d'origine
    return {
      id: e.id, slug: e.slug, date: e.date, state: e.state, completed: e.completed, detail: e.detail, neutral: e.neutral,
      h: e.h, a: e.a, hs: e.hs, as: e.as,
      pred: pr, picks, odds: { ...odds, first, dk: sum.odds.dk || null, b365: sum.odds.b365 || null },
      form: { h: sum.form[e.h.id] || [], a: sum.form[e.a.id] || [] },
      stats: { h: sh || null, a: sa || null },
      h2h, lineup: { h: sum.lineup[e.h.id] || null, a: sum.lineup[e.a.id] || null },
      players: { h: players(e.h.id, pr.xg[0], sum.leaders, sum.lineup, sh, sum.scorers, absents.h), a: players(e.a.id, pr.xg[1], sum.leaders, sum.lineup, sa, sum.scorers, absents.a) },
      absents,
      trends: [...teamTrends(e.h, hHist, 'h'), ...teamTrends(e.a, aHist, 'a')].sort((x, y) => y.score - x.score).slice(0, 5).map(({ text, kind }) => ({ text, kind })),
      why: explain(e, pr, picks, hHist, aHist, imp, h2h),
      // cotes buteur : estimation France (o) + cote Bet365 d'origine (raw)
      scorers: (sum.scorers || []).slice(0, 20).map((s) => ({ name: s.name, o: frScorer(s.o), first: s.first ? frScorer(s.first) : null, raw: s.o })),
      result: hist?.result || null, graded: hist?.result ? hist.picks : null,
    };
  });

  // Matchs reportés ou annulés depuis plus de 3 jours : retirés de l'historique en attente
  for (const [id, h] of Object.entries(history)) {
    if (!h.result && NOW - Date.parse(h.date) > 3 * D) {
      const e = byId.get(id);
      if (!e || !e.completed) h.result = { void: true, note: 'Match reporté ou annulé' };
    }
  }

  // ---------- Combiné du jour : choisi par le serveur, figé au 1er coup d'envoi, puis corrigé ----------
  const combos = await readJSON(path.join(DATA, 'combos.json'), {});
  const parisDay = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(new Date(d));
  const upcoming = matches.filter((m) => m.state === 'pre' && Date.parse(m.date) > NOW + 10 * 60e3);
  let day = parisDay(NOW), dayMs = upcoming.filter((m) => parisDay(m.date) === day);
  if (dayMs.length < 2) { day = [...new Set(upcoming.map((m) => parisDay(m.date)))].sort().find((d) => upcoming.filter((m) => parisDay(m.date) === d).length >= 2); dayMs = upcoming.filter((m) => parisDay(m.date) === day); }
  const locked = (c) => c.legs.some((l) => { const m = matches.find((x) => x.id === l.mid); return !m || m.state !== 'pre' || Date.parse(m.date) <= NOW; });
  if (day && dayMs.length >= 2 && !(combos[day] && locked(combos[day]))) {
    const c = dailyCombo(dayMs);
    if (c) combos[day] = { day, ...c, createdAt: new Date(NOW).toISOString() };
  }
  for (const c of Object.values(combos)) {
    if (c.result) continue;
    let pending = false, lost = false, voided = false;
    for (const l of c.legs) {
      const e = byId.get(l.mid);
      if (!e?.completed) { if (e && NOW - Date.parse(e.date) > 3 * D) voided = true; pending = true; continue; }
      if (/AET|PEN/i.test(e.status || '')) { voided = true; continue; }
      l.win = grade(l, e.hs, e.as); l.score = `${e.hs}-${e.as}`;
      if (!l.win) lost = true;
    }
    if (lost) c.result = { win: false };
    else if (!pending) c.result = voided ? { void: true } : { win: true };
  }
  await writeJSON(path.join(DATA, 'combos.json'), combos);

  log('Classements…');
  const standings = (await pool(STANDINGS, 3, loadStandings)).filter(Boolean);
  log('Buteurs…');
  const scorers = (await pool(STANDINGS, 3, loadScorers)).filter((x) => x && (x.goals.length || x.assists.length));

  await writeJSON(path.join(DATA, 'matches.json'), { updatedAt: new Date(NOW).toISOString(), comps: compInfo, matches });
  await writeJSON(path.join(DATA, 'history.json'), history);
  await writeJSON(path.join(DATA, 'standings.json'), { updatedAt: new Date(NOW).toISOString(), comps: compInfo, tables: standings, scorers });
  log(`Terminé : ${matches.length} matchs, ${Object.keys(history).length} pronos dans l'historique.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
