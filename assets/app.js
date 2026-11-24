// Pronos Foot : affichage. Les données sont dans /data, recalculées par GitHub.
const $ = (s, el = document) => el.querySelector(s);
const view = $('#view');
const TZ = 'Europe/Paris';
const state = { tab: 'matchs', day: null, comp: 'all', valueOnly: false, q: '', standing: null, pSort: 'pd', pComp: 'all', pValue: false };
const oddCell = (p) => (p.o ? `<span class="o ${p.value ? 'val' : ''}" title="Cote Bet365 buteur à tout moment">${p.value ? '💎 ' : ''}${odd(p.o)}</span>` : '<span class="o">–</span>');
let M = null, S = null, HIST = null;

// ---------- formats ----------
const fmt = (opts) => new Intl.DateTimeFormat('fr-FR', { timeZone: TZ, ...opts });
const fTime = fmt({ hour: '2-digit', minute: '2-digit' });
const fDay = fmt({ weekday: 'long', day: 'numeric', month: 'long' });
const fShort = fmt({ day: '2-digit', month: '2-digit' });
const fDayShort = fmt({ weekday: 'short', day: 'numeric' });
const dayKey = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(d));
const todayKey = () => dayKey(Date.now());
const addDays = (key, n) => { const d = new Date(key + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const weekday = (key) => new Date(key + 'T12:00:00Z').getUTCDay();
const pct = (p) => (p == null ? '–' : Math.round(p * 100) + ' %');
const odd = (o) => (o ? o.toFixed(2).replace('.', ',') : '');
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const img = (src, cls = 'logo') => (src ? `<img class="${cls}" src="${esc(src)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">` : `<span class="${cls}"></span>`);
const starsHtml = (n) => `<span class="stars" title="Confiance ${n}/5">${'★'.repeat(n)}<span class="off">${'★'.repeat(5 - n)}</span></span>`;
const comp = (slug) => M?.comps?.[slug] || { name: slug, short: slug };
const TYPE_NAMES = { '1N2': 'Résultat 1N2', DC: 'Double chance', Buts: 'Plus/moins 2,5 buts', BTTS: 'Les deux marquent', Value: 'Value bets' };

// ---------- chargement ----------
async function load() {
  const get = (f) => fetch(`data/${f}?v=${Math.floor(Date.now() / 6e4)}`).then((r) => r.json());
  [M, S, HIST] = await Promise.all([get('matches.json'), get('standings.json'), get('history.json')]);
  const upd = new Date(M.updatedAt);
  $('#updated').textContent = `Mis à jour ${fDayShort.format(upd)} à ${fTime.format(upd)}`;
  render();
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

function statusHtml(m) {
  if (m.state === 'pre') return `<div class="time">${fTime.format(new Date(m.date))}</div><div class="small muted">${fShort.format(new Date(m.date))}</div>`;
  if (m.state === 'in') return `<div class="score">${m.hs ?? 0} - ${m.as ?? 0}</div><div class="live">● ${esc(m.detail || 'En cours')}</div>`;
  if (m.completed) return `<div class="score">${m.hs} - ${m.as}</div><div class="small muted">${esc(m.detail || 'Terminé')}</div>`;
  return `<div class="small muted">${esc(m.detail || '')}</div>`;
}

function verdictTag(p) {
  if (p?.win === true) return '<span class="tag win">✅ gagné</span>';
  if (p?.win === false) return '<span class="tag lose">❌ perdu</span>';
  return '';
}

function matchCard(m) {
  const p = m.pred.p, mp = mainPick(m), vs = values(m);
  const graded = m.graded?.find((g) => g.type === '1N2');
  const mv = oddsMove(m);
  const moved = mv?.find((x) => x.k === mp.key && Math.abs(x.diff) >= 0.05);
  return `<div class="card match" data-id="${m.id}">
    <div class="m-row">
      <div class="team">${img(m.h.logo)}<span>${esc(m.h.short)}</span></div>
      <div class="mid">${statusHtml(m)}</div>
      <div class="team away"><span>${esc(m.a.short)}</span>${img(m.a.logo)}</div>
    </div>
    <div class="bar"><i class="h" style="width:${p.h * 100}%"></i><i class="d" style="width:${p.d * 100}%"></i><i class="a" style="width:${p.a * 100}%"></i></div>
    <div class="pcts"><span>1 <b>${pct(p.h)}</b></span><span>N <b>${pct(p.d)}</b></span><span>2 <b>${pct(p.a)}</b></span></div>
    <div class="pick-line">
      <span class="tag brand">${esc(mp.label)}${mp.odds ? ' · ' + odd(mp.odds) : ''}</span>${starsHtml(mp.stars)}
      ${vs.length ? `<span class="tag value">💎 ${vs.length} value</span>` : ''}
      ${moved ? `<span class="tag ${moved.diff < 0 ? 'down' : 'up'}" title="Évolution de la cote">${moved.diff < 0 ? '📉' : '📈'} ${odd(moved.from)} → ${odd(moved.to)}</span>` : ''}
      ${bigMatch(m) ? '<span class="tag big">🔥 gros match</span>' : ''}
      ${graded ? verdictTag(graded) : ''}
      ${m.result?.void ? `<span class="tag">${esc(m.result.note)}</span>` : ''}
    </div>
  </div>`;
}

function groupByComp(list) {
  const order = Object.keys(M.comps);
  const g = new Map();
  for (const m of list) { if (!g.has(m.slug)) g.set(m.slug, []); g.get(m.slug).push(m); }
  return [...g.entries()].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]));
}
const compHead = (slug) => `<div class="comp-head">${img(comp(slug).logo)}<span>${esc(comp(slug).name)}</span></div>`;

