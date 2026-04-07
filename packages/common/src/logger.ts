import pino from "pino";

import { getEnv } from "./env";

const env = getEnv();

export const logger = pino({
  level: env.NODE_ENV === "development" ? "debug" : "info"
});
