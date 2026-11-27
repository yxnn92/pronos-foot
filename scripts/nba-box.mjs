// Feuilles de match NBA : extraction des stats joueurs et récolte (cache par saison).
// Format d'un joueur : [id, nom, poste, minutes, points, rebonds, passes, titulaire(1/0), photo, paniers à 3 pts]
import path from 'node:path';
import { NBA, CACHE, getJSON, readJSON, writeJSON } from './nba-lib.mjs';

export const BOX_VERSION = 2;
export function extractBox(s) {
  const teams = {};
  for (const tp of s?.boxscore?.players || []) {
    const st = tp.statistics?.[0]; if (!st) continue;
    const ix = (n) => st.names.indexOf(n);
    teams[tp.team.id] = (st.athletes || []).filter((a) => !a.didNotPlay && a.stats?.length).map((a) => [
      a.athlete.id, a.athlete.displayName, a.athlete.position?.abbreviation || '', +a.stats[ix('MIN')] || 0, +a.stats[ix('PTS')] || 0,
      +a.stats[ix('REB')] || 0, +a.stats[ix('AST')] || 0, a.starter ? 1 : 0, a.athlete.headshot?.href || '', parseInt(String(a.stats[ix('3PT')] || '0').split('-')[0], 10) || 0,
    ]);
  }
  return teams;
}

// Récolte les feuilles manquantes (ou d'une ancienne version) pour une liste de matchs terminés.
export async function collectBoxes(file, games, { parallel = 6, log = () => {} } = {}) {
  const box = readJSON(file, {});
  const need = games.filter((g) => g.completed && (!box[g.id] || box[g.id].v !== BOX_VERSION));
  let i = 0, done = 0;
  await Promise.all(Array.from({ length: parallel }, async () => {
    while (i < need.length) {
      const g = need[i++];
      const s = await getJSON(`${NBA}/summary?event=${g.id}`);
      if (s) box[g.id] = { v: BOX_VERSION, d: g.date, t: extractBox(s) };
      if (++done % 200 === 0) { writeJSON(file, box); log(`${done}/${need.length}`); }
    }
  }));
  if (need.length) writeJSON(file, box);
  return { box, fetched: need.length };
}
export const boxFile = (season, current) => path.join(CACHE, current ? 'nba-box.json' : `nba-box-${season}.json`);