// ---------- combinés, match du jour, surprises ----------
function safeLeg(m) {
  const c = m.picks.filter((p) => p.type !== 'Value' && p.p >= 0.68 && p.odds && p.odds >= 1.12);
  if (!c.length) return null;
  return c.sort((a, b) => b.p - a.p)[0];
}
function combos(list, n = 2) {
  const legs = list.filter(isPre).map((m) => ({ m, p: safeLeg(m) })).filter((x) => x.p).sort((a, b) => b.p.p - a.p.p);
  const out = [];
  let i = 0;
  while (out.length < n && i < legs.length) {
    const c = []; let o = 1, pr = 1;
    while (i < legs.length && (o < 2 || c.length < 2) && c.length < 4) { const l = legs[i++]; c.push(l); o *= l.p.odds; pr *= l.p.p; }
    if (o >= 1.9 && c.length >= 2) out.push({ legs: c, odds: o, p: pr });
  }
  return out;
}
function comboHtml(c, i) {
  return `<div class="card combo">
    <div class="row-between"><b>Combiné ${i + 1}</b><span class="tag brand">Cote ≈ ${odd(c.odds)}</span></div>
    <ol>${c.legs.map((l) => `<li><span class="muted small">${esc(l.m.h.short)} - ${esc(l.m.a.short)} :</span> <b>${esc(l.p.label)}</b> <span class="muted small">(${pct(l.p.p)}, ${odd(l.p.odds)}${l.p.est ? ' ≈' : ''})</span></li>`).join('')}</ol>
    <div class="small muted">Chances que tout passe selon le modèle : <b>${pct(c.p)}</b></div>
  </div>`;
}
function matchOfDay() {
  const pre = M.matches.filter(isPre);
  for (let d = 0; d < 7; d++) {
    const k = addDays(todayKey(), d);
    const day = pre.filter((m) => dayKey(m.date) === k);
    if (day.length) return day.sort((a, b) => mainPick(b).stars - mainPick(a).stars || mainPick(b).p - mainPick(a).p)[0];
  }
  return null;
}
function surprises(list) {
  const out = [];
  for (const m of list.filter(isPre)) {
    const mk = m.pred.market; if (!mk || !m.odds.x12) continue;
    const k = mk.h < mk.a ? 'h' : 'a', o = m.odds.x12[k === 'h' ? 0 : 2];
    const diff = m.pred.model[k] - mk[k];
    if (o >= 2.8 && diff >= 0.06) out.push({ m, k, o, diff });
  }
  return out.sort((a, b) => b.diff - a.diff).slice(0, 6);
}
function surpriseHtml(s) {
  const t = s.k === 'h' ? s.m.h : s.m.a;
  return `<div class="card pad match" data-id="${s.m.id}">
    <div class="row-between"><div class="team">${img(t.logo)}<span>${esc(t.short)}</span></div><span class="tag value">cote ${odd(s.o)}</span></div>
    <div class="small muted" style="margin-top:6px">${esc(s.m.h.short)} - ${esc(s.m.a.short)} · ${fDayShort.format(new Date(s.m.date))} ${fTime.format(new Date(s.m.date))}</div>
    <div class="small">Bookmakers : <b>${pct(s.m.pred.market[s.k])}</b> · notre modèle : <b>${pct(s.m.pred.model[s.k])}</b></div>
  </div>`;
}

