CREATE TYPE "ShadowJevOutboxStatus" AS ENUM ('pending', 'processing', 'completed', 'failed');
CREATE TYPE "ShadowEngineOutcomeStatus" AS ENUM ('applied', 'wait', 'rejected');
CREATE TYPE "ShadowJevAttemptStatus" AS ENUM ('completed', 'failed');

CREATE TABLE "shadow_market_snapshots" (
    "id" TEXT NOT NULL,
    "content_hash" TEXT NOT NULL,
    "candle_count" INTEGER NOT NULL,
    "candles" JSONB NOT NULL,
    "provenance" JSONB NOT NULL,
    "observed_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "shadow_market_snapshots_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "shadow_market_snapshots_candles_check"
      CHECK (jsonb_typeof("candles") = 'array' AND jsonb_array_length("candles") = "candle_count" AND "candle_count" > 0)
);

CREATE TABLE "shadow_jev_observations" (
    "id" TEXT NOT NULL,
    "portfolio_id" TEXT NOT NULL,
    "strategy_id" TEXT NOT NULL,
    "band_id" TEXT NOT NULL,
    "bot_id" TEXT NOT NULL,
    "snapshot_id" TEXT NOT NULL,
    "observed_at" TIMESTAMP(3) NOT NULL,
    "question_set_version" TEXT NOT NULL,
    "model_requested" TEXT NOT NULL,
    "observation_hash" TEXT NOT NULL,
    "policy_input" JSONB NOT NULL,
    "context" JSONB NOT NULL,
    "bot_state" JSONB NOT NULL,
    "market_meta" JSONB NOT NULL,
    "proposed_decision" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "shadow_jev_observations_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "shadow_engine_outcomes" (
    "id" TEXT NOT NULL,
    "observation_id" TEXT NOT NULL,
    "status" "ShadowEngineOutcomeStatus" NOT NULL,
    "effective_decision" JSONB,
    "error_code" TEXT,
    "error_message" TEXT,
    "error_details" JSONB,
    "outcome_hash" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "shadow_engine_outcomes_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "shadow_jev_outbox" (
    "id" TEXT NOT NULL,
    "observation_id" TEXT NOT NULL,
    "portfolio_id" TEXT NOT NULL,
    "band_id" TEXT NOT NULL,
    "observed_at" TIMESTAMP(3) NOT NULL,
    "question_set_version" TEXT NOT NULL,
    "status" "ShadowJevOutboxStatus" NOT NULL DEFAULT 'pending',
    "terminal" BOOLEAN NOT NULL DEFAULT false,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "available_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimed_at" TIMESTAMP(3),
    "lease_expires_at" TIMESTAMP(3),
    "claimed_by" TEXT,
    "raw_request" JSONB,
    "raw_response" JSONB,
    "probabilities" JSONB,
    "model_version" TEXT,
    "latency_ms" INTEGER,
    "error_code" TEXT,
    "error_message" TEXT,
    "error_details" JSONB,
    "completed_at" TIMESTAMP(3),
    "failed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "shadow_jev_outbox_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "shadow_jev_outbox_attempt_count_check" CHECK ("attempt_count" >= 0),
    CONSTRAINT "shadow_jev_outbox_latency_check" CHECK ("latency_ms" IS NULL OR "latency_ms" >= 0),
    CONSTRAINT "shadow_jev_outbox_state_check" CHECK (
      ("status" = 'pending' AND "terminal" = false AND "claimed_by" IS NULL AND "lease_expires_at" IS NULL AND "claimed_at" IS NULL)
      OR ("status" = 'processing' AND "terminal" = false AND "claimed_by" IS NOT NULL AND "lease_expires_at" IS NOT NULL
          AND "claimed_at" IS NOT NULL)
      OR ("status" = 'completed' AND "terminal" = true AND "claimed_by" IS NULL AND "lease_expires_at" IS NULL
          AND "completed_at" IS NOT NULL AND "model_version" IS NOT NULL)
      OR ("status" = 'failed' AND "claimed_by" IS NULL AND "lease_expires_at" IS NULL AND "failed_at" IS NOT NULL
          AND "error_message" IS NOT NULL)
    )
);

CREATE TABLE "shadow_jev_attempts" (
    "id" TEXT NOT NULL,
    "outbox_id" TEXT NOT NULL,
    "attempt_number" INTEGER NOT NULL,
    "worker_id" TEXT NOT NULL,
    "status" "ShadowJevAttemptStatus" NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL,
    "finished_at" TIMESTAMP(3) NOT NULL,
    "raw_request" JSONB,
    "raw_response" JSONB,
    "probabilities" JSONB,
    "model_version" TEXT,
    "latency_ms" INTEGER,
    "error_code" TEXT,
    "error_message" TEXT,
    "error_details" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "shadow_jev_attempts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "shadow_jev_attempts_number_check" CHECK ("attempt_number" > 0),
    CONSTRAINT "shadow_jev_attempts_latency_check" CHECK ("latency_ms" IS NULL OR "latency_ms" >= 0),
    CONSTRAINT "shadow_jev_attempts_time_check" CHECK ("finished_at" >= "started_at"),
    CONSTRAINT "shadow_jev_attempts_error_check" CHECK ("status" <> 'failed' OR "error_message" IS NOT NULL)
);

