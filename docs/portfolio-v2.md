# Adaptive portfolio paper pilot

The Portfolio page creates virtual BTC/SOL bands with equal initial allocations and an explicitly funded shared surplus. It never creates live bots. The manager also rejects automatic live adaptation even if a database flag is changed: paper validation and a reviewed live activation change are required first.

## Execution and capital

Each band keeps its existing bot engine. Immutable grid revisions control new entries; each acquired trading lot owns an immutable absolute exit commitment. Revisions clear unexecuted entry signals and establish a fresh observation baseline. Exits remain eligible outside the current envelope. Unknown targets or pending executions prevent unsafe changes. Prepared orders retain their original identity and payload through recovery.

Portfolio transactions lock the bot and portfolio, reserve cash before execution, and settle actual fills once. Reserved/unknown cash is unavailable to other bands. Existing lots and pending buys occupy price zones across revisions. Principal returns to the band; available net USDC profit enters the common pool; retained BTC stays separate. Paper closure returns only cash, preserves history and requires settled trading lots. Legacy reset/config endpoints reject V2 bands.

## Deterministic observations

The policy reuses Lab ATR/realized volatility and its conservative round-trip spacing floor. Hourly candles must be closed, contiguous and fresh. Three successive observations confirm movement, with a six-hour revision interval and at most three revisions per day. Width is bounded to 6–24%; order size is at least 25 USDC. These are exploratory defaults, not selected optimums. A lower band is considered only when the current band cannot fund useful entries below its range. Shared cash, less-funded-asset priority, band count and exposure caps are checked again atomically.

Paper defaults assume 10 bps execution fees and 50 bps slippage. They do not estimate current Jupiter execution or native SOL expenditure. A live pilot will also need an independently funded, reconciled SOL fee envelope. No arbitrary USDC percentage is held back.

## Evaluation

The 14-day comparison starts both alternatives with exactly the same total capital, including idle cash. Its initial grid uses a preceding 80-hour warmup. Policy parameters are fixed before evaluation; replay uses the same policy function as the manager. Historical OHLC paths and fills are synthetic, not transaction-level reproductions. Equity includes remaining inventory and retained BTC; retained fragments alone do not establish outperformance. The API returns exact public candle inputs and sources for reproducibility. A subsequent untouched paper window is needed before performance conclusions or live adaptation.

## Existing bots

`PrismaPortfolioRepository.adoptExistingBot` is an explicit migration operation. Supply reconciled attributable capital and available quote; never infer current wallet funds by summing historical bot budgets. It freezes targets from persisted cycles, flags unknown targets instead of inventing them, preserves retained lots and adopts archived bots as closed. No automatic live or historical-wallet migration runs on deployment, and no stopped bot is resumed.

## Checks

### Live preparation (read-only)

Authenticated `POST /api/portfolios/live-preflight` accepts `totalCapital`, `baseAllocation` (equal BTC/SOL amounts, minimum 100 USDC each), and an explicit positive `feeSol`. It reads the configured wallet and a repeatable database snapshot. It does not create bots, reserve funds, submit quotes/swaps, or enable adaptation. `activationAllowed` is always false; `capitalReady` only describes this short-lived capital observation.

USDC claims include existing live portfolio free cash and band cash once (reservations already belong to band cash), plus legacy bot cash including profits and paused/stopped bots. Invested token cost is not spendable USDC. Native SOL holdings owned by bots are excluded from the fee envelope; wrapped/native ambiguities and archived residual inventory require reconciliation. Unknown executions, missing accounting and invalid/stale observations block readiness. No USDC percentage reserve is introduced.

This endpoint prepares a **new cash-funded portfolio**, not conversion of a paper portfolio or reuse of historical budgets. A real activation still needs reviewed paper evidence, explicit funding, atomic wallet-wide reservation with the legacy allocation paths, live fee controls, and manager wiring. The existing live adaptation prohibition remains intact. A successful preflight is not a reservation and must never be used as one.

Core tests cover policy causality, revision baselines and exits outside moved/parked grids. PostgreSQL integration tests cover reservations, concurrent allocations, uncertain outcomes, immutable commitments, partial sells, restart accounting and paper closure. Run database integration tests only against an isolated migrated database using `V2_TEST_DATABASE_URL` (and `DATABASE_URL` for engine integration); never against a live wallet database.