// ---------- onglet Matchs ----------
function renderMatchs() {
  const days = [...new Set(M.matches.map((m) => dayKey(m.date)))].sort();
  const t = todayKey();
  if (!state.day || !days.includes(state.day)) state.day = days.includes(t) ? t : days.find((d) => d > t) || days[days.length - 1];
  const label = (d) => (d === t ? "Aujourd'hui" : d === addDays(t, 1) ? 'Demain' : d === addDays(t, -1) ? 'Hier' : fDayShort.format(new Date(d + 'T12:00:00Z')));
  let list = M.matches.filter((m) => dayKey(m.date) === state.day);
  if (state.q) list = M.matches.filter((m) => matchText(m).includes(state.q.toLowerCase()));
  if (state.comp !== 'all') list = list.filter((m) => m.slug === state.comp);
  if (state.valueOnly) list = list.filter((m) => values(m).length);

  const motd = matchOfDay();
  const dayCombos = combos(M.matches.filter((m) => dayKey(m.date) === state.day));
  const sup = surprises(M.matches);
  const comps = [...new Set(M.matches.map((m) => m.slug))];

  view.innerHTML = `
    ${motd && !state.q ? `<div class="card hero match" data-id="${motd.id}">
      <div class="label">⭐ Match du jour</div>
      <div class="m-row" style="margin-top:8px">
        <div class="team">${img(motd.h.logo)}<span>${esc(motd.h.short)}</span></div>
        <div class="mid">${statusHtml(motd)}</div>
        <div class="team away"><span>${esc(motd.a.short)}</span>${img(motd.a.logo)}</div>
      </div>
      <div class="pick-line"><span class="tag brand">${esc(mainPick(motd).label)} · ${pct(mainPick(motd).p)}</span>${starsHtml(mainPick(motd).stars)}<span class="small muted">${esc(comp(motd.slug).name)}</span></div>
    </div>` : ''}
    <div class="filters">
      <div class="chips">${days.map((d) => `<button class="chip ${d === state.day && !state.q ? 'active' : ''}" data-day="${d}">${label(d)}</button>`).join('')}</div>
      <input type="search" id="q" placeholder="🔎 Rechercher une équipe" value="${esc(state.q)}">
      <select id="comp"><option value="all">Toutes les compétitions</option>${comps.map((c) => `<option value="${c}" ${c === state.comp ? 'selected' : ''}>${esc(comp(c).name)}</option>`).join('')}</select>
      <label class="toggle"><input type="checkbox" id="vOnly" ${state.valueOnly ? 'checked' : ''}> 💎 Value bets seulement</label>
    </div>
    ${state.q ? `<p class="note">Résultats pour « ${esc(state.q)} » sur les ${days.length} jours affichés.</p>` : ''}
    ${list.length ? groupByComp(list).map(([slug, ms]) => compHead(slug) + ms.map(matchCard).join('')).join('') : '<div class="empty">Aucun match pour ce choix.</div>'}
    ${!state.q && dayCombos.length ? `<h2>🎯 Combinés suggérés</h2><div class="grid2">${dayCombos.map(comboHtml).join('')}</div><p class="note">Les cotes marquées ≈ sont estimées à partir des cotes 1N2.</p>` : ''}
    ${!state.q && sup.length ? `<h2>💥 Surprises possibles</h2><p class="note">Outsiders à qui notre modèle donne nettement plus de chances que les bookmakers.</p><div class="grid2">${sup.map(surpriseHtml).join('')}</div>` : ''}
  `;
  view.querySelectorAll('[data-day]').forEach((b) => b.onclick = () => { state.day = b.dataset.day; state.q = ''; render(); });
  $('#q').oninput = debounce((e) => { state.q = e.target.value.trim(); render(); const q = $('#q'); q.focus(); q.setSelectionRange(q.value.length, q.value.length); }, 300);
  $('#comp').onchange = (e) => { state.comp = e.target.value; render(); };
  $('#vOnly').onchange = (e) => { state.valueOnly = e.target.checked; render(); };
}
function debounce(f, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => f(...a), ms); }; }

// ---------- onglet Semaine ----------
function miniRow(m) {
  const mp = mainPick(m);
  return `<div class="mini" data-id="${m.id}">
    <div class="t">${m.state === 'pre' ? fTime.format(new Date(m.date)) : m.completed ? `${m.hs}-${m.as}` : '<span class="live">live</span>'}</div>
    <div class="n">${img(m.h.logo)}${esc(m.h.short)} <span class="muted">-</span> ${img(m.a.logo)}${esc(m.a.short)} ${bigMatch(m) ? '🔥' : ''}</div>
    <div class="small">${starsHtml(mp.stars)}</div>
  </div>`;
}
function renderSemaine() {
  const t = todayKey();
  let html = '<p class="note">Les 7 prochains jours. 🔥 = gros match entre deux équipes fortes.</p>';
  for (let d = 0; d < 7; d++) {
    const k = addDays(t, d);
    const ms = M.matches.filter((m) => dayKey(m.date) === k);
    if (!ms.length) continue;
    html += `<div class="day-head">${fDay.format(new Date(k + 'T12:00:00Z'))} <span class="muted small">· ${ms.length} matchs</span></div>`;
    html += groupByComp(ms).map(([slug, list]) => `<div class="card" style="margin-bottom:8px"><div class="comp-head" style="margin:0;padding:10px 12px 4px">${img(comp(slug).logo)}${esc(comp(slug).name)}</div>${list.map(miniRow).join('')}</div>`).join('');
  }
  view.innerHTML = html || '<div class="empty">Aucun match cette semaine.</div>';
}

