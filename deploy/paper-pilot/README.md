# VPS paper pilot

This Compose stack runs the existing SOL paper observer for 24 hours in its
own disposable PostgreSQL database. It never starts the live worker, mounts a
wallet, publishes PostgreSQL, or connects to the production Compose network.
The observer reads Jupiter Price V3 and creates synthetic paper fills.

The image contains the reviewed configuration at
`/app/config/sol-paper-pilot-config.json`, copied from the selected
`deploy/paper-pilot/config.json`. The configuration is fixed for this run;
changing it requires an explicit review and image rebuild.

## VPS preparation

Create the external environment file with exactly the runtime API key:

```sh
install -d -m 700 /opt/grid-bot/paper-pilot/secrets
install -m 600 /dev/null /opt/grid-bot/paper-pilot/secrets/jupiter.env
read -r -s -p 'Jupiter API key: ' JUPITER_API_KEY
printf '\n'
printf 'JUPITER_API_KEY=%s\n' "$JUPITER_API_KEY" > /opt/grid-bot/paper-pilot/secrets/jupiter.env
unset JUPITER_API_KEY
install -d -m 750 /opt/grid-bot/paper-pilot/data/observation-20260910
```

Do not commit that file or put the key in the Compose file, image, shell
history, or a production `.env` file. The default path can be overridden with
`PAPER_PILOT_ENV_FILE`; the output bind path can be overridden with
`PAPER_PILOT_OUTPUT_DIR`.

## Start and inspect

From the repository root on the VPS:

```sh
docker compose -f deploy/paper-pilot/compose.yml build paper-pilot
docker compose -f deploy/paper-pilot/compose.yml up -d paper-db paper-pilot
docker compose -f deploy/paper-pilot/compose.yml ps
docker compose -f deploy/paper-pilot/compose.yml logs -f paper-pilot
```

The runner receives `5432`, which is loopback inside the shared `paper-db`
network namespace. The script requires a fresh database and applies every
checked-in Prisma migration itself. Keep the dedicated `paper_pilot_db`
volume for inspection while the run is active. A rerun against that volume is
intentionally refused once migrations have been applied; use a separately
reviewed fresh volume for a new observation window.

Results are written to
`/opt/grid-bot/paper-pilot/data/observation-20260910` by default:
`status.json`, `price-observations.jsonl`, and `portfolio-snapshots.jsonl`.
The 24-hour process has no resume semantics; after a VPS outage, start a new
fresh observation and retain the prior output directory separately.

## Validation without starting the pilot

```sh
docker compose -f deploy/paper-pilot/compose.yml config --quiet
docker compose -f deploy/paper-pilot/compose.yml build paper-pilot
```

`docker compose config` needs the external env file to exist. The 4 GB VPS
profile leaves limited memory during a TypeScript/Prisma build, so build before
starting the 24-hour service and watch `docker stats` during the first run.
