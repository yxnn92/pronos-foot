// Compétitions affichées sur le site (code ESPN → nom français).
export const DISPLAY = [
  { slug: 'eng.1', name: 'Premier League', short: 'PL', type: 'league', tier: 1 },
  { slug: 'esp.1', name: 'Liga', short: 'Liga', type: 'league', tier: 1 },
  { slug: 'ita.1', name: 'Serie A', short: 'SA', type: 'league', tier: 1 },
  { slug: 'ger.1', name: 'Bundesliga', short: 'BL', type: 'league', tier: 1 },
  { slug: 'fra.1', name: 'Ligue 1', short: 'L1', type: 'league', tier: 1 },
  { slug: 'uefa.champions', name: 'Ligue des champions', short: 'LDC', type: 'cup', tier: 1 },
  { slug: 'uefa.europa', name: 'Ligue Europa', short: 'LE', type: 'cup', tier: 1 },
  { slug: 'uefa.europa.conf', name: 'Conference League', short: 'LC', type: 'cup', tier: 1 },
  { slug: 'fifa.world', name: 'Coupe du monde', short: 'CDM', type: 'nations' },
  { slug: 'uefa.euro', name: 'Euro', short: 'Euro', type: 'nations' },
  { slug: 'uefa.nations', name: 'Ligue des nations', short: 'LDN', type: 'nations' },
  { slug: 'fifa.worldq.uefa', name: 'Qualifs Coupe du monde', short: 'Qualifs', type: 'nations' },
  { slug: 'uefa.euroq', name: 'Qualifs Euro', short: 'Qualifs', type: 'nations' },
  { slug: 'uefa.super_cup', name: "Supercoupe d'Europe", short: 'SC', type: 'cup', tier: 1 },
  { slug: 'fra.super_cup', name: 'Trophée des champions', short: 'TDC', type: 'cup', tier: 1 },
  { slug: 'eng.charity', name: 'Community Shield', short: 'CS', type: 'cup', tier: 1 },
  { slug: 'esp.super_cup', name: "Supercoupe d'Espagne", short: 'SC', type: 'cup', tier: 1 },
  { slug: 'ita.super_cup', name: "Supercoupe d'Italie", short: 'SC', type: 'cup', tier: 1 },
  { slug: 'ger.super_cup', name: "Supercoupe d'Allemagne", short: 'SC', type: 'cup', tier: 1 },
];

// Compétitions lues uniquement pour calculer la force des équipes (non affichées).
// Elles servent à bien noter les clubs hors Top 5 qui jouent les coupes d'Europe.
export const RATING_ONLY = [
  { slug: 'uefa.champions_qual', tier: 2 },
  { slug: 'uefa.europa_qual', tier: 2 },
  { slug: 'uefa.europa.conf_qual', tier: 3 },
  { slug: 'por.1', tier: 2 }, { slug: 'ned.1', tier: 2 }, { slug: 'bel.1', tier: 2 },
  { slug: 'tur.1', tier: 2 }, { slug: 'sco.1', tier: 3 }, { slug: 'aut.1', tier: 3 },
  { slug: 'gre.1', tier: 3 }, { slug: 'den.1', tier: 3 }, { slug: 'nor.1', tier: 3 },
  { slug: 'swe.1', tier: 3 },
];

// Classements affichés.
export const STANDINGS = ['eng.1', 'esp.1', 'ita.1', 'ger.1', 'fra.1', 'uefa.champions', 'uefa.europa', 'uefa.europa.conf'];

// Note Elo de départ selon le championnat national de l'équipe (niveau moyen du championnat).
// Sans ça, les cadors des petits championnats seraient surcotés.
export const LEAGUE_START = {
  'eng.1': 1740, 'esp.1': 1700, 'ita.1': 1690, 'ger.1': 1680, 'fra.1': 1640,
  'por.1': 1560, 'ned.1': 1560, 'bel.1': 1540, 'tur.1': 1530,
  'aut.1': 1480, 'gre.1': 1480, 'den.1': 1470, 'sco.1': 1440, 'nor.1': 1420, 'swe.1': 1400,
};
export const START_DEFAULT = 1380; // clubs vus seulement en coupe d'Europe (petits pays)

export const HOME_ADV = 50;      // avantage du terrain, en points Elo (clubs), réglé par backtest
export const HOME_ADV_NAT = 90;  // sélections, quand le match n'est pas sur terrain neutre
export const K_CLUB = 20;
export const K_EURO = 1.5;       // les matchs de coupe d'Europe comptent plus : ils comparent les championnats
export const MODEL_WEIGHT = 0.45; // part du modèle face aux cotes du marché (0,45 = 45 % modèle, 55 % marché)
export const VALUE_EDGE = 0.05;  // value bet si probabilité × cote ≥ 1,05
export const MAX_GAP = 0.15;     // pas de value si le modèle et le marché diffèrent de plus de 15 points
export const DAYS_AHEAD = 7;
export const DAYS_BACK = 2;
