# Jev shadow V4 — grilles, sorties de lots et coûts observés

## Périmètre et versions

La V4 étend l'expérience sans donner à Jev accès aux ordres live. Les services d'exécution, les réservations, les règles comptables et la policy déterministe restent inchangés. La capture reste après le cycle normal, sur un client DB séparé ; ses erreurs sont journalisées sans bloquer le manager. Le consommateur Jev et le collecteur de données sont deux processus indépendants.

Versions : questions `shadow-jev-v4`, décisions `shadow-decisions-v4`, sous-ensemble grid `shadow-grid-candidates-v3.1`, sorties `shadow-exits-v1`, coûts `shadow-observed-cost-v1`, évaluateur `shadow-jev-v4-evaluation-v1`. Modèle demandé : `jev-1.13.0` ; le modèle réellement retourné reste journalisé. Les observations V1/V2/V3/V3.1 et leurs questions sont conservées.

## Deux choix Jev séparés

1. **Futures entrées** : KEEP, proposition de la policy et variantes de grilles calculées à partir des bougies clôturées. L'expérience admet une largeur minimale de 2 % pour certaines variantes, au lieu du minimum live de 6 %, si le spacing couvre le modèle de coûts avec marge. Ces variantes portent `shadow-only-v4` / `unvalidated` : leur admission dans l'expérience n'est pas une autorisation live.
2. **Lots existants** : garder, rapprocher ou éloigner les cibles. Les changements sont bornés par la volatilité, l'amplitude récente et un plafond de 5 %. Ils nécessitent un profil de coûts observés utilisable. SOL conserve un gain net minimal ; BTC permet la récupération du capital et une rétention minimale de BTC après les coûts modélisés. Ces planchers ne garantissent pas le résultat d'une exécution réelle.

Une variante de nouvelle band peut mobiliser la réserve USDC **déjà présente** lorsque le cash de la band courante ne permet plus un ordre. Elle reste soumise aux limites d'exposition, de nombre de bands, de capital et aux engagements connus. Le manager live n'est pas modifié pour recharger une band dans son range.

Les choix sont présentés avec des identifiants neutres, mélangés de façon reproductible ; `abstain` conserve la policy pour les entrées et les engagements actuels pour les sorties. Les distributions complètes des deux choix, requêtes, réponses, modèle, latence et erreurs sont persistées dans l'outbox et son journal de tentatives. Ces probabilités expriment une préférence entre plans, pas une probabilité de bénéfice ni une calibration financière démontrée.

## Observation et données supplémentaires

L'observation immuable conserve le portefeuille complet sous `REPEATABLE READ`, la policy d'origine, tous les candidats, leurs rejets et le profil de coûts daté. Les bougies horaires restent dans un snapshot marché partagé. Un second snapshot immuable de bougies de 5 minutes est référencé par `context.shadowFineMarket` ; les séries ne sont pas recopiées dans chaque observation. Une série absente ou discontinue à la capture est explicitement signalée.

La projection Jev reçoit les 24 dernières bougies horaires et jusqu'à 24 bougies de 5 minutes déjà clôturées, les données économiques utiles et les plans calculés. Aucun historique futur, clé de signature ou secret de wallet n'est envoyé.

Le collecteur `shadow-data` vérifie les mints des pools GeckoTerminal avant de collecter BTC/SOL en 5 minutes et en 1 heure. Le BTC modélisé est le mint `3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh` sur Solana. Une bougie publique constitue une approximation de marché et ne garantit pas la liquidité d'un swap Jupiter.

## Coûts et quotes Jupiter

Le profil est calculé avec les exécutions terminées avant l'observation, pour le même portfolio/bot et les mêmes mints, dans un intervalle de notionnels. Il exige au moins cinq exécutions et une couverture des frais, du slippage défavorable et du débit natif. Il utilise des quantiles conservateurs, une marge de sécurité et conserve les identifiants des exécutions sources. Une donnée inconnue reste inconnue ; un profil incomplet entraîne le maintien des hypothèses historiques et interdit les variantes de sortie.

Les frais Jupiter inclus dans les quantités réellement débitées/reçues ne sont pas ajoutés une seconde fois au résultat réalisé. Le débit SOL du wallet inclut les dépenses natives observées, dont le rent lorsqu'il est présent ; une estimation de rent séparée ne doit pas être additionnée de nouveau.

