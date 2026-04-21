ALTER TABLE "bots" ADD COLUMN "archived_at" TIMESTAMP(3);

CREATE INDEX "bots_mode_archived_at_idx" ON "bots"("mode", "archived_at");
