# Jev shadow V4 — grilles, sorties de lots et coûts observés

## Corrections du 12 octobre : V4.2 et comparaison simple

Les nouvelles observations utilisent `shadow-jev-v4.2`, `shadow-decisions-v4.2` et `shadow-grid-candidates-v3.3`. Le modèle reste `jev-1.13.0`. Les versions précédentes et leurs réponses ne sont pas réécrites. Une proposition de financement refusée par les contraintes économiques est désormais enregistrée parmi les rejets, sans être ajoutée aux choix Jev comme une option invalide.

Le résultat moteur original reste immuable. Un second essai contradictoire est conservé avec ses deux empreintes sous `conflicts/` dans le volume de capture ; il ne réessaie plus indéfiniment. Les autres erreurs conservent leur reprise espacée et leur contexte d'échec. Les producteurs du worker et du collecteur partagent le journal persistant ; aucun appel shadow n'entre dans l'exécution des ordres.

### BTC : référence séparée et observable sans bougies Gecko fraîches

Le collecteur ajoute les bougies publiques Coinbase `BTC-USD`, sous l'identité **`coinbase-reference / BTC_REF / USD`**. Il ne remplace aucun enregistrement `BTC/USDC` ni aucune donnée consommée par la policy live. Les bougies fermées sont validées, les trous restent des trous, et les captures gardent leurs dates de réception.

Un observateur indépendant capture les bands BTC à partir d'un préfixe horaire complet de cette référence et des états effectivement disponibles dans la base. L'identité de marché sépare ses observations des observations de la policy, même pour la même band et la même heure. Il garde les budgets, les lots et leurs engagements réels. Si un résultat moteur de cette heure est déjà enregistré, il le référence ; sinon le résultat est `observed_only`. Le replay annonce alors explicitement une hypothèse initiale de maintien, sans prétendre disposer d'une décision live manquante.

La référence USD n'est ni le token BTC sur Solana ni une quote Jupiter en USDC. La conversion USD/USDC et l'absence de basis sont des hypothèses de replay. Le contrôle de prix compare des instants proches ; les séries et leurs sources restent identifiables dans les exports. Les deux flux BTC ne constituent pas des échantillons indépendants et doivent être analysés séparément.

### Replay V3 : coût, prix de rail et grille dense sans Jev

La CLI active `shadow-jev-v4-evaluation-v3` : prix de rail avec slippage, au plus une exécution par band et bougie, contraintes d'achat capturées de cooldown, fréquence, budget et drawdown. Aucune des six branches ne trade sur une bougie commencée avant la disponibilité du snapshot. Les coûts issus du profil observé, les estimations de repli et les trades hors de l'intervalle de notionnels sont comptés séparément. Deux chemins OHLC sont comparés : ils illustrent la sensibilité à l'ordre des extrema et ne constituent pas des bornes garanties.

Une sixième branche `denseRule` prend systématiquement le candidat de densité validé disponible, ou conserve la policy lorsqu'il manque. Elle reçoit le même capital et les mêmes coûts et conserve les sorties initiales. Le choix de cette branche ne dépend ni de la réponse Jev ni des résultats futurs. Sa disponibilité ne peut précéder celle de l'état capturé. `--matched-clock` aligne son intervention sur la disponibilité réelle de Jev pour comparer le choix à délai égal.

```bash
pnpm --filter @grid-bot/worker shadow:replay:v4 -- --observation-id <id> --native-fee-usd 0.004 --matched-clock
pnpm --filter @grid-bot/worker shadow:replay:v4 -- --observation-id <id> --native-fee-usd 0.004 --btc-reference --matched-clock
```

`--btc-reference` est explicite pour les observations historiques du pool. Leurs bougies initiales restent celles du snapshot, leurs bougies futures peuvent provenir de Coinbase : les deux sources sont déclarées dans la provenance. Ce scénario est conditionnel, pas une reconstitution de l'information effectivement accessible en live. `--legacy-fills` permet de reproduire l'ancien évaluateur V2 ; il doit être signalé dans les comparaisons.

### Ce qui impose les espacements actuels

La policy live part notamment d'une largeur minimale de 6 %, du maximum entre minimum de spacing, demi-ATR et coût aller-retour avec marge. Avec les défauts de 50 bps de slippage et 10 bps de frais par côté, le modèle donne environ 1,21 %, puis ajoute 0,25 point de marge. Pour une largeur de 6 %, son arrondi de niveaux peut produire quatre rails. Ce résultat vient des hypothèses prudentes et de l'arrondi, pas d'une mesure de frais réels de 1,46 %. Les nouvelles projections exposent ces paramètres ; aucun seuil live n'est modifié.