// ---------- onglet Week-end ----------
function renderWeekend() {
  const t = todayKey();
  let sat = t; while (weekday(sat) !== 6 && weekday(sat) !== 0) sat = addDays(sat, 1);
  if (weekday(sat) === 0) sat = addDays(sat, -1);
  const days = [sat, addDays(sat, 1)];
  const ms = M.matches.filter((m) => days.includes(dayKey(m.date)));
  const pre = ms.filter(isPre);
  const best = pre.map((m) => ({ m, p: mainPick(m) })).filter((x) => x.p.stars >= 4).sort((a, b) => b.p.p - a.p.p);
  const vals = pre.flatMap((m) => values(m).map((p) => ({ m, p }))).sort((a, b) => b.p.edge - a.p.edge);
  const cs = combos(pre);
  const line = ({ m, p }) => `<div class="mini" data-id="${m.id}">
      <div class="t">${fDayShort.format(new Date(m.date)).replace('.', '')}<br><span class="muted small">${fTime.format(new Date(m.date))}</span></div>
      <div class="n" style="flex-direction:column;align-items:flex-start;white-space:normal"><span class="small muted">${esc(m.h.short)} - ${esc(m.a.short)} · ${esc(comp(m.slug).short)}</span><b>${esc(p.label)}</b></div>
      <div style="text-align:right">${p.type === 'Value' ? `<span class="tag value">${odd(p.odds)}</span>` : starsHtml(p.stars)}<div class="small muted">${pct(p.p)}</div></div>
    </div>`;
  view.innerHTML = `
    <h2>🏁 Pronos du week-end</h2>
    <p class="note">${fDay.format(new Date(days[0] + 'T12:00:00Z'))} et ${fDay.format(new Date(days[1] + 'T12:00:00Z'))} · ${ms.length} matchs</p>
    <h3>⭐ Les plus sûrs (4 et 5 étoiles)</h3>
    <div class="card">${best.length ? best.slice(0, 12).map(line).join('') : '<div class="empty">Pas encore de prono 4★ ou plus. Les cotes du week-end arrivent souvent en milieu de semaine.</div>'}</div>
    <h3>💎 Value bets</h3>
    <div class="card">${vals.length ? vals.slice(0, 10).map(line).join('') : '<div class="empty">Aucun value bet pour le moment.</div>'}</div>
    ${cs.length ? `<h3>🎯 Combinés du week-end</h3><div class="grid2">${cs.map(comboHtml).join('')}</div>` : ''}
  `;
}

// ---------- onglet Joueurs ----------
function renderJoueurs() {
  const pre = M.matches.filter((m) => isPre(m) && Date.parse(m.date) - Date.now() < 3 * 864e5);
  let rows = [];
  for (const m of pre) for (const side of ['h', 'a']) for (const p of m.players[side]) {
    if (p.status === 'absent') continue;
    rows.push({ ...p, m, team: m[side], opp: m[side === 'h' ? 'a' : 'h'] });
  }
  if (state.pComp !== 'all') rows = rows.filter((r) => r.m.slug === state.pComp);
  if (state.pValue) rows = rows.filter((r) => r.value);
  rows.sort((a, b) => b[state.pSort] - a[state.pSort]);
  const comps = [...new Set(pre.map((m) => m.slug))];
  const head = (k, l) => `<button class="chip ${state.pSort === k ? 'active' : ''}" data-sort="${k}">${l}</button>`;
  view.innerHTML = `
    <h2>⚽ Joueurs décisifs probables</h2>
    <p class="note">Matchs des 3 prochains jours. Chances de marquer / passer / être décisif, calculées à partir des buts et passes du joueur dans la compétition et des buts attendus de son équipe, mélangées à la cote buteur Bet365 quand elle existe. Les compos officielles (≈1 h avant) mettent à jour le statut.</p>
    <div class="filters"><div class="chips">${head('pd', 'Décisif')}${head('pg', 'Buteur')}${head('pa', 'Passeur')}</div>
    <select id="pComp"><option value="all">Toutes les compétitions</option>${comps.map((c) => `<option value="${c}" ${c === state.pComp ? 'selected' : ''}>${esc(comp(c).name)}</option>`).join('')}</select>
    <label class="toggle"><input type="checkbox" id="pValue" ${state.pValue ? 'checked' : ''}> 💎 Value buteur seulement</label></div>
    <div class="card">
      <div class="player headrow"><span>Joueur</span><span class="${state.pSort === 'pg' ? 'sort-active' : ''}">But</span><span class="${state.pSort === 'pa' ? 'sort-active' : ''}">Passe</span><span class="${state.pSort === 'pd' ? 'sort-active' : ''}">Décisif</span><span title="Cote Bet365 buteur à tout moment">Cote</span></div>
      ${rows.slice(0, 60).map((r) => `<div class="player match" data-id="${r.m.id}">
        <div class="pn"><b>${esc(r.name)}</b> ${r.status === 'titulaire' ? '<span class="tag win">titulaire</span>' : r.status === 'remplaçant' ? '<span class="tag">remplaçant</span>' : ''}
        <small>${img(r.team.logo, 'logo" style="width:14px;height:14px;vertical-align:-2px')} ${esc(r.team.short)} vs ${esc(r.opp.short)} · ${r.g} but${r.g > 1 ? 's' : ''}, ${r.a} passe${r.a > 1 ? 's' : ''} en ${r.m ? esc(comp(r.m.slug).short) : ''}</small></div>
        <span class="v">${pct(r.pg)}</span><span class="v">${pct(r.pa)}</span><span class="v">${pct(r.pd)}</span>${oddCell(r)}
      </div>`).join('') || `<div class="empty">${state.pValue ? 'Aucun value buteur pour le moment.' : 'Pas de données joueurs pour le moment.'}</div>`}
    </div>
    <p class="note">Cote = cote Bet365 « buteur à tout moment ». 💎 = value buteur : nos chances × la cote ≥ 1,10, uniquement pour des buteurs réguliers. Pas de cotes passeur : ESPN ne les fournit pas.</p>`;
  view.querySelectorAll('[data-sort]').forEach((b) => b.onclick = () => { state.pSort = b.dataset.sort; render(); });
  $('#pValue').onchange = (e) => { state.pValue = e.target.checked; render(); };
  $('#pComp').onchange = (e) => { state.pComp = e.target.value; render(); };
}

