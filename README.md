# Grid Bot Platform

Plateforme solo de grid trading spot sur Solana, orientee desktop et construite pour piloter deux bots autonomes en V1:

- `SOL/USDC`
- `BTC/USDC`

La V1 couvre:

- execution spot via Jupiter
- architecture d'abstraction pour DFlow plus tard
- moteur de grid avec `accumulate_base`, `accumulate_usdc`, `balanced`
- `paper` et `live`
- dashboard admin Next.js
- worker Node dedie a l'automatisation
- stockage PostgreSQL + Prisma
- alertes internes + Discord webhook

## Architecture

Le monorepo est organise comme suit:

```text
.
|-- apps
|   |-- web
|   |   |-- src/app
|   |   |   |-- dashboard
|   |   |   |-- bots
|   |   |   |-- activity
|   |   |   |-- login
|   |   |   `-- api
|   |   |-- src/components
|   |   `-- src/lib
|   `-- worker
|       `-- src
|-- packages
|   |-- common
|   |   `-- src
|   |-- core
|   |   |-- src/adapters
|   |   |-- src/domain
|   |   |-- src/services
|   |   `-- src/__tests__
|   `-- db
|       |-- prisma
|       |   |-- migrations
|       |   |-- schema.prisma
|       |   `-- seed.ts
|       `-- src/repositories
|-- docker-compose.yml
|-- Dockerfile.web
|-- Dockerfile.worker
|-- .env.example
`-- README.md
```

### Couches metier

- `BotEngineService`: orchestration des ticks, transitions d'etat, journalisation, execution
- `GridStrategyService`: calcul des niveaux, detection des crossings, construction des intents d'ordre
- `RiskManagerService`: cooldown, locks, drawdown, max orders/hour, failures, garde-fous infra
- `MarketPriceService`: prix de reference Pyth pour les triggers et la surveillance
- `ExecutionService`: selection d'adapter selon `paper` vs `live`
- `AlertService`: persistence des alertes et dispatch Discord

### Adapters d'execution

- `ExecutionAdapter`: contrat commun
- `JupiterExecutionAdapter`: provider spot principal V1
- `PaperExecutionAdapter`: simulation complete
- `DflowAdapter`: stub pret a brancher pour V2

## Stack

- Next.js App Router
- TypeScript
- Tailwind CSS
- PostgreSQL 17
- Prisma 7
- Node.js worker en TypeScript
- `lightweight-charts` pour le detail bot

## Source de prix et execution

- Prix de reference: Pyth Hermes
- Swaps spot: Jupiter REST API
- Wallet hot: reserve au worker

Important:

- `LIVE_TRADING_ENABLED=false` par defaut
- le web ne signe rien
- le worker est le seul process autorise a utiliser le wallet hot

## Schema de donnees

Le schema Prisma couvre:

- `bots`
- `bot_configs`
- `bot_state_snapshots`
- `orders`
- `executions`
- `positions`
- `position_lots`
- `inventory_snapshots`
- `pnl_snapshots`
- `alerts`
- `system_logs`
- `price_snapshots`

Migration initiale:

- [`packages/db/prisma/migrations/20260401233209_init/migration.sql`](/E:/CODE/PERSO/GRID_BOT/packages/db/prisma/migrations/20260401233209_init/migration.sql)

Schema:

- [`packages/db/prisma/schema.prisma`](/E:/CODE/PERSO/GRID_BOT/packages/db/prisma/schema.prisma)

## Bots seedes

Le seed cree deux bots paper:

1. `sol-usdc-paper`
   - strategie `balanced`
   - grille `arithmetic`
   - budget `2000`
   - deployable `1500`
   - reserve `500`
   - range `105 -> 165`
   - `14` niveaux
   - ordre minimum `50 USDC`

2. `btc-usdc-paper`
   - strategie `accumulate_usdc`
   - grille `geometric`
   - budget `2000`
   - deployable `1500`
   - reserve `500`
   - range `56000 -> 76000`
   - `12` niveaux
   - ordre minimum `50 USDC`

Seed:

- [`packages/db/prisma/seed.ts`](/E:/CODE/PERSO/GRID_BOT/packages/db/prisma/seed.ts)

## Pages du dashboard

- `/login`: auth admin simple
- `/dashboard`: equity, pnl, bots actifs, alertes, derniers trades
- `/bots`: cartes de pilotage et actions pause/resume/stop
- `/bots/[id]`: chart prix + niveaux, trades, inventaire, pnl, logs, runtime
- `/activity`: alertes, logs systeme, executions

## Variables d'environnement

Copier d'abord `.env.example` vers `.env`.

Fichier exemple:

- [`.env.example`](/E:/CODE/PERSO/GRID_BOT/.env.example)

Variables principales:

