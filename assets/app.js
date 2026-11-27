// Layan Pronos : affichage + direct. Les données de /data sont recalculées par GitHub ;
// les scores en direct et les compos sont lus directement chez ESPN depuis le téléphone.
const $ = (s, el = document) => el.querySelector(s);
const view = $('#view');
const TZ = 'Europe/Paris';
const ESPN = 'https://site.api.espn.com/apis/site/v2/sports/soccer';
const state = { tab: 'matchs', day: null, comp: 'all', valueOnly: false, q: '', standing: null, stView: 'table', pSort: 'pd', pComp: 'all', pValue: false };
let M = null, S = null, HIST = null, COMBOS = {}, CAL = null, PARAMS = null, loadedAt = 0, modalDraw = null, modalId = null;

// ---------- formats ----------
const fmt = (opts) => new Intl.DateTimeFormat('fr-FR', { timeZone: TZ, ...opts });
const fTime = fmt({ hour: '2-digit', minute: '2-digit' });
const fDay = fmt({ weekday: 'long', day: 'numeric', month: 'long' });
const fShort = fmt({ day: '2-digit', month: '2-digit' });
const fWd = fmt({ weekday: 'short' });
const fDayShort = fmt({ weekday: 'short', day: 'numeric' });
const dayKey = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(d));
const todayKey = () => dayKey(Date.now());
const addDays = (key, n) => { const d = new Date(key + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const noon = (k) => new Date(k + 'T12:00:00Z');
const weekday = (key) => noon(key).getUTCDay();
const pct = (p) => (p == null || isNaN(p) ? '–' : Math.round(p * 100) + ' %');
const pctN = (p) => (p == null ? '–' : Math.round(p * 100));
const odd = (o) => (o ? Number(o).toFixed(2).replace('.', ',') : '');
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const img = (src, cls = 'logo', style = '') => (src ? `<img class="${cls}" src="${esc(src)}" alt="" loading="lazy" style="${style}" onerror="this.style.visibility='hidden'">` : `<span class="${cls}"></span>`);
const conf = (n) => `<span class="conf c${n}" title="Confiance ${n}/5">${[1, 2, 3, 4, 5].map((i) => `<i class="${i <= n ? 'on' : ''}"></i>`).join('')}</span>`;
const comp = (slug) => M?.comps?.[slug] || S?.comps?.[slug] || { name: slug, short: slug };
const TYPE_NAMES = { '1N2': 'Résultat', DC: 'Double chance', Buts: 'Buts', BTTS: 'Les deux marquent', Value: 'Value bet' };
// Statuts ESPN (anglais) → français
const trDetail = (s) => {
  const t = String(s || '').trim();
  const map = { FT: 'Terminé', HT: 'Mi-temps', AET: 'Ap. prol.', 'FT-Pens': 'T.a.b.', Postponed: 'Reporté', Canceled: 'Annulé', Abandoned: 'Arrêté', Delayed: 'Retardé', 'End of Regulation': 'Fin du temps régl.', ET: 'Prolongation' };
  return map[t] ?? t;
};
const debounce = (f, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => f(...a), ms); }; };

// ---------- chargement ----------
async function load() {
  const get = (f) => fetch(`data/${f}?v=${Math.floor(Date.now() / 6e4)}`).then((r) => r.json());
  const [m, s, h, c, cal, prm] = await Promise.all([get('matches.json'), get('standings.json'), get('history.json'), get('combos.json').catch(() => ({})), get('calibration.json').catch(() => null), get('params.json').catch(() => null)]);
  M = m; S = s; HIST = h; COMBOS = c || {}; CAL = cal; PARAMS = prm; loadedAt = Date.now();
  const upd = new Date(M.updatedAt);
  $('#updated').textContent = `Pronos mis à jour ${fDayShort.format(upd)} à ${fTime.format(upd)}`;
  render();
  liveTick();
}

// ---------- corrections (copie du calcul du serveur) ----------
function gradePick(p, hs, as) {
  const tot = hs + as, res = hs > as ? 'h' : hs === as ? 'd' : 'a';
  if (p.type === '1N2') return p.key === res;
  if (p.type === 'DC') return { '1N': res !== 'a', 'N2': res !== 'h', '12': res !== 'd' }[p.key];
  if (p.type === 'BTTS') return p.key === 'yes' ? hs > 0 && as > 0 : !(hs > 0 && as > 0);
  if (/^[ou]\d/.test(p.key)) { const l = parseFloat(p.key.slice(1)); return p.key[0] === 'o' ? tot > l : tot < l; }
  return p.key === res;
}
// Prono enregistré avant le match ? (sinon pas de verdict, pour rester honnête)
const tracked = (m) => !!HIST?.[m.id];
function verdict(m, p) {
  if (!tracked(m) || m.hs == null) return null;
  const g = m.graded?.find((x) => x.type === p.type && x.key === p.key);
  if (g && g.win != null) return { win: g.win, final: true };
  if (m.state === 'in' || m.completed) return { win: gradePick(p, m.hs, m.as), final: m.completed };
  return null;
}
const verdictTag = (v) => !v ? '' : v.final ? (v.win ? '<span class="tag win">✓ Gagné</span>' : '<span class="tag lose">✗ Perdu</span>')
  : (v.win ? '<span class="tag win">● passe pour l\'instant</span>' : '<span class="tag lose">● ne passe pas pour l\'instant</span>');

// ---------- blessés / suspendus ----------
const absCount = (m) => (m.absents?.h?.length || 0) + (m.absents?.a?.length || 0);
const KIND_TAG = { 'blessé': 'lose', 'suspendu': 'lose', 'incertain': 'big' };
// Effet des absences sur le calcul du prono (buts attendus en baisse pour l'équipe touchée)
function impactHtml(m) {
  const A = m.pred?.abs; if (!A) return '';
  const rows = [['h', m.h], ['a', m.a]].filter(([k]) => A[k] && A[k].f < 1).map(([k, t]) => {
    const w = A[k].who.map((x) => `${esc(x.name)} (${esc(x.why)}, ${x.g} b. ${x.a} p.)`).join(', ');
    return `<div class="impact"><b>${esc(t.short)} : −${Math.round((1 - A[k].f) * 100)} % de buts attendus</b><div class="small muted">${w}</div></div>`;
  });
  return rows.length ? `<div class="impact-box"><div class="eyebrow">Pris en compte dans le prono</div>${rows.join('')}
    <p class="note" style="margin-bottom:0">Le modèle baisse l'attaque de l'équipe selon la part de ses buts et passes qui manque (le remplaçant en compense la moitié). Les cotes du marché, qui comptent pour 55 %, intègrent déjà ces absences.</p></div>` : '';
}
function absentsHtml(m) {
  if (!m.absents || m.state !== 'pre') return '';
  const side = (t, list) => `<div style="margin:8px 0 4px"><b style="display:flex;gap:8px;align-items:center">${img(t.logo, 'logo', 'width:18px;height:18px')}${esc(t.short)}</b></div>` +
    (list.length ? list.map((a) => `<div class="abs-row"><span class="tag ${KIND_TAG[a.kind] || ''}">${esc(a.kind)}${a.kind === 'incertain' && a.chance != null ? ' ' + a.chance + ' %' : ''}</span><div><b>${esc(a.name)}</b><div class="small muted">${esc(a.info || '')}</div></div></div>`).join('')
      : '<div class="small muted">Aucun absent connu.</div>');
  const pl = m.slug === 'eng.1';
  return `<div class="card pad section"><h3 style="margin-top:0">🚑 Blessés et suspendus</h3>${side(m.h, m.absents.h)}${side(m.a, m.absents.a)}${impactHtml(m)}
    <p class="note">${pl ? 'Premier League : blessés, incertains et suspendus selon Fantasy Premier League (officiel). ' : 'Hors Premier League, aucune source gratuite ne donne les blessés : seuls les suspendus après un carton rouge au dernier match sont détectés. '}Les compos officielles (≈1 h avant) confirment les absents.</p></div>`;
}

// ---------- helpers matchs ----------
const isPre = (m) => m.state === 'pre';
const mainPick = (m) => m.picks.find((p) => p.type === '1N2');
const values = (m) => m.picks.filter((p) => p.type === 'Value');
const bigMatch = (m) => (m.pred.elo[0] + m.pred.elo[1]) / 2 >= 1800 || Math.min(...m.pred.elo) >= 1760;
const matchText = (m) => `${m.h.name} ${m.a.name} ${m.h.short} ${m.a.short} ${comp(m.slug).name}`.toLowerCase();
function oddsMove(m) {
  const a = m.odds.first, b = m.odds.x12;
  if (!a || !b) return null;
  return ['h', 'd', 'a'].map((k, i) => ({ k, from: a[i], to: b[i], diff: b[i] - a[i] }));
}
function timeCell(m) {
  if (m.state === 'in') return `<span class="lv"><i class="dot-live"></i>${esc(trDetail(m.detail) || 'Live')}</span>`;
  if (m.completed) return `<b>Fin</b><small>${fShort.format(new Date(m.date))}</small>`;
  if (m.state === 'pre') return `<b>${fTime.format(new Date(m.date))}</b><small>${fShort.format(new Date(m.date))}</small>`;
  return `<small>${esc(trDetail(m.detail))}</small>`;
}
function bigScore(m) {
  if (m.state === 'pre') return `<b>${fTime.format(new Date(m.date))}</b><small>${fDayShort.format(new Date(m.date))}</small>`;
  return `<b>${m.hs ?? 0} - ${m.as ?? 0}</b><small>${m.state === 'in' ? `<i class="dot-live"></i> ${esc(trDetail(m.detail) || 'En direct')}` : esc(trDetail(m.detail) || 'Terminé')}</small>`;
}

// ---------- favoris (gardés sur ce téléphone) ----------
let favs = new Set();
try { favs = new Set(JSON.parse(localStorage.getItem('favoris') || '[]')); } catch (e) {}
const isFav = (id) => favs.has(id);
function toggleFav(id) {
  buzz(15);
  if (favs.has(id)) { favs.delete(id); toast('Retiré des favoris'); } else { favs.add(id); toast('⭐ Ajouté aux favoris'); }
  // on oublie les favoris des matchs qui ne sont plus affichés
  const ids = new Set(M.matches.map((m) => m.id)); favs = new Set([...favs].filter((x) => ids.has(x)));
  try { localStorage.setItem('favoris', JSON.stringify([...favs])); } catch (e) {}
}
const favBtn = (id) => '<button class="fav ' + (isFav(id) ? 'on' : '') + '" data-fav="' + id + '" aria-label="Favori" title="' + (isFav(id) ? 'Retirer des favoris' : 'Mettre en favori') + '">' + (isFav(id) ? '★' : '☆') + '</button>';
function favsHtml() {
  const list = M.matches.filter((m) => isFav(m.id)).sort((a, b) => a.date.localeCompare(b.date));
  if (!list.length) return '';
  return '<h2>⭐ Mes favoris</h2><div class="mlist">' + list.map(matchCard).join('') + '</div>';
}

function matchCard(m) {
  const p = m.pred.p, mp = mainPick(m), vs = values(m), mv = oddsMove(m);
  const moved = mv?.find((x) => x.k === mp.key && Math.abs(x.diff) >= 0.05);
  const top = ['h', 'd', 'a'].reduce((x, y) => (p[y] > p[x] ? y : x));
  const showScore = m.state !== 'pre' && m.hs != null;
  const lost = (side) => m.completed && ((side === 'h' && m.hs < m.as) || (side === 'a' && m.as < m.hs));
  const v = verdict(m, mp);
  return `<article class="card mc" data-id="${m.id}">
    <div class="mc-main">
      <div class="mc-time">${timeCell(m)}</div>
      <div class="mc-teams">
        <div class="mc-team ${lost('h') ? 'lost' : ''}">${img(m.h.logo)}<span>${esc(m.h.short)}</span>${showScore ? `<b class="sc">${m.hs}</b>` : ''}</div>
        <div class="mc-team ${lost('a') ? 'lost' : ''}">${img(m.a.logo)}<span>${esc(m.a.short)}</span>${showScore ? `<b class="sc">${m.as}</b>` : ''}</div>
      </div>
      <div class="probs">${['h', 'd', 'a'].map((k, i) => `<div class="${k === top ? 'top' : ''}"><small>${esc([m.h.abbr || m.h.short.slice(0, 3), 'Nul', m.a.abbr || m.a.short.slice(0, 3)][i])}</small><b>${pctN(p[k])}</b></div>`).join('')}</div>
    </div>
    <div class="mc-bar"><i class="h" style="width:${p.h * 100}%"></i><i class="d" style="width:${p.d * 100}%"></i><i class="a" style="width:${p.a * 100}%"></i></div>
    <div class="mc-foot">
      <span class="pick"><span class="pick-k">Prono</span> ${esc(mp.label)}${mp.odds ? ` <span class="odd">${odd(mp.odds)}</span>` : ''}</span>${conf(mp.stars)}
      ${vs.length ? `<span class="tag value">◆ ${vs.length} value</span>` : ''}
      ${moved ? `<span class="tag ${moved.diff < 0 ? 'down' : 'up'}" title="Évolution de la cote">${moved.diff < 0 ? '↘' : '↗'} ${odd(moved.from)} → ${odd(moved.to)}</span>` : ''}
      ${bigMatch(m) ? '<span class="tag big">🔥 Choc</span>' : ''}${absCount(m) ? `<span class="tag lose" title="Blessés / suspendus">🚑 ${absCount(m)}</span>` : ''}
      ${verdictTag(v)}
      ${m.result?.void ? `<span class="tag">${esc(m.result.note)}</span>` : ''}
      ${favBtn(m.id)}
    </div>
    ${m.state === 'pre' && m.trends?.length ? `<div class="mc-trend">${TREND_ICON[m.trends[0].kind] || '📊'} ${esc(m.trends[0].text)}</div>` : ''}
  </article>`;
}
const TREND_ICON = { up: '📈', down: '📉', goals: '⚽', nogoals: '🧱' };

function groupByComp(list) {
  const order = Object.keys(M.comps);
  const g = new Map();
  for (const m of list) { if (!g.has(m.slug)) g.set(m.slug, []); g.get(m.slug).push(m); }
  return [...g.entries()].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]));
}
const compHead = (slug, n) => `<div class="comp-head"><span class="cl">${img(comp(slug).logo, '')}</span><b>${esc(comp(slug).name)}</b>${n ? `<span>${n} match${n > 1 ? 's' : ''}</span>` : ''}</div>`;

