import app from "./app";
import { logger } from "./lib/logger";

const rawPort = process.env["PORT"];
const host = process.env["HOST"] ?? "0.0.0.0";
if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, host, (err) => {
  if (err) {
    logger.error({ err, port, host }, "Error listening on server");
    process.exit(1);
  }

  logger.info({ port, host }, "Server listening");
});
