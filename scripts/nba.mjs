// Mise à jour NBA : matchs de la nuit, pronos (vainqueur, total, joueurs), blessés, combiné du jour,
// résumé de la nuit, classements, NBA Cup / playoffs. Lancé par GitHub (aucune IA, 0 crédit).
import path from 'node:path';
import { NBA, CACHE, ROOT, NBA_PARAMS as P, getJSON, readJSON, writeJSON, loadGames, runModel, phi, overProb, r3 } from './nba-lib.mjs';
import { collectBoxes } from './nba-box.mjs';

const DATA = path.join(ROOT, 'data');
const NOW = Date.now(), H = 3600e3, D = 24 * H;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), '[NBA]', ...a);
const r2 = (x) => Math.round(x * 100) / 100;
const FR_PAYOUT = 0.91; // taux de retour des bookmakers français
const frOdds = (p) => r2(Math.max(1.01, FR_PAYOUT / Math.max(0.01, p)));
const amToDec = (s) => { if (s == null || s === '') return null; if (s === 'EVEN') return 2; const v = parseFloat(String(s).replace('+', '')); return isFinite(v) && v ? (v > 0 ? 1 + v / 100 : 1 + 100 / -v) : null; };
const fair2 = (a, b) => { const x = 1 / a, y = 1 / b; return [x / (x + y), y / (x + y)]; };
async function pool(items, n, fn) { let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; await fn(items[k]); } })); }
const parisDay = (t) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(new Date(t));
const nightKey = (date) => parisDay(Date.parse(date) - 10 * H); // un match à 2h du matin appartient à la soirée de la veille
// Réglages mesurés sur les matchs passés (scripts/nba-props-backtest.mjs → data/nba-props-params.json)
const PP = readJSON(path.join(ROOT, 'data', 'nba-props-params.json'), {});
const PROPS = { w10: 0.3, sdMult: { pts: 0.75, reb: 0.55, ast: 0.55, tpm: 0.55 }, shift: { pts: 0.3, reb: 0.4, ast: 0.5, tpm: 0.6 }, map: {}, ...(PP.props || {}) };
const INJ_MARGIN = PP.injuries?.margin ?? 0.108; // point d'écart perdu par point/match du joueur absent (mesuré : 0,108)
const interp = (pts, p) => { if (!pts?.length) return p; if (p <= pts[0][0]) return pts[0][1]; for (let i = 1; i < pts.length; i++) if (p <= pts[i][0]) { const [x0, y0] = pts[i - 1], [x1, y1] = pts[i]; return y0 + (y1 - y0) * (p - x0) / (x1 - x0); } return pts[pts.length - 1][1]; };
const INJ_W = { Out: 1, Doubtful: 0.75, Questionable: 0.4, 'Day-To-Day': 0.4, Probable: 0.1 };