// ---------- combinés, match du jour, surprises ----------
function safeLeg(m) {
  const c = m.picks.filter((p) => p.type !== 'Value' && p.p >= 0.68 && p.odds && p.odds >= 1.12);
  return c.length ? c.sort((a, b) => b.p - a.p)[0] : null;
}
function combos(list, n = 2) {
  const legs = list.filter(isPre).map((m) => ({ m, p: safeLeg(m) })).filter((x) => x.p).sort((a, b) => b.p.p - a.p.p);
  const out = []; let i = 0;
  while (out.length < n && i < legs.length) {
    const c = []; let o = 1, pr = 1;
    while (i < legs.length && (o < 2 || c.length < 2) && c.length < 4) { const l = legs[i++]; c.push(l); o *= l.p.odds; pr *= l.p.p; }
    if (o >= 1.9 && c.length >= 2) out.push({ legs: c, odds: o, p: pr });
  }
  return out;
}
function comboHtml(c, i) {
  return `<div class="card combo">
    <div class="row-between"><div><div class="eyebrow">Combiné ${i + 1}</div><div class="combo-total">${odd(c.odds)}</div></div>
      <div class="ring" style="--p:${Math.round(c.p * 100)};--ring:var(--accent);background:conic-gradient(var(--accent) calc(var(--p)*1%),var(--surface-3) 0)"><span style="background:var(--surface);color:var(--text)">${pctN(c.p)}%</span></div></div>
    <div class="combo-legs">${c.legs.map((l) => `<div class="leg"><div><small>${esc(l.m.h.short)} - ${esc(l.m.a.short)}</small><b>${esc(l.p.label)}</b></div><span class="o">${odd(l.p.odds)}${l.p.est ? '≈' : ''}</span></div>`).join('')}</div>
    <div class="small muted">Chances que tout passe selon le modèle : <b>${pct(c.p)}</b></div>
  </div>`;
}
function matchOfDay() {
  const pre = M.matches.filter(isPre);
  for (let d = 0; d < 7; d++) {
    const day = pre.filter((m) => dayKey(m.date) === addDays(todayKey(), d));
    if (day.length) return day.sort((a, b) => mainPick(b).stars - mainPick(a).stars || mainPick(b).p - mainPick(a).p)[0];
  }
  return null;
}
function surprises(list) {
  const out = [];
  for (const m of list.filter(isPre)) {
    const mk = m.pred.market; if (!mk || !m.odds.x12) continue;
    const k = mk.h < mk.a ? 'h' : 'a', o = m.odds.x12[k === 'h' ? 0 : 2], diff = m.pred.model[k] - mk[k];
    if (o >= 2.8 && diff >= 0.06) out.push({ m, k, o, diff });
  }
  return out.sort((a, b) => b.diff - a.diff).slice(0, 6);
}
function surpriseHtml(s) {
  const t = s.k === 'h' ? s.m.h : s.m.a;
  return `<div class="card pad mc" data-id="${s.m.id}">
    <div class="row-between"><div class="mc-team">${img(t.logo)}<span>${esc(t.short)}</span></div><span class="tag value">Cote ${odd(s.o)}</span></div>
    <div class="small muted" style="margin:8px 0 10px">${esc(s.m.h.short)} - ${esc(s.m.a.short)} · ${fDayShort.format(new Date(s.m.date))} ${fTime.format(new Date(s.m.date))}</div>
    <div class="mk">
      <div class="mk-row"><div class="lab"><span class="small">Bookmakers</span><div class="meter"><i style="width:${s.m.pred.market[s.k] * 100}%;background:var(--draw)"></i></div></div><span class="pct">${pct(s.m.pred.market[s.k])}</span><span></span></div>
      <div class="mk-row"><div class="lab"><span class="small">Notre modèle</span><div class="meter"><i style="width:${s.m.pred.model[s.k] * 100}%"></i></div></div><span class="pct">${pct(s.m.pred.model[s.k])}</span><span></span></div>
    </div>
  </div>`;
}

// ---------- Quasi-sûrs : paris annoncés à 80 % ou plus ----------
const SURE_TYPES = { '1N2': 'Résultat', DC: 'Double chance', Buts: 'Buts' };
function surePicks(m) {
  return allLegs(m).filter((l) => SURE_TYPES[l.type] && l.p >= 0.8 && l.odds >= 1.04)
    .sort((a, b) => b.p - a.p).slice(0, 2); // au plus 2 par match (les plus sûrs)
}
const calText = (type) => { const b = CAL?.bins?.[type]?.['80']; return b ? `(passé ${Math.round(b.real * 100)} %)` : ''; };
function surePicksHtml(max = 8, days = 2) {
  const lim = Date.now() + days * 864e5;
  const list = M.matches.filter((m) => isPre(m) && Date.parse(m.date) < lim).flatMap((m) => surePicks(m).map((l) => ({ ...l, m })))
    .sort((a, b) => b.p - a.p).slice(0, max);
  if (!list.length) return '';
  const hist = Object.keys(SURE_TYPES).map((t) => SURE_TYPES[t] + ' ' + (CAL?.bins?.[t]?.['80'] ? Math.round(CAL.bins[t]['80'].real * 100) + ' %' : '?')).join(' · ');
  let html = '<h2>✅ Les quasi-sûrs ' + info('quasi') + '</h2><p class="note">Paris annoncés à 80 % ou plus (48 h). Sur les saisons passées, ils sont réellement passés : ' + hist + '. Cotes basses : à combiner plutôt qu\'à jouer seuls.</p><div class="card sure-list">';
  for (const l of list) {
    html += '<div class="mini sure" data-id="' + l.m.id + '"><div class="t">' + fTime.format(new Date(l.m.date)) + '<br><span class="small muted">' + fWd.format(new Date(l.m.date)).replace('.', '') + '</span></div>'
      + '<div style="min-width:0"><div class="small muted" style="display:flex;gap:6px;align-items:center">' + img(l.m.h.logo, 'logo', 'width:14px;height:14px') + esc(l.match) + ' · ' + esc(comp(l.m.slug).short) + '</div><b>' + esc(l.label) + '</b> <span class="small muted">' + esc(calText(l.type)) + '</span></div>'
      + '<div style="text-align:right"><b class="sure-p">' + pctN(l.p) + ' %</b><div class="small muted">' + odd(l.odds) + (l.est ? '≈' : '') + '</div></div></div>';
  }
  return html + '</div>';
}

// ---------- Combiné du jour (choisi et suivi par le serveur) ----------
function currentCombo() {
  const days = Object.keys(COMBOS).sort(), t = todayKey();
  return COMBOS[t] || COMBOS[days.find((d) => d > t)] || COMBOS[days[days.length - 1]] || null;
}
function dailyComboHtml() {
  const c = currentCombo(); if (!c) return '';
  const legState = (l) => {
    const m = M.matches.find((x) => x.id === l.mid);
    if (l.win === true) return '<span class="tag win">✓ ' + esc(l.score || '') + '</span>';
    if (l.win === false) return '<span class="tag lose">✗ ' + esc(l.score || '') + '</span>';
    if (m && m.state === 'in' && m.hs != null) { const w = gradePick(l, m.hs, m.as); return '<span class="tag ' + (w ? 'win' : 'lose') + '">● ' + m.hs + '-' + m.as + '</span>'; }
    return '<span class="o">' + odd(l.odds) + (l.est ? '≈' : '') + '</span>';
  };
  const status = c.result ? (c.result.void ? '<span class="tag">Annulé (prolongation / report)</span>' : c.result.win ? '<span class="tag win">✓ Combiné gagné</span>' : '<span class="tag lose">✗ Combiné perdu</span>') : '';
  const when = c.day === todayKey() ? "aujourd'hui" : fDay.format(noon(c.day));
  const ids = c.legs.map((l) => l.mid + '|' + l.type + '|' + l.key).join(',');
  return '<div class="card combo daily"><div class="row-between"><div><div class="eyebrow">🎯 Combiné du jour · ' + when + ' ' + info('combine') + '</div><div class="combo-total">' + odd(c.odds) + '</div></div>'
    + '<div class="ring" style="--p:' + Math.round(c.p * 100) + ';background:conic-gradient(var(--accent) calc(var(--p)*1%),var(--surface-3) 0)"><span style="background:var(--surface);color:var(--text)">' + pctN(c.p) + '%</span></div></div>'
    + '<div class="combo-legs">' + c.legs.map((l) => '<div class="leg" data-id="' + l.mid + '"><div style="min-width:0"><small>' + esc(l.match) + ' · ' + fTime.format(new Date(l.date)) + '</small><b>' + esc(l.label) + '</b> <span class="small muted">' + pct(l.p) + '</span></div>' + legState(l) + '</div>').join('') + '</div>'
    + '<div class="row-between">' + (status || '<span class="small muted">Le plus probable pour une cote ≈ 2. Figé au 1er coup d\'envoi, suivi dans Performance.</span>')
    + (!c.result ? '<button class="btn-sm" data-addall="' + esc(ids) + '">+ Mon combiné</button>' : '') + '</div></div>';
}
// Dernier réglage automatique du modèle (chaque lundi)
const fx = (v) => String(v).replace('.', ',');
function tuneHtml() {
  if (!PARAMS?.updatedAt) return '';
  const a = PARAMS.after, b = PARAMS.before, d = new Date(PARAMS.updatedAt);
  return '<div class="card pad section"><div class="eyebrow">🔄 Réglage automatique du modèle</div><p class="small" style="margin:8px 0 0">Dernier réglage le ' + fDay.format(d) + ', testé sur ' + a.n + ' matchs des 12 derniers mois. '
    + (PARAMS.adopted ? '<b>Nouveau réglage adopté</b> : réussite 1N2 ' + fx(b.acc1x2) + ' % → ' + fx(a.acc1x2) + ' %, buts ' + fx(b.accGoals) + ' % → ' + fx(a.accGoals) + ' %.'
      : 'Réglage conservé (aucune amélioration nette) : réussite 1N2 ' + fx(a.acc1x2) + ' %, buts ' + fx(a.accGoals) + ' %.')
    + '</p><p class="note" style="margin-bottom:0">Chaque lundi, le site rejoue les matchs récents avec d\'autres réglages et ne garde un changement que s\'il améliore nettement les prévisions.</p></div>';
}
function comboPerfHtml() {
  const done = Object.values(COMBOS).filter((c) => c.result && !c.result.void);
  if (!done.length) return '<div class="card pad section"><div class="eyebrow">🎯 Combiné du jour</div><p class="small muted" style="margin:6px 0 0">Suivi en cours : ' + Object.keys(COMBOS).length + ' combiné(s) proposé(s), pas encore de résultat.</p></div>';
  const w = done.filter((c) => c.result.win).length, profit = done.reduce((t, c) => t + (c.result.win ? c.odds - 1 : -1), 0);
  const avgP = done.reduce((t, c) => t + c.p, 0) / done.length;
  return '<div class="card pad section"><div class="eyebrow">🎯 Combiné du jour</div><div class="kpis" style="margin-top:10px">'
    + '<div class="kpi" style="padding:0"><div><div class="v">' + w + '/' + done.length + '</div><div class="l">passés (' + pct(w / done.length) + ') · annoncé en moyenne ' + pct(avgP) + '</div></div></div>'
    + '<div class="kpi" style="padding:0"><div><div class="v ' + (profit >= 0 ? 'up' : 'down') + '">' + (profit >= 0 ? '+' : '') + profit.toFixed(1) + ' u</div><div class="l">gains fictifs (1 unité par combiné)</div></div></div></div></div>';
}