// ---------- onglet Classements ----------
function renderClassements() {
  const tables = S.tables.filter((t) => t.groups.some((g) => g.rows.length));
  if (!tables.length) { view.innerHTML = '<div class="empty">Classements indisponibles.</div>'; return; }
  if (!state.standing || !tables.find((t) => t.slug === state.standing)) state.standing = tables[0].slug;
  const t = tables.find((x) => x.slug === state.standing);
  view.innerHTML = `
    <div class="filters"><div class="chips">${tables.map((x) => `<button class="chip ${x.slug === state.standing ? 'active' : ''}" data-st="${x.slug}">${esc(S.comps[x.slug]?.name || x.slug)}</button>`).join('')}</div></div>
    ${t.groups.map((g) => `${t.groups.length > 1 ? `<h3>${esc(g.name)}</h3>` : ''}<div class="card table-wrap"><table>
      <thead><tr><th class="zone"></th><th>#</th><th class="l">Équipe</th><th>Pts</th><th>J</th><th>G</th><th>N</th><th>P</th><th>Diff</th></tr></thead>
      <tbody>${g.rows.map((r) => `<tr title="${esc(r.note)}"><td class="zone" style="background:${r.color ? '#' + r.color.replace('#', '') : 'transparent'}"></td><td>${r.rank ?? ''}</td>
        <td class="l"><div class="team">${img(r.logo, 'logo" style="width:20px;height:20px')}<span>${esc(r.short || r.name)}</span></div></td>
        <td><b>${r.pts ?? ''}</b></td><td>${r.pj ?? ''}</td><td>${r.g ?? ''}</td><td>${r.n ?? ''}</td><td>${r.p ?? ''}</td><td>${r.diff > 0 ? '+' : ''}${r.diff ?? ''}</td></tr>`).join('')}</tbody>
    </table></div>`).join('')}
    ${[...new Set(t.groups.flatMap((g) => g.rows.filter((r) => r.note).map((r) => `${r.color}|${r.note}`)))].map((x) => { const [c, n] = x.split('|'); return `<div class="note"><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:#${c.replace('#', '')}"></span> ${esc(n)}</div>`; }).join('')}
  `;
  view.querySelectorAll('[data-st]').forEach((b) => b.onclick = () => { state.standing = b.dataset.st; render(); });
}

// ---------- onglet Performance ----------
function isoWeek(d) {
  const x = new Date(dayKey(d) + 'T12:00:00Z'); const day = (x.getUTCDay() + 6) % 7;
  x.setUTCDate(x.getUTCDate() - day + 3); const y = x.getUTCFullYear();
  const w = 1 + Math.round(((x - new Date(Date.UTC(y, 0, 4))) / 864e5 - 3 + ((new Date(Date.UTC(y, 0, 4)).getUTCDay() + 6) % 7)) / 7);
  return `${y}-S${String(w).padStart(2, '0')}`;
}
function renderPerf() {
  const done = Object.values(HIST).filter((h) => h.result && !h.result.void);
  const picks = done.flatMap((h) => h.picks.filter((p) => p.win != null).map((p) => ({ ...p, h })));
  const pending = Object.values(HIST).filter((h) => !h.result).length;
  if (!picks.length) {
    view.innerHTML = `<h2>📈 Performance</h2><div class="card pad empty">Pas encore de match terminé avec un prono enregistré avant le coup d'envoi.<br>Le suivi démarre automatiquement : ${pending} pronos en attente de résultat.</div>`;
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
  view.innerHTML = `
    <h2>📈 Performance</h2>
    <div class="kpis">
      <div class="card kpi"><div class="v">${pct(all.r)}</div><div class="l">Taux de réussite général<br>${all.w}/${all.n} pronos</div></div>
      <div class="card kpi"><div class="v">${pct(main.r)}</div><div class="l">Résultat 1N2<br>${main.w}/${main.n}</div></div>
      <div class="card kpi"><div class="v ${pr.s >= 0 ? 'up' : 'down'}">${pr.s >= 0 ? '+' : ''}${pr.s.toFixed(1)} u</div><div class="l">Gains fictifs (1N2 + value)<br>ROI ${pr.roi >= 0 ? '+' : ''}${(pr.roi * 100).toFixed(1)} %</div></div>
      <div class="card kpi"><div class="v">${done.length}</div><div class="l">Matchs suivis<br>${pending} en attente</div></div>
    </div>
    ${table('Par type de prono', rowsBy((p) => p.type, (k) => TYPE_NAMES[k] || k), 'Type')}
    ${table('Par niveau de confiance', rowsBy((p) => p.stars, (k) => starsHtml(+k), (a, b) => b[0] - a[0]), 'Étoiles')}
    ${table('Par compétition', rowsBy((p) => p.h.slug, (k) => esc(comp(k).name)), 'Compétition')}
    ${table('Par semaine', rowsBy((p) => isoWeek(p.h.date), (k) => k.replace('-S', ' · semaine '), (a, b) => b[0].localeCompare(a[0])), 'Semaine')}
    ${table('Par mois', rowsBy((p) => dayKey(p.h.date).slice(0, 7), (k) => monthName.format(new Date(k + '-15T12:00:00Z')), (a, b) => b[0].localeCompare(a[0])), 'Mois')}
    <p class="note">Seuls les pronos enregistrés avant le coup d'envoi sont comptés. Les matchs avec prolongation ne sont pas comptés. Gains fictifs : 1 unité par prono ayant une vraie cote (les cotes estimées ≈ sont exclues).</p>
  `;
}