Le prochain bilan doit comparer la policy, `denseRule` et Jev sur le même état, en distinguant coût net, capital immobilisé et valeur d'inventaire. Les fenêtres non superposées sont privilégiées. L'ajout d'indicateurs ou de familles de stratégies n'est pas nécessaire pour cette comparaison ; aucun résultat de cette étape n'autorise automatiquement une promotion live.

### Interface

Dashboard et liste du terminal regroupent les zones par portefeuille et stratégie, avec budget, valeur, inventaire et usage pondéré. Chaque zone garde sa plage et son lien vers le bot précis. Les commandes continuent à cibler un bot ; le regroupement visuel ne fusionne pas les grilles. Le cash libre affiché exclut les réservations.

## Architecture V4/V4.1 conservée pour les observations historiques

La V4 étend l'expérience sans donner à Jev accès aux ordres live. La policy et les paramètres de trading restent déterministes. Depuis la V4.1, le worker publie après son cycle un fichier atomique contenant l'entrée shadow et le résultat moteur connu. Le service indépendant `shadow-capture` transfère ce journal persistant vers la DB ; `shadow-jev` traite ensuite l'outbox. Le collecteur `shadow-data` reste indépendant.

Versions de la V4.1 : questions `shadow-jev-v4.1`, décisions `shadow-decisions-v4.1`, sous-ensemble grid `shadow-grid-candidates-v3.2`, sorties `shadow-exits-v1`, coûts `shadow-observed-cost-v1`, évaluateur historique `shadow-jev-v4-evaluation-v2`. Les versions V4.2/V3 de replay sont décrites ci-dessus. Modèle demandé : `jev-1.13.0` ; le modèle réellement retourné reste journalisé. Les observations et réponses historiques restent immuables ; les consommateurs et lecteurs acceptent leurs anciennes versions appariées.

La V3.2/V4.1 tolère uniquement une erreur numérique de `1e-10` point de pourcentage aux frontières de largeur. Une baseline retenue pour comparaison porte ses motifs économiques explicites dans la question ; les variantes réellement invalides restent refusées. Aucun seuil live n'est changé.

## Journal de capture durable

Le worker n'attend aucune requête DB shadow ni réponse Jev. L'entrée et son outcome sont figés avant l'écriture asynchrone. Le volume Docker `shadow_capture_spool` conserve les fichiers à travers les redémarrages ; publication exclusive et `fsync` Linux protègent le premier enregistrement. Le consommateur unique utilise un lease renouvelé et reprend les fichiers `processing` après crash. Il supprime un fichier uniquement après capture **et** outcome persistés avec succès ; les erreurs entraînent une reprise espacée jusqu'à cinq minutes.

Une transaction de capture victime d'un conflit structuré `40001`, `40P01` ou `P2034`, y compris dans l'enveloppe Prisma `P2010`, dispose de quatre tentatives. Une observation déjà committée est retrouvée par sa clé immuable, même si sa band a été fermée entre-temps. Les autres erreurs restent dans le journal pour reprise.

Une panne du disque, ou un arrêt avant publication du fichier, ne bénéficie pas de cette durabilité : l'erreur est journalisée et le bot continue. Le journal ne remplace pas un état historique manquant. Le snapshot MVCC complet est lu par le consommateur avec sa **vraie** date de capture ; le replay continue à censurer une mutation postérieure à la clôture.

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

Le runner lit uniquement la base, sans réseau ni écriture. Il exporte les entrées exactes et leur hash, les références de cache, les coûts et les hypothèses. Les cinq branches partent du même cash et inventaire : KEEP garde la géométrie d'entrée fixe ; `currentPolicy` applique le résultat moteur réellement enregistré à t0, puis la policy horaire ; les branches Jev partagent cette décision initiale et ajoutent une intervention différée sur la grid, les sorties ou les deux. L'abstention délègue à la policy autonome, sans réappliquer une ancienne proposition après sa réponse. Aucun achat all-in fictif n'est imposé.