// ---------- onglet Matchs ----------
function renderMatchs() {
  const days = [...new Set(M.matches.map((m) => dayKey(m.date)))].sort();
  const t = todayKey();
  if (!state.day || !days.includes(state.day)) state.day = days.includes(t) ? t : days.find((d) => d > t) || days[days.length - 1];
  const wd = (d) => (d === t ? "Auj." : d === addDays(t, 1) ? 'Dem.' : d === addDays(t, -1) ? 'Hier' : fWd.format(noon(d)).replace('.', ''));
  const count = (d) => M.matches.filter((m) => dayKey(m.date) === d).length;
  let list = M.matches.filter((m) => dayKey(m.date) === state.day);
  if (state.q) list = M.matches.filter((m) => matchText(m).includes(state.q.toLowerCase()));
  if (state.comp !== 'all') list = list.filter((m) => m.slug === state.comp);
  if (state.valueOnly) list = list.filter((m) => isPre(m) && surePicks(m).length);
  const live = M.matches.filter((m) => m.state === 'in');
  const motd = matchOfDay();
  const dayCombos = combos(M.matches.filter((m) => dayKey(m.date) === state.day));
  const sup = surprises(M.matches);
  const comps = [...new Set(M.matches.map((m) => m.slug))];
  const mp = motd && mainPick(motd);

  view.innerHTML = `
    ${motd && !state.q ? `<div class="card hero" data-id="${motd.id}">
      <div class="row-between" style="position:relative;z-index:1"><span class="eyebrow">★ Match du jour</span><span class="small" style="opacity:.9">${esc(comp(motd.slug).name)}</span></div>
      <div class="hero-teams">
        <div class="t"><span class="crest">${img(motd.h.logo, '')}</span>${esc(motd.h.short)}</div>
        <div class="hero-mid">${bigScore(motd)}</div>
        <div class="t"><span class="crest">${img(motd.a.logo, '')}</span>${esc(motd.a.short)}</div>
      </div>
      <div class="hero-foot"><span class="pick">${esc(mp.label)}${mp.odds ? ' · ' + odd(mp.odds) : ''}</span>${conf(mp.stars)}<div class="ring" style="--p:${pctN(mp.p)}"><span>${pctN(mp.p)}%</span></div></div>
    </div>` : ''}
    ${!state.q ? favsHtml() + dailyComboHtml() + surePicksHtml(8) : ''}
    ${live.length && !state.q ? `<h2><i class="dot-live"></i> En direct</h2><div class="mlist">${live.map(matchCard).join('')}</div>` : ''}
    <div class="filters">
      <div class="days">${days.map((d) => `<button class="day ${d === state.day && !state.q ? 'active' : ''}" data-day="${d}"><small>${wd(d)}</small><b>${noon(d).getUTCDate()}</b><span class="n">${count(d)} m.</span></button>`).join('')}</div>
      <div class="searchbox"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg><input type="search" id="q" placeholder="Rechercher une équipe" value="${esc(state.q)}"></div>
      <select id="comp"><option value="all">Toutes les compétitions</option>${comps.map((c) => `<option value="${c}" ${c === state.comp ? 'selected' : ''}>${esc(comp(c).name)}</option>`).join('')}</select>
      <label class="toggle"><input type="checkbox" id="vOnly" ${state.valueOnly ? 'checked' : ''}> ✅ Quasi-sûrs</label>
    </div>
    ${state.q ? `<p class="note">Résultats pour « ${esc(state.q)} » sur les ${days.length} jours affichés.</p>` : ''}
    ${list.length ? groupByComp(list).map(([slug, ms]) => compHead(slug, ms.length) + `<div class="mlist">${ms.map(matchCard).join('')}</div>`).join('') : '<div class="card empty">Aucun match pour ce choix.</div>'}
    ${!state.q && dayCombos.length ? `<h2>🎯 Combinés suggérés</h2><div class="grid2">${dayCombos.map(comboHtml).join('')}</div><p class="note">Cotes ≈ : estimées à partir des cotes 1N2.</p>` : ''}
    ${!state.q && sup.length ? `<h2>💥 Surprises possibles</h2><p class="note">Outsiders à qui notre modèle donne nettement plus de chances que les bookmakers. Attention : sur les saisons passées, les bookmakers avaient le plus souvent raison. C'est une piste, pas un conseil.</p><div class="grid2">${sup.map(surpriseHtml).join('')}</div>` : ''}
  `;
  view.querySelectorAll('[data-day]').forEach((b) => b.onclick = () => { state.day = b.dataset.day; state.q = ''; render(); });
  const dBar = view.querySelector('.days'), dAct = view.querySelector('.day.active');
  if (dBar && dAct) dBar.scrollLeft = dAct.offsetLeft - dBar.offsetLeft - dBar.clientWidth / 2 + dAct.clientWidth / 2;
  $('#q').oninput = debounce((e) => { state.q = e.target.value.trim(); render(); const q = $('#q'); q.focus(); q.setSelectionRange(q.value.length, q.value.length); }, 300);
  $('#comp').onchange = (e) => { state.comp = e.target.value; render(); };
  $('#vOnly').onchange = (e) => { state.valueOnly = e.target.checked; render(); };
}

// ---------- onglet Semaine ----------
function miniRow(m) {
  const mp = mainPick(m);
  const left = m.state === 'pre' ? fTime.format(new Date(m.date)) : m.state === 'in' ? `<span style="color:var(--live)">${m.hs}-${m.as}</span>` : `${m.hs}-${m.as}`;
  return `<div class="mini" data-id="${m.id}"><div class="t">${left}</div>
    <div class="n">${img(m.h.logo)}${esc(m.h.short)} <span class="muted">–</span> ${img(m.a.logo)}${esc(m.a.short)} ${bigMatch(m) ? '🔥' : ''}</div>${conf(mp.stars)}</div>`;
}
function renderSemaine() {
  const t = todayKey();
  let html = '<h2>🗓️ Les 7 prochains jours</h2><p class="note">🔥 = choc entre deux équipes fortes. Les barres indiquent la confiance du prono principal.</p>';
  for (let d = 0; d < 7; d++) {
    const k = addDays(t, d), ms = M.matches.filter((m) => dayKey(m.date) === k);
    if (!ms.length) continue;
    html += `<div class="day-head">${fDay.format(noon(k))} <span class="small muted">${ms.length} matchs</span></div>`;
    html += groupByComp(ms).map(([slug, list]) => `<div class="card" style="margin-bottom:10px;overflow:hidden"><div class="list-head">${img(comp(slug).logo, '')}${esc(comp(slug).name)}</div>${list.map(miniRow).join('')}</div>`).join('');
  }
  view.innerHTML = html;
}

// ---------- Combinés : paris disponibles pour chaque match ----------
const LEAGUES = ['eng.1', 'esp.1', 'ita.1', 'ger.1', 'fra.1'];
const r2 = (x) => Math.round(x * 100) / 100;
const PLAYER_TYPES = {
  Scorer: { field: 'pg', label: 'buteur', name: 'Buteur' },
  Assist: { field: 'pa', label: 'passeur décisif', name: 'Passeur' },
  Decisive: { field: 'pd', label: 'décisif (but ou passe)', name: 'Décisif' },
};
const estOdds = (p) => r2(Math.max(1.02, 0.91 / p)); // cote estimée au taux de retour français (≈ 91 %) quand le bookmaker ne la donne pas
// Tous les paris qu'on peut mettre dans un combiné pour un match.
function legFor(m, type, key, allowAbsent = false) {
  const p = m.pred, x = m.odds.x12, names = { h: m.h.short, a: m.a.short };
  let prob, o = null, est = false, label, status = null, absInfo = null;
  if (type === '1N2') {
    prob = p.p[key]; o = x?.[{ h: 0, d: 1, a: 2 }[key]] ?? null;
    label = key === 'd' ? 'Match nul' : `Victoire ${names[key]}`;
  } else if (type === 'DC') {
    prob = p.dc[key]; label = { '1N': `${names.h} ou nul`, 'N2': `Nul ou ${names.a}`, '12': `${names.h} ou ${names.a}` }[key];
    if (x) { const pr = { '1N': [x[0], x[1]], 'N2': [x[1], x[2]], '12': [x[0], x[2]] }[key]; o = r2(1 / (1 / pr[0] + 1 / pr[1])); est = true; }
  } else if (type === 'Buts') {
    const L = key.slice(1), over = key[0] === 'o';
    prob = over ? p.goals[L] : 1 - p.goals[L];
    label = `${over ? 'Plus' : 'Moins'} de ${L.replace('.', ',')} buts`;
    if (m.odds.ou && String(m.odds.ou.line) === String(parseFloat(L))) o = over ? m.odds.ou.over : m.odds.ou.under;
  } else if (type === 'BTTS') {
    prob = key === 'yes' ? p.btts : 1 - p.btts; label = key === 'yes' ? 'Les deux équipes marquent' : 'Une équipe ne marque pas';
  } else if (PLAYER_TYPES[type]) {
    // Paris joueurs : buteur (cote Bet365 quand elle existe), passeur, décisif (but ou passe)
    const pl = [...m.players.h, ...m.players.a].find((x) => x.id === key);
    if (!pl || (pl.status === 'absent' && !allowAbsent)) return null;
    prob = pl[PLAYER_TYPES[type].field]; label = `${pl.name} ${PLAYER_TYPES[type].label}`;
    if (type === 'Scorer' && pl.o) o = pl.o;
    status = pl.status; absInfo = pl.absInfo;
  }
  if (prob == null) return null;
  if (!o) { o = estOdds(Math.max(prob, 0.01)); est = true; }
  return { id: `${m.id}|${type}|${key}`, mid: m.id, type, key, label, p: r2(prob * 100) / 100, odds: o, est, match: `${m.h.short} - ${m.a.short}`, date: m.date, slug: m.slug, status, absInfo };
}
function playerLegs(m) {
  const out = [];
  for (const pl of [...m.players.h, ...m.players.a]) for (const t of Object.keys(PLAYER_TYPES)) out.push(legFor(m, t, pl.id));
  return out.filter((l) => l && l.p >= 0.15 && l.p <= 0.95 && l.odds >= 1.05);
}
// Paris peu intéressants qu'on limite dans les suggestions : « moins de … buts » et « X ou Y » (double chance sans le nul)
const isBoring = (l) => (l.type === 'DC' && l.key === '12') || (l.type === 'Buts' && /^u/.test(l.key || ''));
let allowBoring = false;
try { allowBoring = localStorage.getItem('parisClassiques') === '1'; } catch (e) {}
function allLegs(m, withPlayers = false, all = false) {
  const out = [];
  for (const k of ['h', 'd', 'a']) out.push(legFor(m, '1N2', k));
  for (const k of ['1N', 'N2', '12']) out.push(legFor(m, 'DC', k));
  for (const L of ['0.5', '1.5', '2.5', '3.5']) { out.push(legFor(m, 'Buts', 'o' + L)); out.push(legFor(m, 'Buts', 'u' + L)); }
  out.push(legFor(m, 'BTTS', 'yes'), legFor(m, 'BTTS', 'no'));
  const legs = out.filter((l) => l && l.p >= 0.15 && l.p <= 0.97 && l.odds >= 1.05 && (all || allowBoring || !isBoring(l)));
  return withPlayers ? legs.concat(playerLegs(m)) : legs;
}
const legById = (id, allowAbsent = false) => { const [mid, type, key] = id.split('|'); const m = M.matches.find((x) => x.id === mid); return m ? legFor(m, type, key, allowAbsent) : null; };
// Alerte sur un pari de Mon combiné quand la compo ou les blessures changent la donne
function legWarn(l) {
  if (l.gone) return '<span class="tag lose">⚠️ Match plus disponible</span>';
  if (!PLAYER_TYPES[l.type]) return '';
  if (l.status === 'absent') return `<span class="tag lose" title="${esc(l.absInfo || '')}">⚠️ ${l.absInfo ? esc(l.absInfo.split(' · ')[0]) : 'Absent de la compo'}</span>`;
  if (l.status === 'remplaçant') return '<span class="tag big">⚠️ Remplaçant</span>';
  if (l.status === 'incertain') return `<span class="tag big" title="${esc(l.absInfo || '')}">⚠️ Incertain</span>`;
  if (l.status === 'titulaire') return '<span class="tag win">✓ Titulaire</span>';
  return '';
}

// ---------- Générateur : la meilleure combinaison pour une cote visée ----------
// On cherche n paris (matchs différents) dont la cote totale est proche de la cible,
// en gardant les paris les plus probables pour leur cote. Les vraies cotes sont préférées aux cotes estimées.
function rng(seed) { let s = seed >>> 0 || 1; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
function generate(pool, n, target, seed = 1, exclude = null, withPlayers = false) {
  const byMatch = new Map();
  for (const m of pool) { const legs = allLegs(m, withPlayers).filter((l) => !exclude?.has(l.id)); if (legs.length) byMatch.set(m.id, legs); }
  if (byMatch.size < n) return null;
  const rand = rng(seed), mids = [...byMatch.keys()];
  const legScore = (l) => Math.log(l.p * l.odds) - (l.est ? 0.04 : 0);
  // Avec « joueurs » coché : au moins un pari joueur dans le combiné
  const noPlayer = (set) => withPlayers && !set.some((l) => PLAYER_TYPES[l.type]);
  const score = (set) => { const lo = set.reduce((t, l) => t + Math.log(l.odds), 0); return set.reduce((t, l) => t + legScore(l), 0) - 2.5 * Math.abs(lo - Math.log(target)) - (noPlayer(set) ? 10 : 0); };
  const per = Math.pow(target, 1 / n);
  // départ : pour chaque match, le pari le plus proche de la cote par pari visée
  let cands = mids.map((id) => byMatch.get(id).reduce((b, l) => (Math.abs(Math.log(l.odds / per)) - legScore(l) < Math.abs(Math.log(b.odds / per)) - legScore(b) ? l : b)));
  cands.sort((a, b) => (Math.abs(Math.log(a.odds / per)) - legScore(a)) - (Math.abs(Math.log(b.odds / per)) - legScore(b)) + (rand() - 0.5) * 0.15 * seed);
  let set = cands.slice(0, n);
  if (noPlayer(set)) {
    // on remplace le dernier pari par le meilleur pari joueur d'un autre match
    const used = new Set(set.slice(0, n - 1).map((l) => l.mid));
    const pl = [...byMatch.values()].flat().filter((l) => PLAYER_TYPES[l.type] && !used.has(l.mid))
      .sort((a, b) => (legScore(b) - Math.abs(Math.log(b.odds / per))) - (legScore(a) - Math.abs(Math.log(a.odds / per))) + (rand() - 0.5) * 0.3 * seed)[0];
    if (pl) set[n - 1] = pl;
  }
  let best = score(set);
  for (let it = 0; it < 1500; it++) {
    const i = Math.floor(rand() * n), used = new Set(set.map((l) => l.mid));
    const mid = rand() < 0.5 ? set[i].mid : mids[Math.floor(rand() * mids.length)];
    if (mid !== set[i].mid && used.has(mid)) continue;
    const legs = byMatch.get(mid), cand = legs[Math.floor(rand() * legs.length)];
    const next = set.slice(); next[i] = cand;
    const sc = score(next);
    if (sc > best) { set = next; best = sc; }
  }
  set.sort((a, b) => a.date.localeCompare(b.date));
  return { legs: set, odds: set.reduce((t, l) => t * l.odds, 1), p: set.reduce((t, l) => t * l.p, 1) };
}

// ---------- Mon combiné (gardé sur ce téléphone) ----------
const MY_KEY = 'monCombine';
let my = [];
try { my = JSON.parse(localStorage.getItem(MY_KEY) || '[]'); } catch (e) { my = []; }
const saveMy = () => { try { localStorage.setItem(MY_KEY, JSON.stringify(my)); } catch (e) {} updateMyCount(); };
function updateMyCount() { const c = $('#myCount'); if (c) { c.hidden = !my.length; c.textContent = my.length; } updatePill(); }
function addLeg(id, silent) {
  buzz(10);
  if (my.find((l) => l.id === id)) { if (!silent) toast('Déjà dans ton combiné'); return; }
  const l = legById(id); if (!l) return;
  my.push({ id, odds: l.odds, est: l.est, label: l.label, match: l.match, date: l.date, mid: l.mid, type: l.type });
  saveMy(); if (!silent) toast(`Ajouté : ${l.label}`);
}
function toast(msg) {
  let t = $('#toast'); if (!t) { t = document.createElement('div'); t.id = 'toast'; t.className = 'toast'; document.body.appendChild(t); }
  t.textContent = msg; t.classList.add('show'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 1800);
}

// ---------- onglet Combinés ----------
const cState = { scope: 'all', period: 7, n: 3, target: 4, seed: 1, mise: 10, seen: new Set(), last: null, players: false };
try { cState.players = localStorage.getItem('combiJoueurs') === '1'; } catch (e) {}
const resetGen = () => { cState.seed = 1; cState.seen = new Set(); };
const sliderToOdds = (v) => r2(1.5 * Math.pow(50 / 1.5, v / 100));
const oddsToSlider = (o) => Math.round((100 * Math.log(o / 1.5)) / Math.log(50 / 1.5));
function poolFor(scope, days) {
  const lim = Date.now() + days * 864e5;
  return M.matches.filter((m) => isPre(m) && Date.parse(m.date) < lim && Date.parse(m.date) > Date.now() + 5 * 60e3 &&
    (scope === 'all' || (scope === 'ldc' && m.slug === 'uefa.champions') || (scope === 'euro' && /^uefa\.(champions|europa|europa\.conf)$/.test(m.slug)) || (scope === 'leagues' && LEAGUES.includes(m.slug)) || scope === m.slug));
}
function legRow(l, extra = '') {
  const m = M.matches.find((x) => x.id === l.mid);
  return `<div class="leg"><div style="min-width:0"><small>${m ? img(m.h.logo, 'logo', 'width:13px;height:13px;vertical-align:-2px') + ' ' : ''}${esc(l.match)} · ${fDayShort.format(new Date(l.date))} ${fTime.format(new Date(l.date))}</small><b>${esc(l.label)}</b> <span class="small muted">${pct(l.p)}</span></div>${extra || `<span class="o">${odd(l.odds)}${l.est ? '≈' : ''}</span>`}</div>`;
}
function genCard(c, title, sub, id) {
  if (!c) return `<div class="card combo"><div class="eyebrow">${title}</div><div class="empty" style="padding:18px 0">Pas assez de matchs à venir pour ce combiné.</div></div>`;
  return `<div class="card combo">
    <div class="row-between"><div><div class="eyebrow">${title}</div><div class="combo-total">${odd(c.odds)}</div>${sub ? `<div class="small muted">${sub}</div>` : ''}</div>
      <div class="ring" style="--p:${Math.round(c.p * 100)};background:conic-gradient(var(--accent) calc(var(--p)*1%),var(--surface-3) 0)"><span style="background:var(--surface);color:var(--text)">${pctN(c.p)}%</span></div></div>
    <div class="combo-legs">${c.legs.map((l) => legRow(l)).join('')}</div>
    <div class="row-between"><span class="small muted">Chances que tout passe : <b>${pct(c.p)}</b></span><button class="btn-sm" data-addall="${esc(c.legs.map((l) => l.id).join(','))}">+ Mon combiné</button></div>
  </div>`;
}
function renderCombis() {
  refreshSoonLineups();
  const ldcPool = poolFor('ldc', 7), euroPool = poolFor('euro', 7), lgPool = poolFor('leagues', 7);
  const cupPool = ldcPool.length >= 2 ? ldcPool : euroPool, cupName = ldcPool.length >= 2 ? 'Ligue des champions' : "Coupes d'Europe";
  const wp = cState.players;
  const sugg = [
    [cupName, 'Sûr', generate(cupPool, 2, 2, 3, null, wp)], [cupName, 'Audacieux', generate(cupPool, 4, 8, 5, null, wp)],
    ['Championnats', 'Sûr', generate(lgPool, 3, 2.5, 7, null, wp)], ['Championnats', 'Audacieux', generate(lgPool, 5, 12, 9, null, wp)],
  ];
  const pool = poolFor(cState.scope, cState.period);
  // « Autre proposition » : on écarte les paris déjà proposés (on repart de zéro quand il n'en reste plus assez)
  let gen = generate(pool, cState.n, cState.target, cState.seed, cState.seen, wp);
  if (!gen && cState.seen.size) { cState.seen = new Set(); gen = generate(pool, cState.n, cState.target, cState.seed, null, wp); }
  cState.last = gen;
  const scopes = [['all', 'Tout'], ['ldc', 'LDC'], ['euro', "Coupes d'Europe"], ['leagues', 'Championnats'], ...LEAGUES.map((s) => [s, comp(s).name])];
  // On garde tous les paris, même devenus impossibles (joueur absent…), pour pouvoir prévenir.
  const myLegs = my.map((x) => { const l = legById(x.id, true); return l ? { ...l, odds: x.odds, est: x.est } : { ...x, label: x.label || 'Pari', match: x.match || '', date: x.date || new Date().toISOString(), p: 0, gone: true }; });
  const warnings = myLegs.filter((l) => l.gone || l.status === 'absent' || l.status === 'remplaçant' || l.status === 'incertain').length;
  const myOdds = myLegs.reduce((t, l) => t * (Number(l.odds) || 1), 1), myP = myLegs.reduce((t, l) => t * (l.p || 0), 1);
  const sameMatch = new Set(myLegs.map((l) => l.mid)).size < myLegs.length;
  const legVerdict = (l) => { const m = M.matches.find((x) => x.id === l.mid); if (!m || m.hs == null || m.state === 'pre') return '';
    if (PLAYER_TYPES[l.type]) return `<span class="tag">${m.state === 'in' ? '● ' : ''}${m.hs}-${m.as}</span>`; /* pas de suivi buteur en direct */ const w = gradePick(l, m.hs, m.as); return m.completed ? (w ? '<span class="tag win">✓</span>' : '<span class="tag lose">✗</span>') : `<span class="tag ${w ? 'win' : 'lose'}">● ${m.hs}-${m.as}</span>`; };

  view.innerHTML = `
    <h2>🎯 Combinés</h2>
    ${dailyComboHtml(true)}
    <div class="card pad gen">
      <div class="eyebrow">Générateur de combiné ${info('generateur')}</div>
      <div class="filters" style="margin-top:10px"><div class="chips">${scopes.map(([k, l]) => `<button class="chip ${cState.scope === k ? 'active' : ''}" data-scope="${k}">${l}</button>`).join('')}</div></div>
      <div class="filters" style="margin:4px 0 12px">
        <div class="segmented">${[[1, "Aujourd'hui"], [2, '48 h'], [7, '7 jours']].map(([d, l]) => `<button class="${cState.period === d ? 'active' : ''}" data-period="${d}">${l}</button>`).join('')}</div>
        <label class="switch"><input type="checkbox" id="withPlayers" ${wp ? 'checked' : ''}><span class="sw"></span>Inclure les joueurs <span class="small muted">(au moins 1 pari buteur, passeur ou décisif)</span></label>
        <label class="switch"><input type="checkbox" id="withBoring" ${allowBoring ? 'checked' : ''}><span class="sw"></span>Autoriser « moins de … buts » et « X ou Y »</label>
      </div>
      <div class="gen-ctrls">
        <div class="ctrl"><label>Cote visée <b id="tVal">${odd(cState.target)}</b></label>
          <input type="range" id="tRange" min="0" max="100" value="${oddsToSlider(cState.target)}"><div class="range-ends"><span>1,50</span><span>50</span></div></div>
        <div class="ctrl"><label>Nombre de paris</label>
          <div class="stepper"><button data-step="-1" aria-label="Moins">−</button><b>${cState.n}</b><button data-step="1" aria-label="Plus">+</button></div></div>
      </div>
      ${gen ? `<div class="gen-res"><div class="row-between"><div><div class="small muted">Cote obtenue</div><div class="combo-total">${odd(gen.odds)}</div></div>
          <div class="ring" style="--p:${Math.round(gen.p * 100)};background:conic-gradient(var(--accent) calc(var(--p)*1%),var(--surface-3) 0)"><span style="background:var(--surface);color:var(--text)">${pctN(gen.p)}%</span></div></div>
        <div class="combo-legs">${gen.legs.map((l) => legRow(l)).join('')}</div>
        <div class="row-between"><button class="btn-sm ghost" id="reroll">↻ Autre proposition</button><button class="btn-sm" data-addall="${esc(gen.legs.map((l) => l.id).join(','))}">+ Mon combiné</button></div></div>`
        : `<div class="empty">Pas assez de matchs (${pool.length}) pour ${cState.n} paris. Élargis la période ou la compétition.</div>`}
      <p class="note">Le générateur prend un pari par match et cherche les paris les plus probables pour atteindre la cote visée. Cotes ≈ : estimées (pas de cote bookmaker disponible pour ce pari).</p>
    </div>

    <h2>📝 Mon combiné ${myLegs.length ? `<span class="tag">${myLegs.length} pari${myLegs.length > 1 ? 's' : ''}</span>` : ''}</h2>
    <div class="card pad">
      ${myLegs.length ? `<div class="combo-legs" style="margin-top:0">${warnings ? `<p class="note warn-note">⚠️ ${warnings} pari${warnings > 1 ? 's' : ''} à vérifier : compo, blessure ou match indisponible. Retire-le${warnings > 1 ? 's' : ''} ou remplace-le${warnings > 1 ? 's' : ''}.</p>` : ''}${myLegs.map((l) => legRow(l, `<div class="my-ctl">${legWarn(l)}${legVerdict(l)}<input class="odd-in" type="number" step="0.01" min="1.01" inputmode="decimal" value="${r2(l.odds)}" data-odds="${esc(l.id)}" title="Mets ici ta cote Betclic si tu veux"><button class="x" data-del="${esc(l.id)}" aria-label="Retirer">✕</button></div>`)).join('')}</div>
        ${sameMatch ? '<p class="note">⚠️ Plusieurs paris sur le même match : les bookmakers les refusent souvent dans un combiné.</p>' : ''}
        <div class="my-sum">
          <div><div class="small muted">Cote totale</div><div class="combo-total">${odd(myOdds)}</div></div>
          <div><div class="small muted">Chances (modèle)</div><div class="combo-total" style="font-size:20px">${pct(myP)}</div></div>
          <div><div class="small muted">Mise</div><input type="number" id="mise" min="0" step="1" value="${cState.mise}" inputmode="decimal"> €</div>
          <div><div class="small muted">Gain possible</div><div class="combo-total" style="font-size:20px">${(cState.mise * myOdds).toFixed(2).replace('.', ',')} €</div></div>
        </div>
        <div class="row-between" style="margin-top:12px"><span class="note" style="margin:0">Tu peux remplacer chaque cote par celle de Betclic.</span><button class="btn-sm ghost" id="clearMy">Vider</button></div>`
        : '<div class="empty" style="padding:20px 0">Ton combiné est vide.<br>Ajoute des paris avec <b>+ Mon combiné</b>, ou depuis la fiche d\'un match (onglet Pronos).</div>'}
    </div>

    <h2>💡 Combinés proposés</h2>
    <div class="grid2">${sugg.map(([t, s, c], i) => genCard(c, `${t} · ${s}`, s === 'Sûr' ? 'Cote visée ≈ 2' : 'Cote visée plus haute', i)).join('')}</div>
  `;
  view.querySelectorAll('[data-scope]').forEach((b) => b.onclick = () => { cState.scope = b.dataset.scope; resetGen(); render(); });
  view.querySelectorAll('[data-period]').forEach((b) => b.onclick = () => { cState.period = +b.dataset.period; resetGen(); render(); });
  view.querySelectorAll('[data-step]').forEach((b) => b.onclick = () => { cState.n = Math.min(10, Math.max(2, cState.n + +b.dataset.step)); resetGen(); render(); });
  const tr = $('#tRange');
  tr.oninput = () => { $('#tVal').textContent = odd(sliderToOdds(+tr.value)); };
  tr.onchange = () => { cState.target = sliderToOdds(+tr.value); resetGen(); render(); };
  $('#withBoring').onchange = (e) => { allowBoring = e.target.checked; try { localStorage.setItem('parisClassiques', allowBoring ? '1' : '0'); } catch (x) {} resetGen(); render(); };
  $('#withPlayers').onchange = (e) => { cState.players = e.target.checked; try { localStorage.setItem('combiJoueurs', cState.players ? '1' : '0'); } catch (x) {} resetGen(); render(); };
  $('#reroll')?.addEventListener('click', () => { for (const l of cState.last?.legs || []) cState.seen.add(l.id); cState.seed++; render(); });
  view.querySelectorAll('[data-addall]').forEach((b) => b.onclick = () => { const ids = b.dataset.addall.split(','); ids.forEach((id) => addLeg(id, true)); toast(`${ids.length} paris ajoutés à ton combiné`); render(); });
  view.querySelectorAll('[data-del]').forEach((b) => b.onclick = () => { my = my.filter((l) => l.id !== b.dataset.del); saveMy(); render(); });
  view.querySelectorAll('[data-odds]').forEach((inp) => inp.onchange = () => { const l = my.find((x) => x.id === inp.dataset.odds); const v = parseFloat(String(inp.value).replace(',', '.')); if (l && v > 1) { l.odds = v; l.est = false; saveMy(); render(); } });
  $('#mise')?.addEventListener('change', (e) => { cState.mise = Math.max(0, parseFloat(e.target.value) || 0); render(); });
  $('#clearMy')?.addEventListener('click', () => { my = []; saveMy(); render(); });
}

// ---------- onglet Joueurs ----------
const oddCell = (p) => (p.o ? `<span class="o ${p.value ? 'val' : ''}" title="Cote buteur France estimée (d'après Bet365)">${p.value ? '◆ ' : ''}${odd(p.o)}</span>` : '<span class="o">–</span>');
function renderJoueurs() {
  const pre = M.matches.filter((m) => isPre(m) && Date.parse(m.date) - Date.now() < 3 * 864e5);
  let rows = [];
  for (const m of pre) for (const side of ['h', 'a']) for (const p of m.players[side]) {
    if (p.status !== 'absent') rows.push({ ...p, match: m, team: m[side], opp: m[side === 'h' ? 'a' : 'h'] });
  }
  if (state.pComp !== 'all') rows = rows.filter((r) => r.match.slug === state.pComp);
  if (state.pValue) rows = rows.filter((r) => r.value);
  rows.sort((a, b) => b[state.pSort] - a[state.pSort]);
  const comps = [...new Set(pre.map((m) => m.slug))];
  const seg = (k, l) => `<button class="${state.pSort === k ? 'active' : ''}" data-sort="${k}">${l}</button>`;
  view.innerHTML = `
    <h2>⚽ Joueurs décisifs</h2>
    <p class="note">Matchs des 3 prochains jours. Chances calculées à partir des buts et passes du joueur dans la compétition et des buts attendus de son équipe, mélangées à la cote buteur du marché.</p>
    <div class="filters"><div class="segmented">${seg('pd', 'Décisif')}${seg('pg', 'Buteur')}${seg('pa', 'Passeur')}</div>
      <select id="pComp"><option value="all">Toutes les compétitions</option>${comps.map((c) => `<option value="${c}" ${c === state.pComp ? 'selected' : ''}>${esc(comp(c).name)}</option>`).join('')}</select></div>
    <div class="card" style="overflow:hidden">
      <div class="player headrow"><span>Joueur</span><span class="${state.pSort === 'pg' ? 'sort-active' : ''}">But</span><span class="${state.pSort === 'pa' ? 'sort-active' : ''}">Passe</span><span class="${state.pSort === 'pd' ? 'sort-active' : ''}">Décisif</span><span>Cote</span></div>
      ${rows.slice(0, 60).map((r) => `<div class="player mc" data-id="${r.match.id}" style="border-radius:0;box-shadow:none;border-width:0 0 1px">
        <div class="pn"><b>${esc(r.name)}</b> ${r.status === 'titulaire' ? '<span class="tag win">Titulaire</span>' : r.status === 'remplaçant' ? '<span class="tag">Remplaçant</span>' : r.status === 'incertain' ? `<span class="tag big" title="${esc(r.absInfo || '')}">Incertain</span>` : ''}
        <small>${img(r.team.logo, 'logo', 'width:13px;height:13px;vertical-align:-2px')} ${esc(r.team.short)} vs ${esc(r.opp.short)} · ${r.g} b. ${r.a} p. en ${esc(comp(r.match.slug).short)}</small></div>
        <span class="v">${pct(r.pg)}</span><span class="v">${pct(r.pa)}</span><span class="v">${pct(r.pd)}</span>${oddCell(r)}
      </div>`).join('') || `<div class="empty">${state.pValue ? 'Aucun value buteur pour le moment.' : 'Pas de données joueurs pour le moment.'}</div>`}
    </div>
    <p class="note">Cote = buteur à tout moment, <b>estimation France</b> (≈ Betclic), calculée d'après Bet365. Pas de cotes passeur chez ESPN.</p>`;
  view.querySelectorAll('[data-sort]').forEach((b) => b.onclick = () => { state.pSort = b.dataset.sort; render(); });
  $('#pComp').onchange = (e) => { state.pComp = e.target.value; render(); };
}