async function main() {
  const games = await loadGames(NOW);
  const season = Math.max(...games.filter((g) => g.stype !== 1).map((g) => g.season));
  log('matchs :', games.length, '· saison', season);

  // 1. Feuilles de match de la saison en cours (moyennes des joueurs, résumé de la nuit, correction des paris joueurs)
  const { box, fetched } = await collectBoxes(path.join(CACHE, 'nba-box.json'), games.filter((g) => g.season === season && g.stype !== 1));
  log('feuilles de match :', Object.keys(box).length, '(', fetched, 'nouvelles )');

  // moyennes des joueurs (saison + 10 derniers matchs)
  const players = new Map(); // id → {name, team, pos, head, games:[{d,min,pts,reb,ast}]}
  const teamGames = new Map();
  for (const [gid, b] of Object.entries(box).sort((x, y) => x[1].d.localeCompare(y[1].d))) {
    for (const [tid, list] of Object.entries(b.t)) {
      teamGames.set(tid, (teamGames.get(tid) || 0) + 1);
      for (const [id, name, pos, min, pts, reb, ast, starter, head, tpm] of list) {
        const p = players.get(id) || { id, name, pos, head, team: tid, g: [] };
        p.team = tid; p.name = name; p.pos = pos || p.pos; p.head = head || p.head; p.g.push({ d: b.d, min, pts, reb, ast, tpm: tpm || 0, starter, gid });
        players.set(id, p);
      }
    }
  }
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const sd = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((x) => (x - m) ** 2))); };
  for (const p of players.values()) {
    const all = p.g, l10 = all.slice(-10);
    p.gp = all.length; p.min = mean(all.map((x) => x.min));
    for (const k of ['pts', 'reb', 'ast', 'tpm']) { p[k] = mean(all.map((x) => x[k])); p[k + '10'] = mean(l10.map((x) => x[k])); p[k + 'Sd'] = sd(all.map((x) => x[k])); }
    // fréquence (pondérée vers le récent) de 10+ dans chaque stat, double-double et triple-double
    let w = 0; const c = { pts: 0, reb: 0, ast: 0, dd: 0, td: 0 };
    all.forEach((x, i) => { const wt = Math.pow(0.95, all.length - 1 - i); w += wt; let n = 0; for (const k of ['pts', 'reb', 'ast']) if (x[k] >= 10) { c[k] += wt; n++; } if (n >= 2) c.dd += wt; if (n >= 3) c.td += wt; });
    const f10 = (k) => (c[k] + 0.5) / (w + 1);
    const pInd = f10('pts') * f10('reb') + f10('pts') * f10('ast') + f10('reb') * f10('ast') - 2 * f10('pts') * f10('reb') * f10('ast');
    p.pDD = 0.88 * (c.dd + 3 * pInd) / (w + 3); // corrigé : surestimé d'environ 12 % sur les saisons passées
    p.pTD = 0.8 * (c.td + 3 * f10('pts') * f10('reb') * f10('ast')) / (w + 3);
    p.pra = p.pts + p.reb + p.ast; p.pra10 = p.pts10 + p.reb10 + p.ast10; p.praSd = sd(all.map((x) => x.pts + x.reb + x.ast));
  }

  // 2. Modèle : on rejoue tous les matchs, on garde les prédictions des matchs à afficher
  const winFrom = NOW - 30 * H, winTo = NOW + 48 * H;
  const window = games.filter((g) => Date.parse(g.date) >= winFrom && Date.parse(g.date) <= winTo && g.stype !== 1);
  const preds = new Map();
  const weekPred = new Map();
  const st = runModel(games, P, (g, pr) => { if (Date.parse(g.date) >= winFrom && Date.parse(g.date) <= winTo) preds.set(g.id, pr); if (g.state === 'pre' && Date.parse(g.date) > NOW && Date.parse(g.date) < NOW + 8 * D) weekPred.set(g.id, pr); });

  // 3. Détails des matchs à afficher : blessés, cotes, prédiction ESPN (mis en cache quelques heures)
  const sumFile = path.join(CACHE, 'nba-sum.json');
  const sum = readJSON(sumFile, {});
  await pool(window, 5, async (g) => {
    const c = sum[g.id], kick = Date.parse(g.date) - NOW;
    const maxAge = g.state !== 'pre' ? (g.completed && c?.final ? Infinity : 0) : kick < 6 * H ? 0 : 3 * H;
    if (c && NOW - c.ts < maxAge) return;
    const s = await getJSON(`${NBA}/summary?event=${g.id}`); if (!s) return;
    const injuries = {};
    for (const t of s.injuries || []) injuries[t.team?.id] = (t.injuries || []).map((i) => ({ id: i.athlete?.id, name: i.athlete?.displayName, status: i.status, info: i.details?.type || i.type?.description || '' }));
    const pc = (s.pickcenter || [])[0];
    let odds = null;
    if (pc) {
      const ml = [amToDec(pc.moneyline?.home?.close?.odds ?? pc.homeTeamOdds?.moneyLine), amToDec(pc.moneyline?.away?.close?.odds ?? pc.awayTeamOdds?.moneyLine)];
      const line = parseFloat(String(pc.total?.over?.close?.line || pc.overUnder || '').replace(/[ou]/, ''));
      const ou = [amToDec(pc.total?.over?.close?.odds), amToDec(pc.total?.under?.close?.odds)];
      odds = { ml: ml.every(Boolean) ? ml : null, total: isFinite(line) ? { line, over: ou[0], under: ou[1] } : null, spread: pc.details || null, src: pc.provider?.name || 'DraftKings' };
    }
    const pred = s.predictor ? { h: parseFloat(s.predictor.homeTeam?.gameProjection) / 100, a: parseFloat(s.predictor.awayTeam?.gameProjection) / 100 } : null;
    sum[g.id] = { ts: NOW, final: g.completed, injuries, odds, espn: pred && isFinite(pred.h) ? pred : null };
  });
  for (const id of Object.keys(sum)) if (!window.find((g) => g.id === id)) delete sum[id];
  writeJSON(sumFile, sum);

  // 4. Pronos de chaque match
  const history = readJSON(path.join(DATA, 'nba-history.json'), {});
  const outGames = window.map((g) => {
    const pr = preds.get(g.id); const s = sum[g.id] || {};
    const inj = s.injuries || {};
    // blessés : une star absente coûte ~3 à 5 points d'écart (≈ 15 % de ses points ; le reste est compensé par les remplaçants)
    // mesuré sur 1 592 matchs : un absent coûte 0,11 point d'écart par point qu'il marque en moyenne, et ne change pas le total
    const injImpact = (tid) => Math.min(7, (inj[tid] || []).reduce((t, i) => { const p = players.get(i.id); return t + (INJ_W[i.status] ?? 0.3) * (p?.pts || 0) * (p && p.team === tid ? INJ_MARGIN : 0); }, 0));
    const ih = injImpact(g.h.id), ia = injImpact(g.a.id);
    let margin = pr.margin - ih + ia, total = pr.total; // les remplaçants marquent autant : pas d'effet mesuré sur le total
    const pModel = phi(margin / P.sigma);
    let pH = pModel, src = 'modèle';
    if (s.odds?.ml) { const [mh] = fair2(s.odds.ml[0], s.odds.ml[1]); pH = 0.35 * pModel + 0.65 * mh; src = 'modèle + cotes'; }
    else if (s.espn) { pH = 0.6 * pModel + 0.4 * s.espn.h; src = 'modèle + ESPN'; }
    if (s.odds?.total?.line) total = 0.4 * total + 0.6 * s.odds.total.line;
    const tLine = s.odds?.total?.line || Math.round(total) + 0.5;
    const pOver = overProb(total, tLine, P.sigmaT);

    // paris joueurs : projection = 55 % forme (10 derniers) + 45 % saison, ajustée à la défense adverse et aux absents
    const props = [], starters = {};
    for (const side of ['h', 'a']) {
      const tid = g[side].id, opp = side === 'h' ? g.a : g.h;
      const out = new Set((inj[tid] || []).filter((i) => i.status === 'Out' || i.status === 'Doubtful').map((i) => i.id));
      const roster = [...players.values()].filter((p) => p.team === tid && p.gp >= 3 && p.g[p.g.length - 1].d > new Date(NOW - 25 * D).toISOString());
      const teamPts = roster.reduce((t, p) => t + p.pts * Math.min(1, p.gp / (teamGames.get(tid) || 1)), 0) || 110;
      const outShare = Math.min(0.3, roster.filter((p) => out.has(p.id)).reduce((t, p) => t + p.pts, 0) / teamPts);
      const defF = (st.def.get(opp.id)?.n ? (st.def.get(opp.id).s / st.def.get(opp.id).n) / st.lg : 1);
      for (const p of roster.filter((p) => !out.has(p.id) && p.min >= 20).sort((a, b) => b.min - a.min).slice(0, 6)) {
        const injSt = (inj[tid] || []).find((i) => i.id === p.id)?.status || null;
        const boost = 1 + 0.5 * outShare;
        // projection = 30 % forme récente + 70 % saison ; centre décalé (la médiane est sous la moyenne) ;
        // puis table de correction : la probabilité affichée = réussite réelle observée sur ~50 000 paris passés
        const mk = (stat, label, proj, sdv) => {
          const sd0 = Math.max({ pts: 4.5, reb: 2.2, ast: 1.8, tpm: 1.1 }[stat], sdv);
          const sdx = sd0 * PROPS.sdMult[stat], center = proj - PROPS.shift[stat] * sd0;
          const MIN_LINE = { pts: 9.5, reb: 3.5, ast: 2.5, tpm: 1.5 }[stat]; // pas de paris trop faciles
          for (const line of new Set([Math.max(0.5, Math.round(proj) - 0.5), Math.max(0.5, Math.floor(proj - 0.75 * sd0) + 0.5)])) {
            if (line < MIN_LINE) continue;
            const raw = 1 - phi((line - center) / sdx);
            if (raw < 0.5 || raw > 0.93) continue;
            const p1 = interp(PROPS.map?.[stat], raw);
            props.push({ pid: p.id, name: p.name, head: p.head, team: side, stat, label: `${p.name} : plus de ${String(line).replace('.', ',')} ${label}`, line, proj: r2(proj), p: r3(p1 * (injSt ? 0.85 : 1)), odds: frOdds(p1), est: true, injured: injSt });
          }
        };
        const w = PROPS.w10;
        mk('pts', 'points', (w * p.pts10 + (1 - w) * p.pts) * boost * (0.5 + 0.5 * defF), p.ptsSd);
        mk('reb', 'rebonds', (w * p.reb10 + (1 - w) * p.reb) * (1 + 0.3 * outShare), p.rebSd);
        mk('ast', 'passes', (w * p.ast10 + (1 - w) * p.ast) * (1 + 0.3 * outShare), p.astSd);
        if (p.tpm >= 1.2) mk('tpm', 'paniers à 3 points', w * p.tpm10 + (1 - w) * p.tpm, p.tpmSd);
        if (p.pDD >= 0.3) props.push({ pid: p.id, name: p.name, head: p.head, team: side, stat: 'dd', label: `${p.name} : double-double`, line: 0, proj: r2(p.pDD), p: r3(p.pDD * (injSt ? 0.85 : 1)), odds: frOdds(p.pDD), est: true, injured: injSt });
        if (p.pTD >= 0.15) props.push({ pid: p.id, name: p.name, head: p.head, team: side, stat: 'td', label: `${p.name} : triple-double`, line: 0, proj: r2(p.pTD), p: r3(p.pTD * (injSt ? 0.85 : 1)), odds: frOdds(p.pTD), est: true, injured: injSt });
      }
      // cinq de départ probable : titulaires du dernier match, sans les absents ; complété par les plus gros temps de jeu
      const last = [...players.values()].filter((p) => p.team === tid).map((p) => p.g[p.g.length - 1]).filter(Boolean).sort((x, y) => y.d.localeCompare(x.d))[0];
      const lastStarters = last ? [...players.values()].filter((p) => p.team === tid && p.g.some((x) => x.gid === last.gid && x.starter)) : [];
      const five = lastStarters.filter((p) => !out.has(p.id));
      for (const p of roster.filter((p) => !out.has(p.id) && !five.includes(p)).sort((a, b) => b.min - a.min)) { if (five.length >= 5) break; five.push(p); }
      starters[side] = five.slice(0, 5).map((p) => ({ id: p.id, name: p.name, pos: p.pos, head: p.head, pts: r2(p.pts), changed: !lastStarters.includes(p) }));
    }

    const fav = pH >= 0.5 ? 'h' : 'a', pFav = Math.max(pH, 1 - pH);
    const mlFr = s.odds?.ml ? (() => { const [mh, ma] = fair2(s.odds.ml[0], s.odds.ml[1]); return [frOdds(mh), frOdds(ma)]; })() : null;
    const totFr = s.odds?.total?.over && s.odds?.total?.under ? (() => { const [po, pu] = fair2(s.odds.total.over, s.odds.total.under); return [frOdds(po), frOdds(pu)]; })() : null;
    const picks = [
      { type: 'ML', key: fav, label: `Victoire ${g[fav].short}`, p: r3(pFav), odds: mlFr ? mlFr[fav === 'h' ? 0 : 1] : frOdds(pFav), est: !mlFr },
      pOver >= 0.5
        ? { type: 'TOT', key: 'o' + tLine, label: `Plus de ${String(tLine).replace('.', ',')} points`, p: r3(pOver), odds: totFr ? totFr[0] : frOdds(pOver), est: !totFr }
        : { type: 'TOT', key: 'u' + tLine, label: `Moins de ${String(tLine).replace('.', ',')} points`, p: r3(1 - pOver), odds: totFr ? totFr[1] : frOdds(1 - pOver), est: !totFr },
    ];
    const stars = pFav >= 0.8 ? 5 : pFav >= 0.7 ? 4 : pFav >= 0.62 ? 3 : pFav >= 0.55 ? 2 : 1;
    picks[0].stars = stars;
    // pourquoi ce prono
    const why = [];
    const favT = g[fav], oppT = g[fav === 'h' ? 'a' : 'h'];
    why.push(`${favT.short} ${pFav >= 0.7 ? 'nettement favori' : pFav >= 0.58 ? 'favori' : 'légèrement favori'} (${Math.round(pFav * 100)} %)`);
    const reasons = [];
    const eloF = pr.elo[fav === 'h' ? 0 : 1], eloO = pr.elo[fav === 'h' ? 1 : 0];
    if (eloF - eloO > 60) reasons.push(`plus fort cette saison (note ${eloF} contre ${eloO})`);
    if (fav === 'h' && !g.neutral) reasons.push('à domicile');
    if (pr.rest[fav === 'h' ? 'b2bA' : 'b2bH']) reasons.push(`${oppT.short} joue son 2e match en 2 soirs`);
    if (pr.rest[fav === 'h' ? 'b2bH' : 'b2bA']) reasons.push(`malgré un back-to-back`);
    const restDiff = (pr.rest.h - pr.rest.a) * (fav === 'h' ? 1 : -1);
    if (restDiff >= 2) reasons.push(`${restDiff} jours de repos de plus`);
    const injOpp = (inj[oppT.id] || []).filter((i) => i.status === 'Out' && (players.get(i.id)?.pts || 0) >= 12).map((i) => i.name);
    if (injOpp.length) reasons.push(`${oppT.short} sans ${injOpp.slice(0, 2).join(' ni ')}`);
    const injFav = (inj[favT.id] || []).filter((i) => i.status === 'Out' && (players.get(i.id)?.pts || 0) >= 12).map((i) => i.name);
    if (injFav.length) reasons.push(`mais privé de ${injFav.slice(0, 2).join(' et ')}`);
    const recF = st.recent.get(favT.id) || [], wF = recF.filter((x) => x.w).length;
    if (recF.length >= 8 && wF >= 7) reasons.push(`en forme (${wF} victoires sur ${recF.length})`);
    const whyTxt = why[0] + (reasons.length ? ' : ' + reasons.slice(0, 3).join(', ') : '') + `. Total attendu ≈ ${Math.round(total)} points.`;

    // historique : figé au coup d'envoi, corrigé ensuite
    let hist = history[g.id];
    if (g.state === 'pre') history[g.id] = hist = { id: g.id, date: g.date, h: g.h.abbr, a: g.a.abbr, hLogo: g.h.logo, aLogo: g.a.logo, picks: picks.map(({ type, key, label, p, odds, est }) => ({ type, key, label, p, odds, est })) };
    if (hist && g.completed && !hist.result && g.hs != null) {
      hist.result = { hs: g.hs, as: g.as };
      for (const pk of hist.picks) pk.win = gradeNba(pk, g, box[g.id]);
    }
    return {
      id: g.id, date: g.date, state: g.state, completed: g.completed, detail: g.detail, period: g.period, clock: g.clock,
      h: g.h, a: g.a, hs: g.hs, as: g.as, lines: g.lines, rec: g.rec, cup: g.cup, note: g.note, series: g.series, stype: g.stype,
      pred: { pH: r3(pH), pModel: r3(pModel), margin: r2(margin), total: r2(total), tLine, pOver: r3(pOver), src, elo: pr.elo, rest: pr.rest, espn: s.espn || null },
      odds: s.odds || null, oddsFr: { ml: mlFr, total: totFr }, picks, why: whyTxt,
      injuries: { h: (inj[g.h.id] || []).map((i) => ({ ...i, ppg: r2(players.get(i.id)?.pts || 0) })), a: (inj[g.a.id] || []).map((i) => ({ ...i, ppg: r2(players.get(i.id)?.pts || 0) })) },
      form: { h: st.recent.get(g.h.id) || [], a: st.recent.get(g.a.id) || [] },
      h2h: games.filter((x) => x.completed && x.season === season && x.id !== g.id && ((x.h.id === g.h.id && x.a.id === g.a.id) || (x.h.id === g.a.id && x.a.id === g.h.id))).map((x) => ({ d: x.date, h: x.h.abbr, a: x.a.abbr, hs: x.hs, as: x.as })),
      props: props.sort((a, b) => b.p - a.p).slice(0, 40), starters,
      result: hist?.result || null, graded: hist?.result ? hist.picks : null,
    };
  });

  // 5. Combiné NBA du jour (figé au 1er match de la nuit)
  const combos = readJSON(path.join(DATA, 'nba-combos.json'), {});
  const upcoming = outGames.filter((g) => g.state === 'pre' && Date.parse(g.date) > NOW + 10 * 60e3);
  const night = [...new Set(upcoming.map((g) => nightKey(g.date)))].sort()[0];
  if (night) {
    const ms = upcoming.filter((g) => nightKey(g.date) === night);
    const locked = combos[night] && combos[night].legs.some((l) => { const g = outGames.find((x) => x.id === l.gid); return !g || g.state !== 'pre'; });
    if (ms.length >= 2 && !locked) { const c = nbaCombo(ms); if (c) combos[night] = { night, ...c, createdAt: new Date(NOW).toISOString() }; }
  }
  for (const c of Object.values(combos)) {
    if (c.result) continue;
    let pending = false, lost = false;
    for (const l of c.legs) {
      const g = games.find((x) => x.id === l.gid);
      if (!g?.completed) { pending = true; continue; }
      l.win = gradeNba(l, g, box[g.id]); l.score = `${g.as}-${g.hs}`;
      if (l.win === false) lost = true; if (l.win == null) pending = true;
    }
    if (lost) c.result = { win: false }; else if (!pending) c.result = { win: true };
  }

  // 6. Résumé de la nuit : matchs terminés depuis 20 h
  const nightGames = games.filter((g) => g.completed && NOW - Date.parse(g.date) < 20 * H && NOW - Date.parse(g.date) > 0).map((g) => {
    const b = box[g.id]; let top = null;
    if (b) for (const [tid, list] of Object.entries(b.t)) for (const r of list) if (!top || r[4] > top.pts) top = { name: r[1], pts: r[4], reb: r[5], ast: r[6], team: tid === g.h.id ? g.h.abbr : g.a.abbr, head: r[8] };
    return { id: g.id, h: g.h, a: g.a, hs: g.hs, as: g.as, detail: g.detail, top, picks: history[g.id]?.picks || null };
  });

  // 7. Classements, meilleurs joueurs, NBA Cup, playoffs
  const sj = await getJSON('https://site.api.espn.com/apis/v2/sports/basketball/nba/standings');
  const standings = (sj?.children || []).map((c) => ({
    name: c.name.replace('Eastern Conference', 'Conférence Est').replace('Western Conference', 'Conférence Ouest'),
    rows: c.standings.entries.map((e) => { const x = Object.fromEntries(e.stats.map((s) => [s.name, s.displayValue])); return { id: e.team.id, name: e.team.displayName, short: e.team.shortDisplayName, abbr: e.team.abbreviation, logo: e.team.logos?.[0]?.href, seed: +x.playoffSeed, w: +x.wins, l: +x.losses, pct: x.winPercent, gb: x.gamesBehind, streak: x.streak, l10: x['Last Ten Games'], home: x.Home, road: x.Road, diff: x.differential }; }).sort((a, b) => a.seed - b.seed),
  }));
  const tg = (p) => teamGames.get(p.team) || 1;
  const qual = [...players.values()].filter((p) => p.gp >= Math.max(3, 0.6 * tg(p)));
  const leaders = Object.fromEntries(['pts', 'reb', 'ast'].map((k) => [k, qual.sort((a, b) => b[k] - a[k]).slice(0, 15).map((p) => ({ id: p.id, name: p.name, head: p.head, team: p.team, v: r2(p[k]), gp: p.gp }))]));
  const teamsById = {}; for (const g of games) { teamsById[g.h.id] = g.h; teamsById[g.a.id] = g.a; }
  const cup = games.filter((g) => g.cup && g.season === season).map((g) => ({ id: g.id, date: g.date, note: g.note, h: g.h, a: g.a, hs: g.hs, as: g.as, state: g.state, completed: g.completed, detail: g.detail }));
  const playoffs = games.filter((g) => g.stype === 3 && g.season === season).map((g) => ({ id: g.id, date: g.date, h: g.h, a: g.a, hs: g.hs, as: g.as, completed: g.completed, series: g.series, note: g.note }));

  const week = games.filter((g) => weekPred.has(g.id)).map((g) => { const pr = weekPred.get(g.id); return { id: g.id, date: g.date, h: g.h, a: g.a, cup: g.cup, pH: r3(pr.pH), total: Math.round(pr.total), b2b: [pr.rest.b2bH ? g.h.abbr : null, pr.rest.b2bA ? g.a.abbr : null].filter(Boolean) }; });
  writeJSON(path.join(DATA, 'nba.json'), { updatedAt: new Date(NOW).toISOString(), season, week, games: outGames, night: nightGames, standings, leaders, teams: teamsById, cup, playoffs });
  writeJSON(path.join(DATA, 'nba-history.json'), history);
  writeJSON(path.join(DATA, 'nba-combos.json'), combos);
  log(`terminé : ${outGames.length} matchs affichés, ${nightGames.length} dans le résumé de la nuit`);
}