L'intervention Jev n'entre en vigueur qu'après la fin enregistrée de sa réponse, au début de la première bougie d'exécution entière suivante. Les fills synthétiques utilisent les bougies de 5 minutes si elles sont complètes pour tous les actifs ; la cadence de la policy reste horaire. Un repli explicitement marqué `1h` est permis uniquement si aucune série future de 5 minutes n'est disponible. Une série partielle reste censurée. Les métriques sont calculées à +1/+3/+6/+24 heures. Les états mutés après la clôture, les réservations en cours, les engagements inconnus ou les provenances incompatibles restent refusés.

Les verrous dont l'expiration est valide et antérieure ou égale à t0 sont ignorés, comme dans le runtime. Les signaux en attente, verrous actifs ou dates invalides restent censurés. Les fragments BTC accumulés à coût nul et prix d'entrée nul restent de l'inventaire retenu ; ils ne deviennent pas des lots à vendre.

Les écarts de quantité dépassant la tolérance historique ne sont acceptés que si l'historique exhaustif des exécutions explique **deux** valeurs indépendantes : l'agrégat avec son arrondi par exécution à huit décimales, et la somme exacte des quantités des lots. Identités, statuts, dates, ordre et quantités sont contrôlés ; coûts des lots et quantité sont réconciliés séparément. L'historique exporté inclut les statuts ambigus, sans les filtrer pour obtenir une concordance.

Le capital nominal de la band peut différer de cash + coût des lots + pertes à cause de frais SOL payés depuis la réserve native, dont la valeur figure dans le coût des lots. Au-delà de la tolérance historique, le replay exige une reconstruction indépendante des quatre soldes depuis le ledger et une explication par les écritures de frais externes. La différence prouvée ne corrige que l'invariant de validation : elle n'ajoute ni cash, ni gain, ni frais futurs, ni capital pour les limites de risque.

Ces preuves `ordered-receipts-v1` et `band-ledger-v1` sont **reconstruites après capture**, accompagnent l'input exporté et ses empreintes, et ne modifient pas l'observation d'origine. Un hash ne prouve pas la complétude on-chain. Les métriques mesurent une évolution depuis l'état enregistré, pas une reconstitution des gains historiques depuis financement.

Le warmup de l'actif non ciblé par l'observation provient du cache historique relu ultérieurement. Sa disponibilité et sa version à t0 ne sont pas attestées. Le replay est donc conditionnel aux prix historiques exportés, et ne reconstitue pas complètement la disponibilité des informations en live.

Un fichier facultatif `--cashflows <fichier.json>` applique les mêmes dépôts/retraits datés à toutes les branches :

```json
[{"id":"deposit-1","at":"2026-10-01T12:30:00Z","amountUsd":100}]
```

Les dépôts sont exclus du gain et du drawdown ajusté ; un retrait nécessite du cash libre. Seuls les cashflows déjà appliqués peuvent modifier la référence de capital : un dépôt futur n'affecte aucune décision antérieure. Cette entrée est un scénario explicite, pas une détection automatique des dépôts du wallet. BTC est évalué par rétention de BTC et valeur de tout l'inventaire ; SOL par USDC nets et valeur totale. Le cash libre et le capital immobilisé restent visibles.

Le replay teste **une intervention Jev**, suivie de la policy déterministe dans les branches adaptatives. Il ne simule pas encore un expert Jev pilotant en continu les états alternatifs. Les chemins intrabougie, quotes et fills sont modélisés ; les fenêtres se chevauchent. Il faut collecter des horizons complets et des régimes différents avant de conclure à une amélioration ou de promouvoir une décision en live.

## Exploitation

Service de collecte : `docker compose --env-file .env.production -f docker-compose.prod.yml --profile shadow up -d shadow-data`.

Capture et Jev : `docker compose --env-file .env.production -f docker-compose.prod.yml --profile shadow up -d shadow-capture shadow-jev`.

Le worker et `shadow-capture` doivent monter le même volume persistant. En local, le chemin par défaut est `.shadow-capture-spool/` (ignoré Git) ; `SHADOW_CAPTURE_SPOOL_DIR` permet de le remplacer. Sans consommateur, les fichiers restent en attente. Le healthcheck capture contrôle le PID et la fraîcheur du lease. Les logs exposent le nombre de fichiers en attente, complétés, échoués, récupérés ou invalides, sans leur contenu.

La table additive `shadow_quote_comparisons` conserve les comparaisons immuables. Aucun paramètre live n'est ajusté à partir des profils ou des réponses Jev. Une nouvelle version doit accompagner tout changement des questions, du générateur, des règles économiques ou des hypothèses d'évaluation.