// ---------- onglet Classements (+ buteurs / passeurs) ----------
function renderClassements() {
  const tables = S.tables.filter((t) => t.groups.some((g) => g.rows.length));
  if (!tables.length) { view.innerHTML = '<div class="card empty">Classements indisponibles.</div>'; return; }
  if (!state.standing || !tables.find((t) => t.slug === state.standing)) state.standing = tables[0].slug;
  const t = tables.find((x) => x.slug === state.standing);
  const sc = (S.scorers || []).find((x) => x.slug === state.standing);
  const seg = (k, l) => `<button class="${state.stView === k ? 'active' : ''}" data-view="${k}">${l}</button>`;
  let body = '';
  if (state.stView === 'table') {
    body = t.groups.map((g) => `${t.groups.length > 1 ? `<h3>${esc(g.name)}</h3>` : ''}<div class="card table-wrap"><table>
      <thead><tr><th class="zone"></th><th>#</th><th class="l">Équipe</th><th>Pts</th><th>J</th><th>G</th><th>N</th><th>P</th><th>Diff</th></tr></thead>
      <tbody>${g.rows.map((r) => `<tr title="${esc(r.note)}"><td class="zone" style="background:${r.color ? '#' + r.color.replace('#', '') : 'transparent'}"></td><td><span class="pos">${r.rank ?? ''}</span></td>
        <td class="l"><div class="team">${img(r.logo)}<span>${esc(r.short || r.name)}</span></div></td>
        <td><b>${r.pts ?? ''}</b></td><td>${r.pj ?? ''}</td><td>${r.g ?? ''}</td><td>${r.n ?? ''}</td><td>${r.p ?? ''}</td><td class="${r.diff > 0 ? 'up' : r.diff < 0 ? 'down' : ''}">${r.diff > 0 ? '+' : ''}${r.diff ?? ''}</td></tr>`).join('')}</tbody>
    </table></div>`).join('') +
      [...new Set(t.groups.flatMap((g) => g.rows.filter((r) => r.note).map((r) => `${r.color}|${r.note}`)))].map((x) => { const [c, n] = x.split('|'); return `<div class="note"><span style="display:inline-block;width:10px;height:10px;border-radius:3px;background:#${c.replace('#', '')}"></span> ${esc(n)}</div>`; }).join('');
  } else {
    const list = sc ? (state.stView === 'goals' ? sc.goals : sc.assists) : [];
    const unit = state.stView === 'goals' ? 'but' : 'passe';
    body = `<div class="card" style="overflow:hidden">${list.length ? list.map((p, i) => `<div class="rank-row"><span class="pos">${i + 1}</span>
      <div class="who"><b>${esc(p.name)}</b><small>${img(p.logo, '')}${esc(p.team)}${p.m ? ` · ${p.m} m. · ${(p.v / p.m).toFixed(2).replace('.', ',')}/match` : ''}</small></div>
      <span></span><span class="big">${p.v}</span></div>`).join('') : `<div class="empty">Pas de classement des ${unit}s pour cette compétition.</div>`}</div>`;
  }
  view.innerHTML = `
    <h2>🏆 Classements</h2>
    <div class="filters"><div class="chips">${tables.map((x) => `<button class="chip ${x.slug === state.standing ? 'active' : ''}" data-st="${x.slug}">${img(comp(x.slug).logo, '')}${esc(comp(x.slug).name)}</button>`).join('')}</div></div>
    <div class="filters"><div class="segmented">${seg('table', 'Classement')}${seg('goals', 'Buteurs')}${seg('assists', 'Passeurs')}</div></div>
    ${body}`;
  view.querySelectorAll('[data-st]').forEach((b) => b.onclick = () => { state.standing = b.dataset.st; render(); });
  view.querySelectorAll('[data-view]').forEach((b) => b.onclick = () => { state.stView = b.dataset.view; render(); });
}

