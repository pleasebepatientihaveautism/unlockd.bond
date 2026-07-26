import "dotenv/config";
import { createRuntime } from "./runtime.js";

const { app, config, logger, pool } = createRuntime();
const server = app.listen(config.PORT, () => {
  logger.info({ port: config.PORT, mode: config.mode }, "unlockd.bond listening");
});

async function shutdown(signal: string) {
  logger.info({ signal }, "shutting down");
  server.close(async () => {
    await pool?.end();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
