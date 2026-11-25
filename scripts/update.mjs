// Mise à jour complète du site : récupère les données ESPN, calcule les pronos,
// met à jour l'historique. Lancé automatiquement par GitHub (aucune IA, 0 crédit).
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DISPLAY, RATING_ONLY, STANDINGS, DAYS_AHEAD, DAYS_BACK } from './config.mjs';
import { buildRatings, predict, buildPicks, grade } from './model.mjs';

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

function players(teamId, lambda, leaders, lineup, teamStats, scorers) {
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
      row.o = so.o; row.oFirst = so.first;
      // Probabilité du marché sans la marge (environ 15 % sur les cotes buteur), puis mélange 45 % modèle / 55 % marché.
      const pm = Math.min(0.95, (1 / so.o) * 0.85);
      row.pgModel = pg; row.pgMarket = r3(pm);
      if (status !== 'absent') row.pg = r3(0.45 * pg + 0.55 * pm);
      // Value seulement pour un vrai buteur régulier : au moins 2 buts en 5 matchs ou plus,
      // et au moins 25 % de chances selon le modèle (écarte les défenseurs buteurs sur coups de pied arrêtés).
      if (status !== 'absent' && p.g >= 2 && (p.m || 0) >= 5 && pg >= 0.25 && so.o <= 6 && Math.abs(pg - pm) <= 0.15 && row.pg * so.o >= 1 + PLAYER_EDGE) {
        row.value = true; row.edge = r3(row.pg * so.o - 1);
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
  const ratings = buildRatings(
    results.map((e) => ({ date: e.date, slug: e.slug, h: e.h.id, a: e.a.id, hs: e.hs, as: e.as, neutral: e.neutral, nat: e.nat })),
    nationElo,
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

  // Historique des pronos
  const history = await readJSON(path.join(DATA, 'history.json'), {});

  const matches = window.map((e) => {
    const sum = sumCache[e.id] || { odds: {}, form: {}, leaders: {}, lineup: {} };
    const x12 = sum.odds.b365 || sum.odds.dk || null;
    const odds = { x12, ou: sum.odds.ou || null, src: sum.odds.b365 ? 'Bet365' : sum.odds.dk ? 'DraftKings' : null };
    const pr = predict({ hId: e.h.id, aId: e.a.id, hName: e.h.name, aName: e.a.name, nat: e.nat, neutral: e.neutral, ratings, market: x12 ? { x12, ou: odds.ou } : null });
    const picks = buildPicks(pr, odds, { h: e.h.short, a: e.a.short });

    const sh = teamComp.get(`${e.slug}|${e.season}|${e.h.id}`), sa = teamComp.get(`${e.slug}|${e.season}|${e.a.id}`);
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
    const first = hist?.snaps?.[0]?.x12 || sum.odds.dkOpen || null;
    return {
      id: e.id, slug: e.slug, date: e.date, state: e.state, completed: e.completed, detail: e.detail, neutral: e.neutral,
      h: e.h, a: e.a, hs: e.hs, as: e.as,
      pred: pr, picks, odds: { ...odds, first, dk: sum.odds.dk || null, b365: sum.odds.b365 || null },
      form: { h: sum.form[e.h.id] || [], a: sum.form[e.a.id] || [] },
      stats: { h: sh || null, a: sa || null },
      h2h, lineup: { h: sum.lineup[e.h.id] || null, a: sum.lineup[e.a.id] || null },
      players: { h: players(e.h.id, pr.xg[0], sum.leaders, sum.lineup, sh, sum.scorers), a: players(e.a.id, pr.xg[1], sum.leaders, sum.lineup, sa, sum.scorers) },
      scorers: (sum.scorers || []).slice(0, 20),
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