// ---------- onglet Performance ----------
function isoWeek(d) {
  const x = noon(dayKey(d)); const day = (x.getUTCDay() + 6) % 7; x.setUTCDate(x.getUTCDate() - day + 3);
  const y = x.getUTCFullYear(), j4 = new Date(Date.UTC(y, 0, 4));
  return `${y}-S${String(1 + Math.round(((x - j4) / 864e5 - 3 + ((j4.getUTCDay() + 6) % 7)) / 7)).padStart(2, '0')}`;
}
function renderPerf() {
  const done = Object.values(HIST).filter((h) => h.result && !h.result.void);
  const picks = done.flatMap((h) => h.picks.filter((p) => p.win != null).map((p) => ({ ...p, h })));
  const pending = Object.values(HIST).filter((h) => !h.result).length;
  if (!picks.length) {
    view.innerHTML = `<h2>📈 Performance</h2>${comboPerfHtml()}${tuneHtml()}<div class="card pad empty"><div style="font-size:36px">⏳</div><b>Le suivi démarre</b><br>Pas encore de match terminé avec un prono enregistré avant le coup d'envoi.<br>${pending} pronos attendent leur résultat.</div>`;
    return;
  }
  const agg = (arr) => { const n = arr.length, w = arr.filter((p) => p.win).length; return { n, w, r: n ? w / n : 0 }; };
  const profit = (arr) => { const a = arr.filter((p) => p.odds && !p.est); const s = a.reduce((t, p) => t + (p.win ? p.odds - 1 : -1), 0); return { n: a.length, s, roi: a.length ? s / a.length : 0 }; };
  const all = agg(picks), main = agg(picks.filter((p) => p.type === '1N2'));
  const pr = profit(picks.filter((p) => p.type === '1N2' || p.type === 'Value'));
  const rowsBy = (keyFn, labelFn, sortFn) => {
    const g = new Map(); for (const p of picks) { const k = keyFn(p); if (!g.has(k)) g.set(k, []); g.get(k).push(p); }
    return [...g.entries()].sort(sortFn || ((a, b) => b[1].length - a[1].length)).map(([k, arr]) => { const a = agg(arr), pf = profit(arr); return `<tr><td class="l">${labelFn(k)}</td><td>${a.n}</td><td>${a.w}</td><td><span class="rate">${pct(a.r)}</span></td><td><div class="meter"><i style="width:${a.r * 100}%"></i></div></td><td class="${pf.s >= 0 ? 'up' : 'down'}">${pf.n ? (pf.s >= 0 ? '+' : '') + pf.s.toFixed(1) : '–'}</td></tr>`; }).join('');
  };
  const table = (title, body, first = '') => `<h3>${title}</h3><div class="card table-wrap"><table><thead><tr><th class="l">${first}</th><th>Pronos</th><th>Gagnés</th><th>Réussite</th><th></th><th title="Gains fictifs : 1 unité misée par prono avec une vraie cote">Gains</th></tr></thead><tbody>${body}</tbody></table></div>`;
  const monthName = fmt({ month: 'long', year: 'numeric' });
  const kpi = (v, l, p) => `<div class="card kpi">${p != null ? `<div class="ring" style="--p:${pctN(p)}"><span>${pctN(p)}%</span></div>` : ''}<div><div class="v">${v}</div><div class="l">${l}</div></div></div>`;
  view.innerHTML = `
    <h2>📈 Performance</h2>
    <div class="kpis">
      ${kpi(`${all.w}/${all.n}`, 'Réussite générale', all.r)}
      ${kpi(`${main.w}/${main.n}`, 'Résultat 1N2', main.r)}
      ${kpi(`<span class="${pr.s >= 0 ? 'up' : 'down'}">${pr.s >= 0 ? '+' : ''}${pr.s.toFixed(1)} u</span>`, `Gains fictifs · ROI ${pr.roi >= 0 ? '+' : ''}${(pr.roi * 100).toFixed(1)} %`)}
      ${kpi(done.length, `Matchs suivis · ${pending} en attente`)}
    </div>
    ${comboPerfHtml()}${tuneHtml()}
    ${table('Par type de prono', rowsBy((p) => p.type, (k) => TYPE_NAMES[k] || k), 'Type')}
    ${table('Par niveau de confiance', rowsBy((p) => p.stars, (k) => conf(+k), (a, b) => b[0] - a[0]), 'Confiance')}
    ${table('Par compétition', rowsBy((p) => p.h.slug, (k) => esc(comp(k).name)), 'Compétition')}
    ${table('Par semaine', rowsBy((p) => isoWeek(p.h.date), (k) => k.replace('-S', ' · semaine '), (a, b) => b[0].localeCompare(a[0])), 'Semaine')}
    ${table('Par mois', rowsBy((p) => dayKey(p.h.date).slice(0, 7), (k) => monthName.format(new Date(k + '-15T12:00:00Z')), (a, b) => b[0].localeCompare(a[0])), 'Mois')}
    <p class="note">Seuls les pronos enregistrés avant le coup d'envoi comptent. Matchs avec prolongation exclus. Gains fictifs : 1 unité par prono ayant une vraie cote.</p>`;
}

// ---------- fiche match ----------
function openMatch(id) {
  const m = M.matches.find((x) => x.id === id); if (!m) return;
  // match en cours ou terminé : on ouvre directement le fil du match
  let sub = m.state === 'pre' ? 'pronos' : 'direct';
  const body = $('#modalBody');
  modalId = id;
  modalDraw = () => {
    const cur = M.matches.find((x) => x.id === id);
    const tabs = [...(cur.state !== 'pre' ? [['direct', cur.state === 'in' ? '● Direct' : 'Résumé']] : []), ['pronos', 'Pronos'], ['fiche', 'Stats'], ['compos', 'Compos'], ['joueurs', 'Joueurs']];
    body.innerHTML = `
      <div class="fiche-head">
        <div class="comp">${img(comp(cur.slug).logo, '')} ${esc(comp(cur.slug).name)} · ${fDay.format(new Date(cur.date))}</div>
        <div class="head-fav">${favBtn(cur.id)}</div>
        <div class="fiche-teams"><div class="t"><span class="crest">${img(cur.h.logo, '')}</span>${esc(cur.h.short)}</div><div class="mid">${bigScore(cur)}</div><div class="t"><span class="crest">${img(cur.a.logo, '')}</span>${esc(cur.a.short)}</div></div>
        ${cur._live?.scorers ? `<div class="head-goals"><div>${cur._live.scorers.h.map(esc).join('<br>')}</div><div>${cur._live.scorers.a.map(esc).join('<br>')}</div></div>` : ''}
      </div>
      <div class="fiche-body">
        <div class="subtabs">${tabs.map(([k, l]) => `<button data-sub="${k}" class="${k === sub ? 'active' : ''}">${l}</button>`).join('')}</div>
        <div>${({ direct: ficheLive, pronos: fichePronos, fiche: ficheStats, compos: ficheCompos, joueurs: fichePlayers })[sub](cur)}</div>
      </div>`;
    body.querySelectorAll('[data-sub]').forEach((b) => b.onclick = () => { sub = b.dataset.sub; modalDraw(); });
    if (sub === 'compos') maybeFetchLineup(cur);
    if (sub === 'direct') fetchLive(cur);
  };
  modalDraw();
  const modal = $('#modal');
  modal.hidden = false; document.body.style.overflow = 'hidden';
  $('.sheet').scrollTop = 0; $('.sheet').style.transform = '';
  // bouton « retour » du téléphone : ferme la fiche au lieu de quitter l'appli
  try { history.pushState({ fiche: id }, ''); } catch (e) {}
}
function closeModal(fromHistory) {
  const modal = $('#modal'); if (modal.hidden) return;
  modal.hidden = true; document.body.style.overflow = ''; modalDraw = null; modalId = null;
  $('.sheet').style.transform = '';
  if (!fromHistory && history.state?.fiche) try { history.back(); } catch (e) {}
}
window.addEventListener('popstate', () => closeModal(true));

