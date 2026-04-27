import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    [
      "DATABASE_URL must be set. The API server cannot start without a PostgreSQL connection.",
      "If you are deploying on Render:",
      "1) Provision or link a Render Postgres database to this web service.",
      "2) Confirm DATABASE_URL is present in the service Environment settings.",
      "3) Redeploy so the Render build command can run schema push automatically.",
    ].join("\n"),
  );
}

export const pool = new Pool({ connectionString: process.env.DATABASE_URL });
export const db = drizzle(pool, { schema });

export * from "./schema";
