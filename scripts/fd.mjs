// Télécharge les cotes et résultats passés de football-data.co.uk (Top 5, 3 saisons) dans data/cache/fd.
// Lancé par GitHub (fichier .github/workflows/fetch-data.yml).
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'cache', 'fd');
await fs.mkdir(DIR, { recursive: true });
const seasons = ['2425', '2526', '2627'];
const leagues = ['E0', 'SP1', 'I1', 'D1', 'F1'];
for (const s of seasons) for (const l of leagues) {
  const url = `https://www.football-data.co.uk/mmz4281/${s}/${l}.csv`;
  try {
    const r = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (pronos perso)' } });
    const t = await r.text();
    if (!r.ok || !t.startsWith('Div')) { console.log('échec', url, r.status); continue; }
    await fs.writeFile(path.join(DIR, `${s}_${l}.csv`), t);
    console.log('ok', s, l, t.split('\n').length - 2, 'matchs');
  } catch (e) { console.log('erreur', url, e.message); }
}