// ---------- fermer la fiche en la glissant vers le bas (comme sur iPhone) ----------
(() => {
  const sheet = $('.sheet'); let y0 = null, dy = 0, t0 = 0, dragging = false;
  sheet.addEventListener('touchstart', (e) => {
    // on ne commence à tirer que si la fiche est tout en haut (sinon c'est un défilement normal)
    if (sheet.scrollTop > 0 || e.touches.length > 1) { y0 = null; return; }
    y0 = e.touches[0].clientY; dy = 0; t0 = Date.now(); dragging = false;
  }, { passive: true });
  sheet.addEventListener('touchmove', (e) => {
    if (y0 == null) return;
    dy = e.touches[0].clientY - y0;
    if (dy > 6 && sheet.scrollTop <= 0) {
      dragging = true; e.preventDefault();
      sheet.style.transition = 'none';
      sheet.style.transform = `translateY(${dy}px)`;
      $('#modal').style.background = `rgba(2, 6, 23, ${Math.max(0, 0.55 - dy / 900)})`;
    } else if (dy < 0) { y0 = null; }
  }, { passive: false });
  sheet.addEventListener('touchend', () => {
    if (y0 == null || !dragging) { y0 = null; return; }
    const fast = dy / Math.max(1, Date.now() - t0) > 0.6;
    sheet.style.transition = 'transform .22s ease-out';
    $('#modal').style.background = '';
    if (dy > 120 || (fast && dy > 40)) {
      sheet.style.transform = 'translateY(100%)';
      setTimeout(() => { sheet.style.transition = ''; closeModal(); }, 200);
    } else sheet.style.transform = '';
    y0 = null; dragging = false;
  });
})();

// ---------- fil du match (temps forts + stats), lu en direct chez ESPN ----------
const EV = {
  goal: '⚽', 'goal---header': '⚽', 'goal---free-kick': '⚽', 'goal---volley': '⚽', 'penalty---scored': '⚽', 'own-goal': '⚽',
  'yellow-card': '🟨', 'red-card': '🟥', 'yellow-red-card': '🟥', substitution: '🔁', 'penalty---missed': '❌', 'penalty---saved': '🧤', halftime: '⏸️', 'end-regular-time': '🏁',
};
const EV_FR = { substitution: 'Remplacement', halftime: 'Mi-temps', 'end-regular-time': 'Fin du temps réglementaire', 'yellow-card': 'Carton jaune', 'red-card': 'Carton rouge', 'yellow-red-card': '2e jaune → rouge', 'own-goal': 'But contre son camp', 'penalty---scored': 'Penalty marqué', 'penalty---missed': 'Penalty manqué', 'penalty---saved': 'Penalty arrêté' };
const STATS_FR = [['possessionPct', 'Possession', '%'], ['totalShots', 'Tirs'], ['shotsOnTarget', 'Tirs cadrés'], ['wonCorners', 'Corners'], ['foulsCommitted', 'Fautes'], ['yellowCards', 'Cartons jaunes'], ['redCards', 'Cartons rouges'], ['offsides', 'Hors-jeu'], ['saves', 'Arrêts'], ['totalPasses', 'Passes'], ['passPct', 'Passes réussies', 'pct']];
async function fetchLive(m) {
  if (m._liveBusy || (m._live && Date.now() - m._live.ts < 25e3)) return;
  m._liveBusy = true;
  try {
    const s = await fetch(`${ESPN}/${m.slug}/summary?event=${m.id}`).then((r) => r.json());
    const events = (s.keyEvents || []).filter((k) => EV[k.type?.type] || /goal/.test(k.type?.type || '')).map((k) => ({
      type: k.type?.type, clock: k.clock?.displayValue || '', side: k.team?.id === m.h.id ? 'h' : k.team?.id === m.a.id ? 'a' : '',
      who: (k.participants || []).map((p) => p.athlete?.displayName).filter(Boolean), goal: !!k.scoringPlay || /goal|penalty---scored/.test(k.type?.type || ''),
    }));
    const stats = {};
    for (const t of s.boxscore?.teams || []) { const side = t.team?.id === m.h.id ? 'h' : 'a'; for (const x of t.statistics || []) (stats[x.name] ||= {})[side] = parseFloat(x.displayValue); }
    const scorers = { h: [], a: [] };
    for (const e of events) if (e.goal && e.side && e.who[0]) scorers[e.type === 'own-goal' ? (e.side === 'h' ? 'a' : 'h') : e.side].push(`${e.who[0]} ${e.clock}${e.type === 'own-goal' ? ' (csc)' : e.type === 'penalty---scored' ? ' (pen.)' : ''}`);
    m._live = { ts: Date.now(), events: events.reverse(), stats, scorers };
  } catch (e) { m._live = m._live || { ts: Date.now(), error: true, events: [], stats: {}, scorers: null }; }
  m._liveBusy = false;
  if (modalId === m.id && modalDraw) { const sh = $('.sheet'), top = sh.scrollTop; modalDraw(); sh.scrollTop = top; }
}
function ficheLive(m) {
  const L = m._live;
  if (!L) return '<div class="card pad empty"><div class="spinner"></div>Chargement du match…</div>';
  const statRow = ([k, label, unit]) => {
    const s = L.stats[k]; if (!s || (s.h == null && s.a == null)) return '';
    let h = s.h || 0, a = s.a || 0; if (unit === 'pct') { h = Math.round(h * 100); a = Math.round(a * 100); }
    const tot = h + a || 1, suf = unit ? ' %' : '';
    return `<div class="st-row"><div class="st-v ${h > a ? 'lead' : ''}">${h}${suf}</div><div class="st-mid"><div class="st-lab">${label}</div><div class="st-bar"><i style="width:${(h / tot) * 100}%"></i><i style="width:${(a / tot) * 100}%"></i></div></div><div class="st-v ${a > h ? 'lead' : ''}">${a}${suf}</div></div>`;
  };
  const evRow = (e) => {
    const icon = e.goal ? '⚽' : EV[e.type] || '•';
    const label = e.goal && e.type !== 'own-goal' ? `<b>${esc(e.who[0] || 'But')}</b>${e.who[1] ? ` <span class="muted small">passe : ${esc(e.who[1])}</span>` : ''}${e.type === 'penalty---scored' ? ' <span class="muted small">(penalty)</span>' : ''}` : e.type === 'substitution' && e.who.length >= 2 ? `<span class="up">↑ ${esc(e.who[0])}</span> <span class="down">↓ ${esc(e.who[1])}</span>` : `<b>${esc(e.who.join(', ') || EV_FR[e.type] || '')}</b>${e.who.length && EV_FR[e.type] && !e.goal ? ` <span class="muted small">${esc(EV_FR[e.type])}</span>` : e.goal && e.type !== 'goal' && EV_FR[e.type] ? ` <span class="muted small">${esc(EV_FR[e.type])}</span>` : ''}`;
    if (!e.side) return `<div class="ev-mid">${icon} ${label}${e.clock ? ` · ${esc(e.clock)}` : ''}</div>`;
    return `<div class="ev ${e.side} ${e.goal ? 'goal' : ''} ${e.type === 'substitution' ? 'sub' : ''}"><span class="ev-clock">${esc(e.clock)}</span><span class="ev-ico">${icon}</span><span class="ev-txt">${label}</span></div>`;
  };
  const statsHtml = STATS_FR.map(statRow).join('');
  return `${m.state === 'in' ? '<p class="note"><i class="dot-live"></i> Mis à jour automatiquement toutes les 30 secondes.</p>' : ''}
    <div class="card pad section"><h3 style="margin-top:0">Temps forts</h3>
      <div class="ev-head"><span>${img(m.h.logo, 'logo', 'width:18px;height:18px')} ${esc(m.h.short)}</span><span>${esc(m.a.short)} ${img(m.a.logo, 'logo', 'width:18px;height:18px')}</span></div>
      ${L.events.length ? `<div class="timeline">${L.events.map(evRow).join('')}</div>` : '<div class="empty" style="padding:16px">Pas encore de temps fort.</div>'}</div>
    ${statsHtml ? `<div class="card pad section"><h3 style="margin-top:0">Statistiques du match</h3>${statsHtml}</div>` : ''}`;
}

const mkRow = (label, p, o, extra = '', color = '') => `<div class="mk-row"><div class="lab"><span>${label}${extra}</span><div class="meter"><i style="width:${(p || 0) * 100}%;${color ? `background:${color}` : ''}"></i></div></div><span class="pct">${pct(p)}</span><span class="odd">${o ? odd(o) : ''}</span></div>`;
function fichePronos(m) {
  const p = m.pred, o = m.odds.x12, mv = oddsMove(m), g = p.goals, tg = p.teamGoals;
  const arrow = (i) => { const x = mv?.[i]; if (!x || Math.abs(x.diff) < 0.03) return ''; return ` <span class="${x.diff < 0 ? 'down' : 'up'} small">${x.diff < 0 ? '↘' : '↗'} ${odd(x.from)}</span>`; };
  const pickId = (x) => `${m.id}|${x.type === 'Value' ? (/^[ou]\d/.test(x.key) ? 'Buts' : '1N2') : x.type}|${x.key}`;
  const addBtn = (id) => (m.state === 'pre' ? `<button class="add" data-add="${esc(id)}" aria-label="Ajouter à mon combiné" title="Ajouter à mon combiné">+</button>` : '');
  const pickLine = (x) => `<div class="pick-card"><div><div class="k">${TYPE_NAMES[x.type]}</div><b>${esc(x.label)}</b>${x.edge ? ` <span class="tag value">+${Math.round(x.edge * 100)} %</span>` : ''}</div>
    <div style="display:flex;align-items:center;gap:10px"><div style="text-align:right">${conf(x.stars)}<div class="small" style="margin-top:3px"><b>${pct(x.p)}</b>${x.odds ? ' · ' + odd(x.odds) + (x.est ? '≈' : '') : ''}</div>${verdictTag(verdict(m, x))}</div>${addBtn(pickId(x))}</div></div>`;
  const legs = m.state === 'pre' ? allLegs(m, false, true) : [];
  return `
    ${m.why ? `<div class="card pad section why"><div class="eyebrow">💬 Pourquoi ce prono ${info('modele')}</div><p>${esc(m.why)}</p>
      ${m.trends?.length ? `<div class="trends">${m.trends.map((t) => `<div class="trend ${t.kind}"><span>${TREND_ICON[t.kind] || '📊'}</span>${esc(t.text)}</div>`).join('')}</div>` : ''}</div>` : ''}
    <div class="card pad section"><div class="eyebrow">Nos pronos ${info('confiance')}</div>${m.picks.map(pickLine).join('')}</div>
    ${legs.length ? `<div class="card pad section"><div class="row-between"><div class="eyebrow">Ajouter à mon combiné</div><span class="small muted">Tous les paris du match</span></div>
      <div class="leg-grid">${legs.map((l) => `<button class="leg-btn" data-add="${esc(l.id)}"><span>${esc(l.label)}</span><b>${odd(l.odds)}${l.est ? '≈' : ''}</b></button>`).join('')}</div></div>` : ''}
    <div class="card pad section"><h3 style="margin-top:0">Résultat 1N2 ${info('1n2')}</h3>
      <div class="mk">${mkRow(esc(m.h.short), p.p.h, o?.[0], arrow(0), 'var(--home)')}${mkRow('Match nul', p.p.d, o?.[1], arrow(1), 'var(--draw)')}${mkRow(esc(m.a.short), p.p.a, o?.[2], arrow(2), 'var(--away)')}</div>
      ${p.market ? `<p class="note">Modèle seul : ${pct(p.model.h)} / ${pct(p.model.d)} / ${pct(p.model.a)} · Bookmakers : ${pct(p.market.h)} / ${pct(p.market.d)} / ${pct(p.market.a)}</p><p class="note">Cotes affichées : <b>estimation France</b> (≈ Betclic, Winamax…), calculées d'après ${esc(m.odds.rawSrc || 'Bet365')}${m.odds.b365 ? ` (Bet365 : ${m.odds.b365.map(odd).join(' / ')})` : ''}. Les books français reversent moins (≈ 91 % des mises contre ≈ 94 %), d'où des cotes un peu plus basses. Pour un calcul exact, mets ta cote Betclic dans Mon combiné.</p>` : '<p class="note">Pas encore de cotes : probabilités du modèle seul.</p>'}
      <h3>Double chance ${info('dc')}</h3>
      <div class="mk">${mkRow(`${esc(m.h.short)} ou nul`, p.dc['1N'])}${mkRow(`Nul ou ${esc(m.a.short)}`, p.dc['N2'])}${mkRow('Pas de match nul', p.dc['12'])}</div>
    </div>
    <div class="card pad section"><h3 style="margin-top:0">Buts dans le match ${info('buts')}</h3>
      <div class="mk"><div class="mk-row mk-head"><span>Ligne</span><span style="text-align:right">Plus</span><span style="text-align:right">Moins</span></div>
      ${['0.5', '1.5', '2.5', '3.5', '4.5'].map((L) => `<div class="mk-row"><div class="lab"><span>${L.replace('.', ',')} buts</span><div class="meter"><i style="width:${g[L] * 100}%"></i></div></div><span class="pct">${pct(g[L])}</span><span class="odd" style="font-weight:700">${pct(1 - g[L])}</span></div>`).join('')}</div>
      ${m.odds.ou ? `<p class="note">Cote France estimée : ligne ${String(m.odds.ou.line).replace('.', ',')} → plus ${odd(m.odds.ou.over)} / moins ${odd(m.odds.ou.under)}</p>` : ''}
      <h3>Les deux équipes marquent ${info('btts')}</h3>
      <div class="mk">${mkRow('Oui', p.btts)}${mkRow('Non', 1 - p.btts, null, '', 'var(--draw)')}</div>
      <h3>Buts de chaque équipe</h3>
      <div class="mk"><div class="mk-row mk-head"><span></span><span style="text-align:right">${esc(m.h.abbr || m.h.short)}</span><span style="text-align:right">${esc(m.a.abbr || m.a.short)}</span></div>
      ${['0.5', '1.5', '2.5'].map((L) => `<div class="mk-row"><span>Plus de ${L.replace('.', ',')}</span><span class="pct">${pct(tg.h[L])}</span><span class="pct">${pct(tg.a[L])}</span></div>`).join('')}</div>
      <h3>Nombre exact de buts</h3>
      <div class="mk">${p.exact.map((x, i) => mkRow(i === 5 ? '5 buts ou plus' : `${i} but${i > 1 ? 's' : ''}`, x)).join('')}</div>
      <p class="note">Buts attendus : ${esc(m.h.short)} ${String(p.xg[0]).replace('.', ',')} · ${esc(m.a.short)} ${String(p.xg[1]).replace('.', ',')} · Scores probables : ${p.scores.map((s) => `${s.s} (${pct(s.p)})`).join(', ')}</p>
    </div>`;
}
function formHtml(list) {
  if (!list?.length) return '<span class="muted small">Non disponible</span>';
  return `<div class="form">${list.slice(0, 5).map((e) => `<b class="${e.res}" title="${esc(e.ha === 'dom' ? 'vs' : '@')} ${esc(e.opp)} ${esc(e.score)} (${esc(e.comp)})">${{ W: 'V', D: 'N', L: 'D' }[e.res] || '?'}</b>`).join('')}</div>`;
}
function ficheStats(m) {
  const absBlock = absentsHtml(m);
  const s = m.stats;
  const rank = (id) => { const t = S.tables.find((x) => x.slug === m.slug); for (const g of t?.groups || []) { const r = g.rows.find((x) => x.id === id); if (r) return r; } return null; };
  const rh = rank(m.h.id), ra = rank(m.a.id);
  const avg = (a, b) => (b ? (a / b).toFixed(2).replace('.', ',') : '–');
  return absBlock + `
    <div class="card pad section"><h3 style="margin-top:0">Forme (5 derniers matchs)</h3>
      <div class="row-between" style="margin:8px 0"><span style="display:flex;gap:8px;align-items:center;font-weight:600">${img(m.h.logo, 'logo', 'width:20px;height:20px')}${esc(m.h.short)}</span>${formHtml(m.form.h)}</div>
      <div class="row-between" style="margin:8px 0"><span style="display:flex;gap:8px;align-items:center;font-weight:600">${img(m.a.logo, 'logo', 'width:20px;height:20px')}${esc(m.a.short)}</span>${formHtml(m.form.a)}</div>
    </div>
    <div class="card section table-wrap"><table><thead><tr><th class="l">Dans la compétition</th><th>${esc(m.h.short)}</th><th>${esc(m.a.short)}</th></tr></thead><tbody>
        ${rh || ra ? `<tr><td class="l">Classement</td><td>${rh ? rh.rank + 'e · ' + rh.pts + ' pts' : '–'}</td><td>${ra ? ra.rank + 'e · ' + ra.pts + ' pts' : '–'}</td></tr>` : ''}
        <tr><td class="l">Matchs joués</td><td>${s.h?.m ?? '–'}</td><td>${s.a?.m ?? '–'}</td></tr>
        <tr><td class="l">Buts marqués / match</td><td>${avg(s.h?.gf, s.h?.m)}</td><td>${avg(s.a?.gf, s.a?.m)}</td></tr>
        <tr><td class="l">Buts encaissés / match</td><td>${avg(s.h?.ga, s.h?.m)}</td><td>${avg(s.a?.ga, s.a?.m)}</td></tr>
        <tr><td class="l">Domicile (marqués / encaissés)</td><td>${avg(s.h?.hgf, s.h?.hm)} / ${avg(s.h?.hga, s.h?.hm)}</td><td>${avg(s.a?.hgf, s.a?.hm)} / ${avg(s.a?.hga, s.a?.hm)}</td></tr>
        <tr><td class="l">Extérieur (marqués / encaissés)</td><td>${avg(s.h?.agf, s.h?.am)} / ${avg(s.h?.aga, s.h?.am)}</td><td>${avg(s.a?.agf, s.a?.am)} / ${avg(s.a?.aga, s.a?.am)}</td></tr>
        <tr><td class="l">Force (note Elo)</td><td><b>${m.pred.elo[0]}</b></td><td><b>${m.pred.elo[1]}</b></td></tr>
    </tbody></table></div>
    <div class="card pad section"><h3 style="margin-top:0">Confrontations directes</h3>
      ${m.h2h.length ? m.h2h.map((r) => `<div class="row-between" style="padding:6px 0;border-bottom:1px solid var(--line)"><span class="small muted">${fShort.format(new Date(r.d))} · ${esc(r.comp)}</span><span>${esc(r.h)} <b>${r.hs} - ${r.as}</b> ${esc(r.a)}</span></div>`).join('') : '<span class="muted small">Aucune confrontation depuis janvier 2025.</span>'}
    </div>`;
}

