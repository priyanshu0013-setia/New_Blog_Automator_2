import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import rateLimit from "express-rate-limit";
import path from "node:path";
import fs from "node:fs";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests — please slow down and try again in a minute." },
});

const generateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many article generation requests — maximum 5 per minute." },
});

app.use("/api", apiLimiter);
app.use("/api/articles", generateLimiter);
app.use("/api", router);

// Resolve the directory that contains the built React app.
// __dirname is injected by the esbuild banner and always points to the
// directory of the running server binary (artifacts/api-server/dist/).
// Going two levels up from there reaches the repo root, so the frontend
// dist is at: artifacts/api-server/dist/../../blog-automation/dist/public
//   → <repo-root>/artifacts/blog-automation/dist/public
// This is robust regardless of the working directory Render uses to start
// the server. Override by setting the STATIC_FILES_PATH env variable.
const staticFilesPath =
  process.env["STATIC_FILES_PATH"] ??
  path.join(__dirname, "../../blog-automation/dist/public");

if (fs.existsSync(staticFilesPath)) {
  app.use(express.static(staticFilesPath));

  // Return a JSON 404 for unmatched /api/* routes so they don't fall through
  // to the SPA catch-all below.
  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  // SPA catch-all: return index.html for every non-API route so that
  // client-side routing (wouter / react-router) works on direct URL loads.
  app.get("/{*splat}", (_req, res) => {
    res.sendFile(path.join(staticFilesPath, "index.html"));
  });
} else {
  logger.warn(
    { staticFilesPath },
    "Frontend static files not found — serving API only. Run the frontend build first.",
  );

  app.get("/", (_req, res) => {
    res.json({ status: "ok", message: "Blog Automator API is running. Use /api/healthz to check health." });
  });
}

export default app;
