ALTER TABLE "bots"
ADD COLUMN "cloned_from_bot_id" TEXT;

CREATE INDEX "bots_cloned_from_bot_id_idx" ON "bots"("cloned_from_bot_id");

UPDATE "bots"
SET
  "mode" = 'paper',
  "status" = 'paused',
  "executionProvider" = 'paper';