// Compos : lues en direct chez ESPN si elles ne sont pas encore dans les données du site.
async function maybeFetchLineup(m, noRedraw) {
  if (m.lineup.h || m._lineupTried || Date.parse(m.date) - Date.now() > 100 * 60e3) return false;
  // nouvel essai possible 10 min plus tard si la compo n'était pas encore sortie
  m._lineupTried = true; setTimeout(() => { if (!m.lineup.h) m._lineupTried = false; }, 10 * 60e3);
  try {
    const s = await fetch(`${ESPN}/${m.slug}/summary?event=${m.id}`).then((r) => r.json());
    for (const r of s.rosters || []) {
      const tid = r.team?.id; if (!tid || !r.roster?.length) continue;
      const side = tid === m.h.id ? 'h' : tid === m.a.id ? 'a' : null; if (!side) continue;
      m.lineup[side] = {
        formation: r.formation || '',
        xi: r.roster.filter((p) => p.starter).map((p) => ({ id: p.athlete?.id, name: p.athlete?.displayName, pos: p.position?.abbreviation, n: p.jersey })),
        subs: r.roster.filter((p) => !p.starter).map((p) => ({ id: p.athlete?.id, name: p.athlete?.displayName })),
      };
      const xi = m.lineup[side].xi.map((p) => p.id), subs = m.lineup[side].subs.map((p) => p.id);
      for (const p of m.players[side]) {
        const before = p.status;
        p.status = xi.includes(p.id) ? 'titulaire' : subs.includes(p.id) ? 'remplaçant' : 'absent';
        // même règle que le serveur : remplaçant ≈ 30 % du temps de jeu, absent = 0
        const f = p.status === 'remplaçant' ? 0.3 : p.status === 'absent' ? 0 : 1;
        if (before !== p.status && f < 1) for (const k of ['pg', 'pa', 'pd']) p[k] = Math.round((1 - Math.pow(1 - p[k], f)) * 1000) / 1000;
        if (p.status === 'absent' && !p.absInfo) p.absInfo = 'absent de la feuille de match';
      }
    }
  } catch (e) { /* pas de réseau : on garde le message */ }
  if (!noRedraw && modalId === m.id && modalDraw) modalDraw();
  return !!m.lineup.h;
}
// Onglet Combinés : va chercher les compos des matchs qui commencent bientôt, puis recalcule.
async function refreshSoonLineups() {
  const soon = M.matches.filter((m) => isPre(m) && !m.lineup.h && !m._lineupTried && Date.parse(m.date) - Date.now() < 100 * 60e3);
  if (!soon.length) return;
  const got = await Promise.all(soon.map((m) => maybeFetchLineup(m, true)));
  if (got.some(Boolean) && state.tab === 'combis') { resetGen(); render(); toast('Compos mises à jour'); }
}
function ficheCompos(m) {
  const side = (t, l) => l ? `<div class="card pad section"><div class="row-between"><b style="display:flex;gap:8px;align-items:center">${img(t.logo, 'logo', 'width:22px;height:22px')}${esc(t.short)}</b><span class="tag">${esc(l.formation)}</span></div>
    <div class="lineup" style="margin-top:10px">${l.xi.map((p) => `<div><span class="num">${esc(p.n || '')}</span>${esc(p.name)} <span class="muted small">${esc(p.pos || '')}</span></div>`).join('')}</div>
    ${l.subs.length ? `<p class="note">Remplaçants : ${l.subs.map((p) => esc(p.name)).join(', ')}</p>` : ''}</div>` : '';
  if (!m.lineup.h && !m.lineup.a) {
    const soon = Date.parse(m.date) - Date.now() < 100 * 60e3 && !m._lineupTried;
    return `<div class="card pad empty">${soon ? '<div class="spinner"></div>Recherche des compos…' : 'Les compos officielles sortent environ 1 h avant le coup d\'envoi.<br>Elles s\'afficheront ici dès leur publication.'}</div>`;
  }
  const absents = ['h', 'a'].flatMap((s) => m.players[s].filter((p) => p.status === 'absent').map((p) => ({ ...p, t: m[s] })));
  return side(m.h, m.lineup.h) + side(m.a, m.lineup.a) +
    `${absentsHtml(m)}<div class="card pad section"><h3 style="margin-top:0">Buteurs / passeurs absents de la feuille de match</h3>${absents.length ? absents.map((p) => `<div style="padding:3px 0">${esc(p.name)} <span class="muted small">(${esc(p.t.short)} · ${p.g} buts, ${p.a} passes)</span></div>`).join('') : '<span class="muted small">Aucun buteur ou passeur important absent de la feuille de match.</span>'}
    </div>`;
}
function fichePlayers(m) {
  const list = (t, arr) => `<div class="card section" style="overflow:hidden"><div class="list-head">${img(t.logo, '')}${esc(t.short)}</div>
    <div class="player headrow"><span>Joueur</span><span>But</span><span>Passe</span><span>Décisif</span><span>Cote</span></div>
    ${arr.length ? arr.slice(0, 8).map((p) => `<div class="player"><div class="pn"><b>${esc(p.name)}</b> ${p.status !== 'probable' ? `<span class="tag ${p.status === 'titulaire' ? 'win' : p.status === 'absent' ? 'lose' : ''}">${p.status}</span>` : ''}<small>${p.g} but${p.g > 1 ? 's' : ''} · ${p.a} passe${p.a > 1 ? 's' : ''} · ${p.m ?? '?'} matchs</small></div><span class="v">${pct(p.pg)}</span><span class="v">${pct(p.pa)}</span><span class="v">${pct(p.pd)}</span>${oddCell(p)}</div>`).join('') : '<div class="empty">Pas de données joueurs.</div>'}</div>`;
  const sc = m.scorers || [];
  const odds = sc.length ? `<div class="card pad section"><h3 style="margin-top:0">Cotes buteur</h3><p class="note" style="margin-top:0">Estimation France (≈ Betclic), d'après les cotes Bet365.</p>
    <div class="scorers"><span class="mk-head">Joueur</span><span class="mk-head" style="text-align:right">À tout moment</span><span class="mk-head" style="text-align:right">1er buteur</span><span class="mk-head" style="text-align:right">Chances</span>
    ${sc.map((s) => `<span>${esc(s.name)}</span><b style="text-align:right">${odd(s.o)}</b><span class="muted" style="text-align:right">${s.first ? odd(s.first) : '–'}</span><span class="muted" style="text-align:right">${pct(Math.min(0.95, 0.85 / (s.raw || s.o)))}</span>`).join('')}</div>
    <p class="note">Chances = ce que la cote représente, sans la marge du bookmaker (≈15 %).</p></div>` : '<p class="note">Pas encore de cotes buteur pour ce match.</p>';
  const pLegs = m.state === 'pre' ? playerLegs(m) : [];
  const adds = pLegs.length ? `<div class="card pad section"><div class="row-between"><div class="eyebrow">Ajouter un pari joueur à mon combiné</div></div>
    ${Object.entries(PLAYER_TYPES).map(([t, d]) => { const ls = pLegs.filter((l) => l.type === t).sort((a, b) => b.p - a.p); return ls.length ? `<h3>${d.name}</h3><div class="leg-grid">${ls.map((l) => `<button class="leg-btn" data-add="${esc(l.id)}"><span>${esc(l.label.replace(' ' + d.label, ''))} <span class="muted">${pct(l.p)}</span></span><b>${odd(l.odds)}${l.est ? '≈' : ''}</b></button>`).join('')}</div>` : ''; }).join('')}
    <p class="note">Cote buteur = estimation France d'après Bet365. Cotes passeur et décisif ≈ estimées : remplace-les par celles de Betclic dans Mon combiné.</p></div>` : '';
  return list(m.h, m.players.h) + list(m.a, m.players.a) + adds + odds;
}

// ---------- scores en direct ----------
let liveTimer = null;
const utcDay = (d) => new Date(d).toISOString().slice(0, 10).replace(/-/g, '');
function liveCandidates() {
  const now = Date.now();
  return M.matches.filter((m) => m.state === 'in' || (!m.completed && Date.parse(m.date) - now < 15 * 60e3 && now - Date.parse(m.date) < 4 * 3600e3));
}
async function liveTick() {
  clearTimeout(liveTimer);
  if (!M) return;
  if (document.hidden) { liveTimer = setTimeout(liveTick, 60e3); return; }
  const cands = liveCandidates();
  if (cands.length) {
    const keys = [...new Set(cands.map((m) => `${m.slug}|${utcDay(m.date)}`))];
    let changed = false;
    await Promise.all(keys.map(async (k) => {
      const [slug, d] = k.split('|');
      const j = await fetch(`${ESPN}/${slug}/scoreboard?dates=${d}`).then((r) => r.json()).catch(() => null);
      for (const e of j?.events || []) {
        const m = M.matches.find((x) => x.id === e.id); if (!m) continue;
        const c = e.competitions?.[0], st = e.status?.type || {};
        const h = c?.competitors?.find((x) => x.homeAway === 'home'), a = c?.competitors?.find((x) => x.homeAway === 'away');
        const hs = h?.score != null && h.score !== '' ? +h.score : m.hs, as = a?.score != null && a.score !== '' ? +a.score : m.as;
        const detail = st.state === 'in' ? (e.status?.displayClock && st.shortDetail !== 'HT' ? st.shortDetail : st.shortDetail || 'En direct') : st.shortDetail;
        if (m.state !== st.state || m.hs !== hs || m.as !== as || m.detail !== detail) {
          if ((m.hs !== hs || m.as !== as) && m.state === 'in') m._goal = Date.now();
          Object.assign(m, { state: st.state, completed: !!st.completed, hs, as, detail });
          changed = true;
        }
      }
    }));
    if (changed) softRender();
  }
  const nLive = M.matches.filter((m) => m.state === 'in').length;
  const badge = $('#liveBadge'); badge.hidden = !nLive; badge.querySelector('b').textContent = nLive;
  // fiche ouverte sur un match en cours : on rafraîchit aussi le fil du match
  if (modalId && modalDraw && M.matches.find((x) => x.id === modalId)?.state === 'in') modalDraw();
  liveTimer = setTimeout(liveTick, cands.length ? 30e3 : 5 * 60e3);
}
function softRender() {
  if (modalDraw) { const sh = $('.sheet'), top = sh.scrollTop; modalDraw(); sh.scrollTop = top; }
  if (document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'SELECT') return;
  if (['matchs', 'semaine'].includes(state.tab)) render();
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  if (Date.now() - loadedAt > 10 * 60e3) load().catch(() => {}); else liveTick();
});