// Correction d'un pari NBA
function gradeNba(pk, g, b) {
  if (pk.type === 'ML') return pk.key === 'h' ? g.hs > g.as : g.as > g.hs;
  if (pk.type === 'TOT') { const L = parseFloat(pk.key.slice(1)), t = g.hs + g.as; return pk.key[0] === 'o' ? t > L : t < L; }
  if (pk.type === 'PROP') {
    if (!b) return null;
    for (const list of Object.values(b.t)) for (const r of list) if (r[0] === pk.pid) {
      const n10 = (r[4] >= 10) + (r[5] >= 10) + (r[6] >= 10);
      if (pk.stat === 'dd') return n10 >= 2; if (pk.stat === 'td') return n10 >= 3;
      const v = { pts: r[4], reb: r[5], ast: r[6], tpm: r[9] || 0 }[pk.stat]; return v > pk.line;
    }
    return false; // joueur absent de la feuille : pari perdu (chez la plupart des bookmakers il serait remboursé)
  }
  return null;
}

// Combiné NBA du jour : le plus probable pour une cote 1,85 – 2,50, 2 à 4 paris sur des matchs différents,
// au plus 1 pari « total de points » et 1 pari joueur.
function nbaCombo(ms) {
  const legs = [];
  for (const g of ms) {
    for (const p of g.picks) if (p.odds >= 1.12 && p.p >= 0.58) legs.push({ gid: g.id, type: p.type, key: p.key, label: p.label, p: p.p, odds: p.odds, est: p.est, match: `${g.a.abbr} @ ${g.h.abbr}`, date: g.date });
    const pp = g.props.find((x) => x.p >= 0.68 && x.odds >= 1.15 && !x.injured);
    if (pp) legs.push({ gid: g.id, type: 'PROP', key: pp.stat + pp.line, pid: pp.pid, stat: pp.stat, line: pp.line, label: pp.label, p: pp.p, odds: pp.odds, est: true, match: `${g.a.abbr} @ ${g.h.abbr}`, date: g.date });
  }
  legs.sort((a, b) => b.p - a.p);
  const L = legs.slice(0, 24); let best = null;
  const rec = (start, ch, o, p) => {
    if (ch.length >= 2 && o >= 1.85 && o <= 2.5 && (!best || p > best.p)) best = { legs: [...ch], odds: o, p };
    if (ch.length === 4 || o > 2.5) return;
    for (let i = start; i < L.length; i++) {
      const x = L[i];
      if (ch.some((c) => c.gid === x.gid)) continue;
      if (x.type !== 'ML' && ch.some((c) => c.type === x.type)) continue;
      ch.push(x); rec(i + 1, ch, o * x.odds, p * x.p); ch.pop();
    }
  };
  rec(0, [], 1, 1);
  if (!best) return null;
  best.legs.sort((a, b) => a.date.localeCompare(b.date));
  return { legs: best.legs, odds: r2(best.odds), p: r3(best.p) };
}

main().catch((e) => { console.error(e); process.exit(1); });
