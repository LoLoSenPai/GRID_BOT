CREATE TYPE "EntryMode" AS ENUM ('normal', 'sell_only');

ALTER TABLE "bot_configs"
  ADD COLUMN "entry_mode" "EntryMode" NOT NULL DEFAULT 'normal';