// ---------- fiche match ----------
function openMatch(id) {
  const m = M.matches.find((x) => x.id === id); if (!m) return;
  let sub = 'pronos';
  const body = $('#modalBody');
  const draw = () => {
    body.innerHTML = `
      <div class="fiche-head">
        <div class="small muted">${img(comp(m.slug).logo, 'logo" style="width:16px;height:16px;vertical-align:-3px')} ${esc(comp(m.slug).name)} · ${fDay.format(new Date(m.date))}</div>
        <div class="teams"><div>${img(m.h.logo)}${esc(m.h.short)}</div><div class="mid">${statusHtml(m)}</div><div>${img(m.a.logo)}${esc(m.a.short)}</div></div>
      </div>
      <div class="subtabs">${[['pronos', 'Pronos'], ['fiche', 'Fiche'], ['compos', 'Compos'], ['joueurs', 'Joueurs']].map(([k, l]) => `<button data-sub="${k}" class="${k === sub ? 'active' : ''}">${l}</button>`).join('')}</div>
      <div>${({ pronos: fichePronos, fiche: ficheStats, compos: ficheCompos, joueurs: fichePlayers })[sub](m)}</div>`;
    body.querySelectorAll('[data-sub]').forEach((b) => b.onclick = () => { sub = b.dataset.sub; draw(); });
  };
  draw();
  $('#modal').hidden = false; document.body.style.overflow = 'hidden';
}
function closeModal() { $('#modal').hidden = true; document.body.style.overflow = ''; }