La valorisation USDC native gelée dans `executedFeeAmount` au settlement est prioritaire lorsque les mints, les quantités et le débit SOL confirmé concordent. Sa date et sa source sont exposées. Le repli vers un prix SOL historique reste causal ; la purge du cache de prix ne doit pas effacer un coût déjà valorisé dans l'exécution.

Toutes les 30 minutes, le collecteur compare des quotes achat puis vente `/order` et `/build` sur deux tailles bornées. Les appels utilisent exclusivement `JUPITER_SHADOW_API_KEY` avec `SHADOW_JUPITER_QUOTA_ISOLATED=true`. `/build` reçoit une adresse publique de taker ; les instructions retournées sont écartées. Le processus ne monte aucun fichier secret de wallet et n'appelle jamais `/execute`.

Les erreurs et écarts temporels sont enregistrés. `economicallyComparable` reste faux : les coûts de landing `/build` ne sont pas connus et les quotes ne sont pas des fills. Cette collecte peut révéler une piste d'économie, mais ne permet pas d'affirmer à elle seule qu'un autre chemin est moins cher ou plus rapide en réel.

Les appels Jupiter sont espacés d'au moins 1,1 seconde sur l'ensemble des comparaisons du processus. La fraîcheur des bougies est signalée séparément : le pool BTC peut cesser de publier des intervalles récents, même avec `include_empty_intervals=true`. Les intervalles manquants ne sont pas fabriqués ; les captures et horizons concernés restent indisponibles ou censurés.

## Replay causal hors ligne

```bash
pnpm --filter @grid-bot/worker shadow:replay:v4 -- --observation-id <id> --native-fee-usd <estimation-positive-par-swap>
pnpm --filter @grid-bot/worker shadow:costs -- --portfolio-id <id> --bot-id <id>
```

Le runner lit uniquement la base, sans réseau ni écriture. Il exporte les entrées publiques exactes et leur hash, les références de cache, les coûts et les hypothèses. Les cinq branches sont KEEP, policy, grid Jev seule, sorties Jev seules et combinaison. Elles partent du même état et du même capital. La comparaison principale est le bot actuel ; aucun achat all-in fictif n'est imposé.

L'intervention Jev n'entre en vigueur qu'après la fin enregistrée de sa réponse, au début de la première bougie d'exécution entière suivante. Les fills synthétiques utilisent les bougies de 5 minutes si elles sont complètes pour tous les actifs ; la cadence de la policy reste horaire. Les métriques sont calculées à +1/+3/+6/+24 heures, avec censure des horizons incomplets. Les états capturés après une mutation économique postérieure à la clôture, les réservations en cours, les engagements inconnus ou les provenances incompatibles sont refusés.

Un fichier facultatif `--cashflows <fichier.json>` applique les mêmes dépôts/retraits datés à toutes les branches :

```json
[{"id":"deposit-1","at":"2026-10-01T12:30:00Z","amountUsd":100}]
```

Les dépôts sont exclus du gain et du drawdown ajusté ; un retrait nécessite du cash libre. Cette entrée est un scénario explicite, pas une détection automatique des dépôts du wallet. BTC est évalué par rétention de BTC et valeur de tout l'inventaire ; SOL par USDC nets et valeur totale. Le cash libre et le capital immobilisé restent visibles.

Le replay teste **une intervention Jev**, suivie de la policy déterministe dans chaque branche. Il ne simule pas encore un expert Jev pilotant en continu les états alternatifs. Les chemins intrabougie, quotes et fills sont modélisés ; les fenêtres se chevauchent. Il faut collecter des horizons complets et des régimes différents avant de conclure à une amélioration ou de promouvoir une décision en live.

## Exploitation

Service de collecte : `docker compose --env-file .env.production -f docker-compose.prod.yml --profile shadow up -d shadow-data`.

La table additive `shadow_quote_comparisons` conserve les comparaisons immuables. Aucun paramètre live n'est ajusté à partir des profils ou des réponses Jev. Une nouvelle version doit accompagner tout changement des questions, du générateur, des règles économiques ou des hypothèses d'évaluation.
