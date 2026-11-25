// Récolte, pour chaque match joué (Top 5 + coupes d'Europe), les tirs, tirs cadrés, titulaires et buteurs (ESPN).
// Résultat : data/cache/matchstats.json. Les matchs déjà récoltés ne sont pas retéléchargés.
// Usage : node scripts/collect.mjs
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, 'data', 'cache');
const OUT = path.join(CACHE, 'matchstats.json');
const SITE = 'https://site.api.espn.com/apis/site/v2/sports/soccer';
export const STAT_SLUGS = ['eng.1', 'esp.1', 'ita.1', 'ger.1', 'fra.1', 'uefa.champions', 'uefa.europa', 'uefa.europa.conf'];

async function getJSON(url) {
  for (let i = 0; i < 3; i++) {
    try { const r = await fetch(url, { signal: AbortSignal.timeout(30000) }); if (r.ok) return await r.json(); } catch {}
    await new Promise((res) => setTimeout(res, 1000 * (i + 1)));
  }
  return null;
}

export function extractStats(s, e) {
  const hId = e.h.id, aId = e.a.id, side = (tid) => (tid === hId ? 'h' : tid === aId ? 'a' : null);
  const st = { h: {}, a: {} };
  for (const t of s.boxscore?.teams || []) { const sd = side(t.team?.id); if (!sd) continue; for (const x of t.statistics || []) st[sd][x.name] = parseFloat(x.displayValue); }
  const starters = { h: [], a: [] };
  for (const r of s.rosters || []) { const sd = side(r.team?.id); if (sd) starters[sd] = (r.roster || []).filter((p) => p.starter).map((p) => p.athlete?.id).filter(Boolean); }
  const goals = (s.keyEvents || []).filter((k) => k.scoringPlay || /goal|penalty---scored/.test(k.type?.type || ''))
    .map((k) => ({ t: side(k.team?.id), s: k.participants?.[0]?.athlete?.id || null, a: k.participants?.[1]?.athlete?.id || null, og: k.type?.type === 'own-goal' }))
    .filter((g) => g.t);
  return {
    sot: [st.h.shotsOnTarget ?? null, st.a.shotsOnTarget ?? null],
    shots: [st.h.totalShots ?? null, st.a.totalShots ?? null],
    starters, goals,
  };
}

async function main() {
  const stats = JSON.parse(await fs.readFile(OUT, 'utf8').catch(() => '{}'));
  const todo = [];
  for (const slug of STAT_SLUGS) {
    const evs = [];
    const c25 = JSON.parse(await fs.readFile(path.join(CACHE, `${slug}-2025.json`), 'utf8').catch(() => '{"events":[]}'));
    evs.push(...c25.events);
    const j = await getJSON(`${SITE}/${slug}/scoreboard?dates=2026&limit=1000`);
    for (const e of j?.events || []) {
      const c = e.competitions?.[0], h = c?.competitors?.find((x) => x.homeAway === 'home'), a = c?.competitors?.find((x) => x.homeAway === 'away');
      if (e.status?.type?.completed && h && a) evs.push({ id: e.id, slug, date: e.date, h: { id: h.team.id }, a: { id: a.team.id }, completed: true });
    }
    for (const e of evs) if (e.completed && !stats[e.id]) todo.push({ ...e, slug });
  }
  console.log('matchs à récolter :', todo.length, '(déjà en cache :', Object.keys(stats).length, ')');
  let i = 0, done = 0;
  const worker = async () => {
    while (i < todo.length) {
      const e = todo[i++];
      const s = await getJSON(`${SITE}/${e.slug}/summary?event=${e.id}`);
      if (s) stats[e.id] = { slug: e.slug, date: e.date, ...extractStats(s, e) };
      if (++done % 250 === 0) { await fs.writeFile(OUT, JSON.stringify(stats)); console.log(done, '/', todo.length); }
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  await fs.writeFile(OUT, JSON.stringify(stats));
  console.log('terminé :', Object.keys(stats).length, 'matchs');
}
if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}` || process.argv[1].endsWith('collect.mjs')) main();
