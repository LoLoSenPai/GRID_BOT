# Jev shadow V3 — choix de configurations et évaluation causale

## Périmètre

La V3 reste exclusivement shadow. `PortfolioManagerService` et `BotEngineService` n'utilisent aucune réponse Jev. La capture est planifiée après le cycle normal, sur le client de base séparé ; toute erreur de génération, lecture, snapshot ou outbox est journalisée sans faire échouer le cycle. Le consommateur Jev est un processus séparé.

Le modèle demandé reste `jev-1.13.0`. Le jeu de questions est `shadow-jev-v3` et le générateur est `shadow-grid-candidates-v3`. Les jobs V1/V2 gardent leurs questions d'origine. Toute modification ultérieure des questions, du modèle, des règles de génération ou de l'horizon impose une nouvelle version.

## Candidats et observation

Le moteur génère au plus six choix : la grille courante (`keep`), sa propre proposition si applicable, puis des configurations déterministes distinctes fondées sur un canal de prix robuste, un décalage EMA20/EMA50 et une densité de paliers adaptée à l'ATR et au coût estimé. Il calcule toutes les valeurs à partir des bougies déjà clôturées. Les contrôles existants de capital, exposition, spacing, prix dans le range et engagements des lots filtrent les nouvelles configurations. Les rejets et leurs motifs sont conservés. `keep` reste la référence même si son ouverture aujourd'hui ne passerait pas les nouveaux seuils économiques.

La question Jev reçoit une projection courte des 24 dernières bougies clôturées, de l'état lu par le manager et des configurations admissibles avec famille et paramètres explicites. Elle distingue l'heure de clôture (`observed_at`) de l'heure réelle de lecture du portefeuille (`state_read_at`). Les options sont mélangées de façon déterministe et portent des identifiants neutres. Jev choisit une option ou `abstain`. La réponse complète, la distribution des probabilités, le modèle résolu, la latence et les erreurs restent dans l'outbox. Une probabilité de choix n'est pas une probabilité de gain.

L'observation immuable conserve l'entrée de la policy, le candidat complet, la décision du moteur et un snapshot de marché partagé. Elle conserve aussi l'état de la band et de ses pairs du même actif **avant** la décision (`context.shadowPreDecision`). La V3 ajoute un snapshot du portefeuille complet dans `context.shadowReplayV3`, lu sous une même vue transactionnelle (`REPEATABLE READ`) : capital, stratégies BTC/SOL, bands, bots, révisions, lots, engagements de sortie, réservations et tentatives d'exécution. Il inclut l'heure réelle de capture ; l'identité du wallet et les charges d'exécution potentiellement sensibles sont exclues. La lecture a lieu après le cycle normal, donc son état peut être postérieur à la clôture qui a déclenché l'observation.

## Comparaison hors ligne

Le replay peut amorcer plusieurs bands du même actif sur un seul flux de bougies par actif. Il conserve les cibles et règles économiques des lots déjà ouverts, et accepte une intervention unique au début de la fenêtre : `keep`, décision de la policy ou candidat Jev. Chaque branche applique ensuite la policy déterministe sur son propre état. Les mêmes bougies, capital et coûts sont utilisés dans les trois branches ; les chemins intrabougie restent synthétiques.

L'évaluateur doit refuser explicitement les états non réconciliés, les engagements de sortie inconnus, les réservations ou tentatives en cours, les sources de marché incohérentes et les horizons futurs incomplets. Il ne doit pas transformer silencieusement un snapshot capturé après la clôture en état disponible à cette clôture. Les résultats exploratoires comparent à +1 h, +3 h, +6 h et +24 h l'équité totale, le cash, l'inventaire, les frais et les cycles ; pour BTC, aussi le BTC retenu et l'équité exprimée en BTC ; pour SOL, les USDC réalisés nets et l'équité totale. `abstain` revient à la policy. Les fenêtres horaires se chevauchent et ne forment pas des essais indépendants.

Ce replay mesure une hypothèse conditionnelle sur des données publiques et des frais simulés. Il ne garantit ni les quotes, ni les fills Jupiter, ni une amélioration future. Les paramètres et familles doivent être figés avant un échantillon futur réservé à la validation. Aucune promotion live ne découle automatiquement d'un résultat shadow.

### Rejeu d'une observation

Le runner V3 lit une observation terminée et les bougies BTC/SOL déjà présentes dans le cache de la base, sans requête réseau ni écriture :

```bash
pnpm --filter @grid-bot/worker shadow:replay:v3 -- --observation-id <id> --native-fee-usd <estimation-par-swap>
```

Le coût natif par swap doit être une estimation positive et explicite ; il est inscrit dans la provenance du résultat. La sortie JSON donne, pour chaque horizon, les trois branches ou un motif de censure. Le runner contrôle le provider, le pool, les mints configurés, les heures et la continuité des bougies. La table de cache n'atteste pas elle-même le mint réellement négocié par le pool, et aucune estimation de frais ne remplace les frais on-chain observés.
