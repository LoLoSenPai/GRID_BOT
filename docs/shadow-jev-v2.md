# Jev shadow V2 — choix de configurations de grid

## Périmètre

Le worker continue à exécuter uniquement `evaluatePortfolioPolicy`. Une capture shadow est planifiée après le cycle normal, sur la connexion DB séparée déjà utilisée par la V1. Une erreur de génération, de snapshot, d'outbox ou d'appel Jev est journalisée et n'entre jamais dans la décision du PortfolioManager. Le consommateur Jev est un processus séparé. Les anciens jobs `shadow-jev-v1` restent traitables avec leurs questions d'origine.

La V2 utilise le modèle épinglé `jev-1.13.0`, le jeu de questions `shadow-jev-v2` et le générateur `shadow-grid-candidates-v2`. Une fois le worker V2 déployé, les nouvelles observations utilisent ce jeu ; les observations et jobs V1 déjà présents restent lisibles et traitables. Changer les prompts, le modèle, les règles de génération ou l'horizon impose une nouvelle version. La documentation [TypeSafe Choice](https://docs.typesafe.ai/primitives/choice) précise que la réponse contient une probabilité pour chaque option ; le modèle ne voit pas les identifiants des questions.

## Capture et jugement

Chaque observation conserve l'entrée complète de la policy, le contexte portfolio/band/bot, les lots et engagements de sortie du bot, les contextes des bands pairs, la décision proposée, un jeu de candidats immuable et une référence au snapshot de marché partagé. L'outbox persiste dans la même transaction que l'observation et le snapshot. Le jeu contient au plus six candidats : grille actuelle (`keep`), décision de la policy si applicable, variantes bornées de largeur et de nombre de niveaux. Les variantes passent les contrôles de range, rails, coûts et capital ; les rejets et leurs motifs sont conservés. La grille existante reste une référence même si les règles actuelles empêcheraient de l'ouvrir comme nouvelle grille. L'éligibilité temporelle de la policy est stockée séparément de la validité économique, ce qui permet d'étudier une adaptation plus précoce sans l'autoriser en live.

Jev reçoit une projection courte : 24 bougies clôturées au plus, band, résumé des lots ouverts, capital disponible, coûts estimés, objectif BTC/SOL et géométrie de chaque candidat. Les options portent des identifiants neutres (`option_0`, etc.) ; leur ordre est mélangé de façon déterministe à partir de l'instant et de la band pour réduire le biais de position. La correspondance avec `keep`/`policy`/variantes et la décision réelle reste en base. Le `Choice` demande une hypothèse sur la configuration la plus adaptée aux oscillations des 24 prochaines heures et offre `abstain`. Cette probabilité mesure l'incertitude de Jev parmi les options ; elle ne constitue ni une probabilité de profit ni une autorisation de trader.

L'outbox et le journal des tentatives conservent requête, réponse brute, distribution complète des options et candidats, modèle résolu, latence et erreurs. `abstain` ne modifie rien ; un replay qui l'utilise devra définir explicitement son repli vers la policy déterministe.

## Comparaison future

`PortfolioPolicyReplayService` accepte un `candidateSelector` optionnel appelé à chaque clôture avec le préfixe historique et l'état propre à sa branche. Il applique la décision complète du candidat choisi et garde ses propres lots, cash et sorties promises. Le mode fixed/adaptive existant reste identique sans sélecteur. Ce point d'entrée permet des simulations séquentielles à capital initial, données et coûts égaux.

**Les jugements enregistrés sur le chemin live ne suffisent pas à simuler seuls une trajectoire Jev complète** : dès qu'un candidat différent est choisi, cash, lots et bandes divergent, donc les prochaines décisions exigent des observations et jugements calculés sur ce nouvel état. L'évaluation hors ligne devra produire ces jugements de branche, ou se limiter explicitement à une intervention unique suivie de la policy déterministe. Le replay actuel n'amorce qu'une band par actif et ses chemins intrabougie sont synthétiques ; il faut l'étendre pour reproduire un portefeuille live à plusieurs bands, et ses fills ne prouvent pas qu'un swap Jupiter aurait eu lieu au même prix.

Le protocole de mesure à figer avant exploitation des nouveaux résultats : mêmes capital initial et frais pour toutes les branches ; métriques à +1 h, +3 h, +6 h et +24 h quand couvertes ; équité totale incluant cash et inventory non vendu ; pour BTC, BTC retenu et valeur du portefeuille exprimée aussi en BTC au prix d'horizon ; pour SOL, USDC réalisés et équité totale ; comparaison avec policy déterministe et grille fixe. Les cas où les objectifs se contredisent restent indéterminés. Une fenêtre future non utilisée pour ajuster prompts, variantes ou seuils est nécessaire avant toute promotion live.

## Déploiement

La migration `20260928120000_shadow_jev_v2_candidates` ajoute `candidate_set` nullable pour préserver les observations V1. Elle doit être appliquée avant de lancer un worker qui capture `shadow-jev-v2`. Aucun résultat V2 n'est consommé par le moteur d'exécution.