| Variable | Usage |
|---|---|
| `DATABASE_URL` | connexion PostgreSQL |
| `ADMIN_USERNAME` | login admin V1 |
| `ADMIN_PASSWORD` | mot de passe admin V1 |
| `SESSION_SECRET` | signature du cookie de session |
| `LIVE_TRADING_ENABLED` | coupe-circuit global du live |
| `RPC_HTTP_URL` | RPC Solana HTTP |
| `RPC_WS_URL` | RPC Solana WebSocket |
| `JUPITER_API_KEY` | cle API Jupiter |
| `PYTH_HERMES_BASE_URL` | endpoint Hermes Pyth |
| `EXECUTION_WALLET_SECRET_KEY_PATH` | chemin de la cle hot wallet, recommande |
| `EXECUTION_WALLET_SECRET_KEY_JSON` | fallback local seulement |
| `DISCORD_WEBHOOK_URL` | webhook alertes Discord |
| `BOT_TICK_INTERVAL_MS` | cadence du worker |
| `PRICE_STALE_AFTER_MS` | garde-fou sur fraicheur du prix |

## Execution locale

### 1. Installer les dependances

```bash
pnpm install
```

### 2. Demarrer PostgreSQL

```bash
docker compose up -d postgres
```

### 3. Generer Prisma

```bash
pnpm db:generate
```

### 4. Appliquer les migrations

```bash
pnpm db:deploy
```

En dev, vous pouvez aussi utiliser:

```bash
pnpm db:migrate
```

### 5. Seeder les bots

```bash
pnpm db:seed
```

### 6. Lancer le dashboard

```bash
pnpm dev:web
```

### 7. Lancer le worker

```bash
pnpm dev:worker
```

Acces local:

- dashboard: [http://localhost:3000](http://localhost:3000)
- login par defaut local: `admin / change-me`

## Build et tests

Build monorepo:

```bash
pnpm build
```

Tests:

```bash
pnpm test
```

Lint/typecheck:

```bash
pnpm lint
```

## Strategie de test

Couverture actuelle:

- calcul des niveaux arithmetic/geometric
- construction d'intents d'ordre
- garde-fous du `RiskManagerService`
- `PaperExecutionAdapter`
- selection d'adapter dans `ExecutionService`
- transitions critiques du `BotEngineService`
  - `cooldown -> running`
  - `running -> out_of_range`
  - execution simulee -> `cooldown`

Tests principaux:

- [`packages/core/src/__tests__/grid-strategy-service.test.ts`](/E:/CODE/PERSO/GRID_BOT/packages/core/src/__tests__/grid-strategy-service.test.ts)
- [`packages/core/src/__tests__/risk-manager-service.test.ts`](/E:/CODE/PERSO/GRID_BOT/packages/core/src/__tests__/risk-manager-service.test.ts)
- [`packages/core/src/__tests__/paper-execution-adapter.test.ts`](/E:/CODE/PERSO/GRID_BOT/packages/core/src/__tests__/paper-execution-adapter.test.ts)
- [`packages/core/src/__tests__/execution-service.test.ts`](/E:/CODE/PERSO/GRID_BOT/packages/core/src/__tests__/execution-service.test.ts)
- [`packages/core/src/__tests__/bot-engine-service.test.ts`](/E:/CODE/PERSO/GRID_BOT/packages/core/src/__tests__/bot-engine-service.test.ts)

## Mode paper vs live

### Paper

- aucun swap on-chain
- meme pipeline de journalisation que le live
- rapports d'execution homogenes
- meme monitoring que les bots reels

### Live

Preconditions:

- `LIVE_TRADING_ENABLED=true`
- bot en mode `live`
- `JUPITER_API_KEY` configure
- wallet hot configure via `EXECUTION_WALLET_SECRET_KEY_PATH` ou `EXECUTION_WALLET_SECRET_KEY_JSON`

## Alerting

Alertes internes persistantes:

- pause
- out of range
- execution failed
- consecutive failures
- recenter performed
- budget reached
- drawdown threshold
- infrastructure degraded

Discord:

- configure via `DISCORD_WEBHOOK_URL`
- emission asynchrone apres persistence

## Limites connues V1

- produit solo seulement
- pas de mobile-first
- pas de perps
- `DflowAdapter` non branche en execution reelle
- recentrage auto present mais volontairement strict
- pas de streaming temps reel front; rafraichissement via polling
- un warning Turbopack subsiste autour du chargeur d'env partage, sans impact sur la build

## Fichiers centraux

- moteur: [`packages/core/src/services/bot-engine-service.ts`](/E:/CODE/PERSO/GRID_BOT/packages/core/src/services/bot-engine-service.ts)
- strategie: [`packages/core/src/services/grid-strategy-service.ts`](/E:/CODE/PERSO/GRID_BOT/packages/core/src/services/grid-strategy-service.ts)
- risque: [`packages/core/src/services/risk-manager-service.ts`](/E:/CODE/PERSO/GRID_BOT/packages/core/src/services/risk-manager-service.ts)
- execution Jupiter: [`packages/core/src/adapters/jupiter-execution-adapter.ts`](/E:/CODE/PERSO/GRID_BOT/packages/core/src/adapters/jupiter-execution-adapter.ts)
- execution paper: [`packages/core/src/adapters/paper-execution-adapter.ts`](/E:/CODE/PERSO/GRID_BOT/packages/core/src/adapters/paper-execution-adapter.ts)
- worker: [`apps/worker/src/main.ts`](/E:/CODE/PERSO/GRID_BOT/apps/worker/src/main.ts)
- dashboard data: [`apps/web/src/lib/data.ts`](/E:/CODE/PERSO/GRID_BOT/apps/web/src/lib/data.ts)