CREATE UNIQUE INDEX "shadow_market_snapshots_content_hash_key" ON "shadow_market_snapshots"("content_hash");
CREATE UNIQUE INDEX "shadow_jev_observations_observation_hash_key" ON "shadow_jev_observations"("observation_hash");
CREATE INDEX "shadow_jev_observations_portfolio_id_band_id_observed_at_question_set_version_idx"
  ON "shadow_jev_observations"("portfolio_id", "band_id", "observed_at", "question_set_version");
CREATE INDEX "shadow_jev_observations_snapshot_id_idx" ON "shadow_jev_observations"("snapshot_id");
CREATE INDEX "shadow_jev_observations_bot_id_observed_at_idx" ON "shadow_jev_observations"("bot_id", "observed_at" DESC);
CREATE UNIQUE INDEX "shadow_engine_outcomes_observation_id_key" ON "shadow_engine_outcomes"("observation_id");
CREATE UNIQUE INDEX "shadow_jev_outbox_observation_id_key" ON "shadow_jev_outbox"("observation_id");
CREATE INDEX "shadow_jev_outbox_portfolio_id_band_id_observed_at_question_set_version_idx"
  ON "shadow_jev_outbox"("portfolio_id", "band_id", "observed_at", "question_set_version");
CREATE INDEX "shadow_jev_outbox_status_available_at_idx" ON "shadow_jev_outbox"("status", "available_at");
CREATE INDEX "shadow_jev_outbox_status_lease_expires_at_idx" ON "shadow_jev_outbox"("status", "lease_expires_at");
CREATE UNIQUE INDEX "shadow_jev_attempts_outbox_id_attempt_number_key" ON "shadow_jev_attempts"("outbox_id", "attempt_number");
CREATE INDEX "shadow_jev_attempts_outbox_id_finished_at_idx" ON "shadow_jev_attempts"("outbox_id", "finished_at");

ALTER TABLE "shadow_jev_observations" ADD CONSTRAINT "shadow_jev_observations_snapshot_id_fkey"
  FOREIGN KEY ("snapshot_id") REFERENCES "shadow_market_snapshots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "shadow_jev_observations" ADD CONSTRAINT "shadow_jev_observations_portfolio_id_fkey"
  FOREIGN KEY ("portfolio_id") REFERENCES "portfolios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "shadow_jev_observations" ADD CONSTRAINT "shadow_jev_observations_strategy_id_fkey"
  FOREIGN KEY ("strategy_id") REFERENCES "asset_strategies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "shadow_jev_observations" ADD CONSTRAINT "shadow_jev_observations_band_id_fkey"
  FOREIGN KEY ("band_id") REFERENCES "grid_bands"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "shadow_jev_observations" ADD CONSTRAINT "shadow_jev_observations_bot_id_fkey"
  FOREIGN KEY ("bot_id") REFERENCES "bots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "shadow_engine_outcomes" ADD CONSTRAINT "shadow_engine_outcomes_observation_id_fkey"
  FOREIGN KEY ("observation_id") REFERENCES "shadow_jev_observations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "shadow_jev_outbox" ADD CONSTRAINT "shadow_jev_outbox_observation_id_fkey"
  FOREIGN KEY ("observation_id") REFERENCES "shadow_jev_observations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "shadow_jev_attempts" ADD CONSTRAINT "shadow_jev_attempts_outbox_id_fkey"
  FOREIGN KEY ("outbox_id") REFERENCES "shadow_jev_outbox"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION reject_shadow_immutable_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is immutable', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER shadow_market_snapshots_immutable
  BEFORE UPDATE OR DELETE ON "shadow_market_snapshots"
  FOR EACH ROW EXECUTE FUNCTION reject_shadow_immutable_change();
CREATE TRIGGER shadow_jev_observations_immutable
  BEFORE UPDATE OR DELETE ON "shadow_jev_observations"
  FOR EACH ROW EXECUTE FUNCTION reject_shadow_immutable_change();
CREATE TRIGGER shadow_engine_outcomes_immutable
  BEFORE UPDATE OR DELETE ON "shadow_engine_outcomes"
  FOR EACH ROW EXECUTE FUNCTION reject_shadow_immutable_change();
CREATE TRIGGER shadow_jev_attempts_immutable
  BEFORE UPDATE OR DELETE ON "shadow_jev_attempts"
  FOR EACH ROW EXECUTE FUNCTION reject_shadow_immutable_change();

CREATE FUNCTION protect_shadow_outbox_terminal() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD."status" = 'completed' OR OLD."terminal" = true THEN
    RAISE EXCEPTION 'terminal shadow_jev_outbox row is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER shadow_jev_outbox_terminal_immutable
  BEFORE UPDATE OR DELETE ON "shadow_jev_outbox"
  FOR EACH ROW EXECUTE FUNCTION protect_shadow_outbox_terminal();
