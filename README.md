# Pronos Foot

Site perso de pronostics football. Il se met à jour **tout seul sur GitHub**, sans IA et sans clé API.

## Ce qu'il y a dedans

| Dossier / fichier | Rôle |
|---|---|
| `index.html`, `assets/` | Le site (pages, style, logique d'affichage) |
| `data/` | Les données calculées : matchs, pronos, classements, historique |
| `scripts/update.mjs` | Récupère les données ESPN et calcule les pronos |
| `scripts/model.mjs` | Le modèle : force Elo + loi de Poisson, mélangé aux cotes |
| `scripts/config.mjs` | Les réglages (compétitions, poids du modèle, seuil des value bets…) |
| `scripts/backtest.mjs` | Teste le modèle sur les matchs passés |
| `.github/workflows/update.yml` | Le « robot » GitHub qui relance la mise à jour chaque heure |

## Sources (gratuites, sans clé)

- **ESPN** : calendrier, scores, classements, logos, compos, buteurs, cotes Bet365 et DraftKings.
- **eloratings.net** : force des sélections nationales.

## Sur ton PC

Il faut [Node.js](https://nodejs.org) (version 20 ou plus).

```
node scripts/update.mjs     # met à jour les données
node scripts/serve.mjs      # puis ouvre http://localhost:8080
```

## Réglages utiles (`scripts/config.mjs`)

- `MODEL_WEIGHT` : part du modèle face aux bookmakers (0,45 = 45 % modèle).
- `VALUE_EDGE` : avantage minimum pour un value bet (0,05 = 5 %).
- `DISPLAY` : les compétitions affichées.

Aucune garantie de gain : pariez de façon responsable (18+).