const mkRow = (label, p, o, extra = '') => `<span>${label}${extra}</span><span class="pct">${pct(p)}</span><span class="odd">${o ? odd(o) : ''}</span>`;
function fichePronos(m) {
  const p = m.pred, o = m.odds.x12, mv = oddsMove(m);
  const arrow = (i) => { const x = mv?.[i]; if (!x || Math.abs(x.diff) < 0.03) return ''; return ` <span class="${x.diff < 0 ? 'down' : 'up'} small">${x.diff < 0 ? '▼' : '▲'} ${odd(x.from)}</span>`; };
  const g = p.goals, tg = p.teamGoals;
  const graded = m.graded || [];
  const pickLine = (x) => { const gr = graded.find((y) => y.type === x.type && y.key === x.key); return `<div class="row-between" style="padding:6px 0;border-bottom:1px solid var(--line)"><div><div class="small muted">${TYPE_NAMES[x.type]}</div><b>${esc(x.label)}</b>${x.edge ? ` <span class="tag value">+${Math.round(x.edge * 100)} %</span>` : ''}</div><div style="text-align:right">${starsHtml(x.stars)}<div class="small">${pct(x.p)}${x.odds ? ' · ' + odd(x.odds) + (x.est ? ' ≈' : '') : ''}</div>${gr ? verdictTag(gr) : ''}</div></div>`; };
  return `
    <div class="card pad section"><h3 style="margin-top:0">🎯 Nos pronos</h3>${m.picks.map(pickLine).join('')}</div>
    <div class="card pad section"><h3 style="margin-top:0">Résultat 1N2</h3>
      <div class="mk">${mkRow(esc(m.h.short), p.p.h, o?.[0], arrow(0))}${mkRow('Match nul', p.p.d, o?.[1], arrow(1))}${mkRow(esc(m.a.short), p.p.a, o?.[2], arrow(2))}</div>
      ${p.market ? `<p class="note">Modèle seul : ${pct(p.model.h)} / ${pct(p.model.d)} / ${pct(p.model.a)} · Bookmakers : ${pct(p.market.h)} / ${pct(p.market.d)} / ${pct(p.market.a)}${m.odds.src ? ` (cotes ${m.odds.src})` : ''}</p>` : '<p class="note">Pas encore de cotes pour ce match : probabilités du modèle seul.</p>'}
      <h3>Double chance</h3>
      <div class="mk">${mkRow(`${esc(m.h.short)} ou nul (1N)`, p.dc['1N'])}${mkRow(`Nul ou ${esc(m.a.short)} (N2)`, p.dc['N2'])}${mkRow('Pas de nul (12)', p.dc['12'])}</div>
    </div>
    <div class="card pad section"><h3 style="margin-top:0">⚽ Buts dans le match</h3>
      <div class="mk"><span class="small muted">Ligne</span><span class="small muted" style="text-align:right">Plus de</span><span class="small muted" style="text-align:right">Moins de</span>
      ${['0.5', '1.5', '2.5', '3.5', '4.5'].map((L) => `<span>${L.replace('.', ',')} buts</span><span class="pct">${pct(g[L])}</span><span class="pct" style="font-weight:500">${pct(1 - g[L])}</span>`).join('')}</div>
      ${m.odds.ou ? `<p class="note">Bookmaker : ligne ${String(m.odds.ou.line).replace('.', ',')} → plus ${odd(m.odds.ou.over)} / moins ${odd(m.odds.ou.under)}</p>` : ''}
      <h3>Les deux équipes marquent</h3>
      <div class="mk">${mkRow('Oui', p.btts)}${mkRow('Non', 1 - p.btts)}</div>
      <h3>Buts de chaque équipe</h3>
      <div class="mk"><span class="small muted"></span><span class="small muted" style="text-align:right">${esc(m.h.short)}</span><span class="small muted" style="text-align:right">${esc(m.a.short)}</span>
      ${['0.5', '1.5', '2.5'].map((L) => `<span>Plus de ${L.replace('.', ',')}</span><span class="pct">${pct(tg.h[L])}</span><span class="pct">${pct(tg.a[L])}</span>`).join('')}</div>
      <h3>Nombre exact de buts</h3>
      <div class="mk">${p.exact.map((x, i) => mkRow(i === 5 ? '5 buts ou plus' : `${i} but${i > 1 ? 's' : ''}`, x)).join('')}</div>
      <p class="note">Buts attendus : ${esc(m.h.short)} ${String(p.xg[0]).replace('.', ',')} · ${esc(m.a.short)} ${String(p.xg[1]).replace('.', ',')} · scores les plus probables : ${p.scores.map((s) => `${s.s} (${pct(s.p)})`).join(', ')}</p>
    </div>`;
}
function formHtml(list) {
  if (!list?.length) return '<span class="muted small">Non disponible</span>';
  return `<div class="form">${list.slice(0, 5).map((e) => `<b class="${e.res}" title="${esc(e.ha === 'dom' ? 'vs' : '@')} ${esc(e.opp)} ${esc(e.score)} (${esc(e.comp)})">${{ W: 'V', D: 'N', L: 'D' }[e.res] || '?'}</b>`).join('')}</div>`;
}
function ficheStats(m) {
  const s = m.stats, rank = (id) => { for (const t of S.tables) for (const g of t.groups) { const r = g.rows.find((x) => x.id === id); if (r && t.slug === m.slug) return r; } return null; };
  const rh = rank(m.h.id), ra = rank(m.a.id);
  const avg = (a, b) => (b ? (a / b).toFixed(2).replace('.', ',') : '–');
  return `
    <div class="card pad section"><h3 style="margin-top:0">Forme (5 derniers matchs)</h3>
      <div class="row-between" style="margin:6px 0"><span>${img(m.h.logo, 'logo" style="width:20px;height:20px;vertical-align:-5px')} ${esc(m.h.short)}</span>${formHtml(m.form.h)}</div>
      <div class="row-between" style="margin:6px 0"><span>${img(m.a.logo, 'logo" style="width:20px;height:20px;vertical-align:-5px')} ${esc(m.a.short)}</span>${formHtml(m.form.a)}</div>
      ${m.form.h.length ? `<div class="note">${m.form.h.slice(0, 5).map((e) => `${fShort.format(new Date(e.d))} ${e.ha === 'dom' ? 'vs' : '@'} ${esc(e.opp)} ${esc(e.score)}`).join(' · ')}</div>` : ''}
    </div>
    <div class="card pad section"><h3 style="margin-top:0">Stats dans la compétition</h3>
      <div class="table-wrap"><table><thead><tr><th class="l"></th><th>${esc(m.h.short)}</th><th>${esc(m.a.short)}</th></tr></thead><tbody>
        ${rh || ra ? `<tr><td class="l">Classement</td><td>${rh ? rh.rank + 'e · ' + rh.pts + ' pts' : '–'}</td><td>${ra ? ra.rank + 'e · ' + ra.pts + ' pts' : '–'}</td></tr>` : ''}
        <tr><td class="l">Matchs joués</td><td>${s.h?.m ?? '–'}</td><td>${s.a?.m ?? '–'}</td></tr>
        <tr><td class="l">Buts marqués / match</td><td>${avg(s.h?.gf, s.h?.m)}</td><td>${avg(s.a?.gf, s.a?.m)}</td></tr>
        <tr><td class="l">Buts encaissés / match</td><td>${avg(s.h?.ga, s.h?.m)}</td><td>${avg(s.a?.ga, s.a?.m)}</td></tr>
        <tr><td class="l">À domicile : marqués / encaissés</td><td>${avg(s.h?.hgf, s.h?.hm)} / ${avg(s.h?.hga, s.h?.hm)}</td><td>${avg(s.a?.hgf, s.a?.hm)} / ${avg(s.a?.hga, s.a?.hm)}</td></tr>
        <tr><td class="l">À l'extérieur : marqués / encaissés</td><td>${avg(s.h?.agf, s.h?.am)} / ${avg(s.h?.aga, s.h?.am)}</td><td>${avg(s.a?.agf, s.a?.am)} / ${avg(s.a?.aga, s.a?.am)}</td></tr>
        <tr><td class="l">Force (note Elo)</td><td>${m.pred.elo[0]}</td><td>${m.pred.elo[1]}</td></tr>
      </tbody></table></div>
    </div>
    <div class="card pad section"><h3 style="margin-top:0">Confrontations directes</h3>
      ${m.h2h.length ? m.h2h.map((r) => `<div class="row-between" style="padding:4px 0"><span class="small muted">${fShort.format(new Date(r.d))} · ${esc(r.comp)}</span><span>${esc(r.h)} <b>${r.hs} - ${r.as}</b> ${esc(r.a)}</span></div>`).join('') : '<span class="muted small">Aucune confrontation depuis janvier 2025.</span>'}
    </div>`;
}
function ficheCompos(m) {
  const side = (t, l) => l ? `<div class="card pad section"><div class="row-between"><b>${img(t.logo, 'logo" style="width:20px;height:20px;vertical-align:-5px')} ${esc(t.short)}</b><span class="tag">${esc(l.formation)}</span></div>
    <div class="lineup" style="margin-top:8px">${l.xi.map((p) => `<div><span class="muted">${esc(p.n || '')}</span> ${esc(p.name)} <span class="muted small">${esc(p.pos || '')}</span></div>`).join('')}</div>
    ${l.subs.length ? `<p class="note">Remplaçants : ${l.subs.map((p) => esc(p.name)).join(', ')}</p>` : ''}</div>` : '';
  const absents = ['h', 'a'].flatMap((s) => m.players[s].filter((p) => p.status === 'absent').map((p) => ({ ...p, t: m[s] })));
  if (!m.lineup.h && !m.lineup.a) return '<div class="card pad empty">Les compos officielles sortent environ 1 h avant le coup d\'envoi.<br>Le site les récupère automatiquement à la mise à jour suivante.</div>';
  return side(m.h, m.lineup.h) + side(m.a, m.lineup.a) +
    `<div class="card pad section"><h3 style="margin-top:0">🚑 Joueurs clés absents</h3>${absents.length ? absents.map((p) => `<div>${esc(p.name)} <span class="muted small">(${esc(p.t.short)} · ${p.g} buts, ${p.a} passes)</span></div>`).join('') : '<span class="muted small">Aucun buteur ou passeur important absent de la feuille de match.</span>'}
    <p class="note">ESPN ne fournit pas la liste des blessés : on signale les meilleurs buteurs et passeurs qui ne sont pas sur la feuille de match.</p></div>`;
}
function fichePlayers(m) {
  const list = (t, arr) => `<div class="card section"><div class="comp-head" style="margin:0;padding:10px 12px 4px">${img(t.logo)}${esc(t.short)}</div>
    <div class="player headrow"><span>Joueur</span><span>But</span><span>Passe</span><span>Décisif</span><span>Cote</span></div>
    ${arr.length ? arr.slice(0, 8).map((p) => `<div class="player"><div class="pn"><b>${esc(p.name)}</b> ${p.status !== 'probable' ? `<span class="tag ${p.status === 'titulaire' ? 'win' : p.status === 'absent' ? 'lose' : ''}">${p.status}</span>` : ''}<small>${p.g} but${p.g > 1 ? 's' : ''} · ${p.a} passe${p.a > 1 ? 's' : ''} · ${p.m ?? '?'} matchs</small></div><span class="v">${pct(p.pg)}</span><span class="v">${pct(p.pa)}</span><span class="v">${pct(p.pd)}</span>${oddCell(p)}</div>`).join('') : '<div class="empty">Pas de données joueurs.</div>'}</div>`;
  const sc = m.scorers || [];
  const odds = sc.length ? `<div class="card pad section"><h3 style="margin-top:0">💰 Cotes buteur Bet365</h3>
    <div class="scorers"><span class="small muted">Joueur</span><span class="small muted" style="text-align:right">À tout moment</span><span class="small muted" style="text-align:right">1er buteur</span><span class="small muted" style="text-align:right">Chances (cote)</span>
    ${sc.map((s) => `<span>${esc(s.name)}</span><b style="text-align:right">${odd(s.o)}</b><span class="muted" style="text-align:right">${s.first ? odd(s.first) : '–'}</span><span class="muted" style="text-align:right">${pct(Math.min(0.95, 0.85 / s.o))}</span>`).join('')}</div>
    <p class="note">Chances (cote) = ce que la cote représente, sans la marge du bookmaker (≈15 %).</p></div>` : '<p class="note">Pas encore de cotes buteur pour ce match.</p>';
  return list(m.h, m.players.h) + list(m.a, m.players.a) + odds + '<p class="note">Basé sur les meilleurs buteurs et passeurs de chaque équipe dans cette compétition.</p>';
}

// ---------- navigation ----------
function render() {
  if (!M) return;
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === state.tab));
  ({ matchs: renderMatchs, semaine: renderSemaine, weekend: renderWeekend, joueurs: renderJoueurs, classements: renderClassements, perf: renderPerf })[state.tab]();
}
$('#tabs').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; state.tab = b.dataset.tab; render(); window.scrollTo({ top: 0 }); };
view.addEventListener('click', (e) => { const c = e.target.closest('[data-id]'); if (c && !e.target.closest('input,select,button')) openMatch(c.dataset.id); });
$('#closeModal').onclick = closeModal;
$('#modal').onclick = (e) => { if (e.target.id === 'modal') closeModal(); };
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
$('#themeBtn').onclick = () => {
  const dark = document.documentElement.dataset.theme ? document.documentElement.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.dataset.theme = dark ? 'light' : 'dark';
  try { localStorage.setItem('theme', document.documentElement.dataset.theme); } catch (e) {}
};
if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});

load().catch((e) => { view.innerHTML = `<div class="empty">Impossible de charger les données (${esc(e.message)}).</div>`; });