// ---------- navigation ----------
function render() {
  updatePill();
  if (!M) return;
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === state.tab));
  ({ matchs: renderMatchs, semaine: renderSemaine, combis: renderCombis, joueurs: renderJoueurs, classements: renderClassements, perf: renderPerf })[state.tab]();
  updateMyCount();
}
$('#tabs').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; state.tab = b.dataset.tab; render(); window.scrollTo({ top: 0 }); };
view.addEventListener('click', (e) => {
  const fv = e.target.closest('[data-fav]');
  if (fv) { e.stopPropagation(); toggleFav(fv.dataset.fav); render(); return; }
  // bouton « + Mon combiné » du combiné du jour (onglet Matchs ; l'onglet Combinés gère le sien)
  const add = e.target.closest('[data-addall]');
  if (add && state.tab !== 'combis') { const ids = add.dataset.addall.split(','); ids.forEach((id) => addLeg(id, true)); toast(`${ids.length} paris ajoutés à ton combiné`); updateMyCount(); return; }
  const c = e.target.closest('[data-id]'); if (c && !e.target.closest('input,select,button,label')) openMatch(c.dataset.id); });
$('#closeModal').onclick = () => closeModal();
$('#modalBody').addEventListener('click', (e) => {
  const fv = e.target.closest('[data-fav]');
  if (fv) { toggleFav(fv.dataset.fav); if (modalDraw) modalDraw(); render(); return; } const b = e.target.closest('[data-add]'); if (b) { addLeg(b.dataset.add); b.classList.add('added'); } });
$('#modal').onclick = (e) => { if (e.target.id === 'modal') closeModal(); };
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
$('#themeBtn').onclick = () => {
  const dark = document.documentElement.dataset.theme ? document.documentElement.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.dataset.theme = dark ? 'light' : 'dark';
  try { localStorage.setItem('theme', document.documentElement.dataset.theme); } catch (e) {}
};
if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});


// =================== Aide, explications, gestes ===================
const buzz = (ms = 12) => { try { navigator.vibrate?.(ms); } catch (e) {} };

// Lexique : chaque terme a une explication courte (bouton « ? » et page Aide)
const GLOSSARY = {
  '1n2': ['Résultat 1N2', "Qui gagne le match : 1 = l'équipe à domicile, N = match nul, 2 = l'équipe à l'extérieur. Les % sont les chances calculées par le site."],
  dc: ['Double chance', "Tu gagnes sur 2 des 3 issues. Ex. « PSG ou nul » : gagné si PSG gagne OU fait match nul. Plus sûr, mais la cote est plus basse."],
  buts: ['Plus / moins de buts', "On compte les buts des deux équipes. « Plus de 2,5 buts » = au moins 3 buts dans le match. « Moins de 2,5 » = 0, 1 ou 2 buts."],
  btts: ['Les deux équipes marquent', "Gagné si chaque équipe marque au moins un but, quel que soit le score final."],
  cote: ['La cote', "Ce que te rapporte 1 € misé si tu gagnes. Cote 2,00 → 10 € misés rapportent 20 € (dont 10 € de gain). Plus la cote est basse, plus le pari est probable."],
  cotest: ['Cote ≈ (estimée)', "Quand le bookmaker ne donne pas la cote d'un pari, le site l'estime à partir de nos chances. Mets la vraie cote Betclic dans « Mon combiné » pour être exact."],
  confiance: ['Barres de confiance', "De 1 à 5 barres : notre niveau de confiance dans le prono. Vert vif = très sûr, vert clair = sûr, jaune = moyen, orange = risqué, rouge = très risqué."],
  combine: ['Combiné', "Plusieurs paris réunis : les cotes se multiplient, mais il faut que TOUS les paris passent. Le combiné du jour est le plus probable possible pour une cote d'environ 2."],
  quasi: ['Les quasi-sûrs', "Les paris annoncés à 80 % de chances ou plus. Le % « passé » montre combien de fois ce genre de pari est vraiment passé sur les saisons précédentes."],
  generateur: ['Générateur de combiné', "Choisis la cote que tu vises (curseur) et le nombre de paris (− / +) : le site cherche les paris les plus probables pour l'atteindre."],
  modele: ['Comment le site calcule', "Le site mélange les cotes des bookmakers (90 %) et notre modèle (10 %) : force des équipes (Elo), buts, tirs cadrés, forme. Il se règle tout seul chaque lundi."],
  forme: ['Forme V / N / D', "Les 5 derniers matchs de l'équipe : V = victoire, N = nul, D = défaite. Le plus récent est à gauche."],
  elo: ['Note de force (Elo)', "Un score de niveau mis à jour après chaque match : on gagne des points en battant des équipes fortes. 1500 = moyen, 1900+ = très fort."],
  favoris: ['Favoris', "Touche ☆ sur un match pour le suivre : il apparaît en haut de l'onglet Matchs. Les favoris restent sur ton téléphone."],
};
const info = (key) => '<button class="info" data-info="' + key + '" aria-label="Explication">?</button>';
function showTip(key) {
  const g = GLOSSARY[key]; if (!g) return;
  let t = $('#tip');
  if (!t) { t = document.createElement('div'); t.id = 'tip'; t.className = 'tip-wrap'; document.body.appendChild(t); t.addEventListener('click', (e) => { if (e.target === t || e.target.closest('.tip-close')) t.classList.remove('show'); }); }
  t.innerHTML = '<div class="tip"><div class="tip-title">' + esc(g[0]) + '</div><p>' + esc(g[1]) + '</p><button class="btn-sm tip-close">Compris</button></div>';
  t.classList.add('show'); buzz(8);
}
document.addEventListener('click', (e) => { const b = e.target.closest('[data-info]'); if (b) { e.stopPropagation(); e.preventDefault(); showTip(b.dataset.info); } }, true);

// Page Aide : comment lire l'appli + lexique complet
function showHelp() {
  const body = $('#modalBody');
  modalDraw = null; modalId = null;
  body.innerHTML = '<div class="fiche-head help-head"><div class="comp">Aide</div><div style="font-size:22px;font-weight:900;margin-top:8px">Comment utiliser Layan Pronos</div></div>'
    + '<div class="fiche-body">'
    + '<div class="card pad section"><h3 style="margin-top:0">📱 L\'appli en 30 secondes</h3><ol class="help-steps">'
    + '<li><b>Matchs</b> : choisis un jour (ou glisse l\'écran à gauche / à droite). Chaque carte montre les chances de chaque équipe et notre prono.</li>'
    + '<li>Touche un match pour voir <b>la fiche</b> : pourquoi ce prono, stats, compos, buteurs, et le direct pendant le match.</li>'
    + '<li><b>🎯 Combiné du jour</b> et <b>✅ Quasi-sûrs</b> en haut : nos paris les plus solides.</li>'
    + '<li><b>Combinés</b> : fabrique ton combiné (curseur de cote, nombre de paris) et garde-le dans « Mon combiné ».</li>'
    + '<li><b>Perf</b> : la réussite réelle du site, vérifiée match après match.</li>'
    + '<li>Tire l\'écran vers le bas pour actualiser. Glisse une fiche vers le bas pour la fermer.</li></ol></div>'
    + '<div class="card pad section"><h3 style="margin-top:0">📖 Lexique</h3>' + Object.values(GLOSSARY).map((g) => '<div class="gloss"><b>' + esc(g[0]) + '</b><p>' + esc(g[1]) + '</p></div>').join('') + '</div>'
    + '<div class="card pad section"><h3 style="margin-top:0">⚠️ Jouer responsable</h3><p class="small">Aucun prono n\'est sûr à 100 %. Ne mise que ce que tu peux perdre. 18+ · Joueurs Info Service : 09 74 75 13 13.</p>'
    + '<button class="btn-sm ghost" id="replayTour">Revoir la visite guidée</button></div></div>';
  $('#replayTour').onclick = () => { closeModal(); setTimeout(startTour, 250); };
  $('#modal').hidden = false; document.body.style.overflow = 'hidden'; $('.sheet').scrollTop = 0;
  try { history.pushState({ fiche: 'aide' }, ''); } catch (e) {}
}

// Visite guidée au premier lancement
const TOUR = [
  ['👋', 'Bienvenue sur Layan Pronos', "Le site calcule les chances de chaque match de foot à partir des cotes des bookmakers et de nos statistiques. Tout se met à jour tout seul."],
  ['📊', 'Lire un match', "Les 3 cases donnent les chances de victoire de chaque équipe et du nul. La case verte = l'issue la plus probable. Les petites barres = notre confiance : vert = sûr, rouge = risqué."],
  ['🎯', 'Nos meilleurs paris', "En haut de l'écran : le combiné du jour (le plus probable pour une cote d'environ 2) et les quasi-sûrs (paris à 80 % ou plus). Touche ☆ pour mettre un match en favori."],
  ['🧾', 'Ton combiné', "Ajoute des paris avec « + », remplace les cotes par celles de Betclic et vois tes gains possibles. Un « ? » à côté d'un mot = son explication. Bon match !"],
];
function startTour(i = 0) {
  let t = $('#tour');
  if (!t) { t = document.createElement('div'); t.id = 'tour'; t.className = 'tour-wrap'; document.body.appendChild(t); }
  const [ico, title, text] = TOUR[i], last = i === TOUR.length - 1;
  t.innerHTML = '<div class="tour"><div class="tour-ico">' + ico + '</div><h2>' + esc(title) + '</h2><p>' + esc(text) + '</p>'
    + '<div class="tour-dots">' + TOUR.map((_, k) => '<i class="' + (k === i ? 'on' : '') + '"></i>').join('') + '</div>'
    + '<div class="tour-btns"><button class="btn-sm ghost" id="tourSkip">' + (last ? 'Fermer' : 'Passer') + '</button><button class="btn-sm" id="tourNext">' + (last ? "C'est parti !" : 'Suivant') + '</button></div></div>';
  t.classList.add('show');
  const end = () => { t.classList.remove('show'); try { localStorage.setItem('tourVu', '1'); } catch (e) {} };
  $('#tourSkip').onclick = end;
  $('#tourNext').onclick = () => { buzz(8); if (last) end(); else startTour(i + 1); };
}

// Bulle flottante « Mon combiné » (accès rapide depuis tous les onglets)
function updatePill() {
  let p = $('#myPill');
  if (!p) { p = document.createElement('button'); p.id = 'myPill'; p.className = 'my-pill'; document.body.appendChild(p); p.onclick = () => { buzz(); state.tab = 'combis'; render(); setTimeout(() => { const h = [...document.querySelectorAll('h2')].find((x) => /Mon combiné/.test(x.textContent)); h?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 60); }; }
  if (!my.length || state.tab === 'combis' || !M) { p.hidden = true; return; }
  const total = my.reduce((t, x) => t * (Number(x.odds) || 1), 1);
  p.hidden = false; p.innerHTML = '🧾 <b>' + my.length + '</b> pari' + (my.length > 1 ? 's' : '') + ' · cote <b>' + odd(total) + '</b>';
}

// Gestes : glisser à gauche/droite = changer de jour (onglet Matchs) ; tirer vers le bas = actualiser
(() => {
  let x0 = null, y0 = 0, pull = 0;
  const ind = document.createElement('div'); ind.className = 'ptr'; ind.innerHTML = '<span>↓</span>'; document.body.appendChild(ind);
  view.addEventListener('touchstart', (e) => { if (e.touches.length !== 1) { x0 = null; return; } x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; pull = 0; }, { passive: true });
  view.addEventListener('touchmove', (e) => {
    if (x0 == null) return;
    const dy = e.touches[0].clientY - y0;
    if (window.scrollY <= 0 && dy > 0 && Math.abs(e.touches[0].clientX - x0) < 40) { pull = dy; ind.style.transform = 'translate(-50%,' + Math.min(70, dy / 2) + 'px)'; ind.style.opacity = Math.min(1, dy / 120); ind.classList.toggle('ready', dy > 120); }
  }, { passive: true });
  view.addEventListener('touchend', (e) => {
    if (x0 == null) return;
    const t = e.changedTouches[0], dx = t.clientX - x0, dy = t.clientY - y0;
    ind.style.transform = ''; ind.style.opacity = 0; ind.classList.remove('ready');
    if (pull > 120) { buzz(15); toast('Actualisation…'); load().then(() => toast('À jour ✓')).catch(() => toast('Pas de connexion')); x0 = null; return; }
    // changement de jour : geste horizontal net, pas dans une zone qui défile déjà horizontalement
    if (state.tab === 'matchs' && !state.q && Math.abs(dx) > 70 && Math.abs(dy) < 50 && !e.target.closest('.days, .chips, .table-wrap, input, select')) {
      const days = [...new Set(M.matches.map((m) => dayKey(m.date)))].sort();
      const i = days.indexOf(state.day), j = i + (dx < 0 ? 1 : -1);
      if (j >= 0 && j < days.length) { state.day = days[j]; buzz(8); render(); window.scrollTo({ top: 0 }); view.classList.remove('slide-l', 'slide-r'); void view.offsetWidth; view.classList.add(dx < 0 ? 'slide-l' : 'slide-r'); }
    }
    x0 = null;
  });
})();

load().then(() => { try { if (!localStorage.getItem('tourVu')) setTimeout(startTour, 600); } catch (e) {} }).catch((e) => { view.innerHTML = `<div class="card empty">Impossible de charger les données (${esc(e.message)}).</div>`; });
$('#helpBtn').onclick = () => showHelp();
