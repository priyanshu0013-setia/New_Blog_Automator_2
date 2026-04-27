# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 22+
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.

## Artifacts

### Blog Automation (`artifacts/blog-automation`)
A full-stack blog article production pipeline automation tool.

**Purpose**: Automates a 7-step blog production pipeline for a small team (2-3 users), supporting up to 3 concurrent articles.

**Pipeline Steps**:
1. Input (single or CSV batch upload)
2. Deep Research (Claude AI)
3. Dynamic Prompt generation
4. Write Article
5. Humanization Pass (em-dash removal, sentence variation)
6. Quality Checks: keyword density (1.3-1.7%), em-dash count (0), FAQ count (5-8), Copyleaks AI detection (≤10%)
7. Section-level Retry (max 3x)
8. SEO Metadata generation
9. Google Docs delivery

**Frontend Pages**:
- `/` — Dashboard (stats + active pipeline cards)
- `/new` — New Article (single form or batch CSV upload, max 3)
- `/status` — Pipeline Status (real-time polling, expandable logs)
- `/history` — Article History (filterable table with quality metrics)
- `/article/:id` — Article Detail (content/SEO/logs tabs + quality scorecards)

**Article Statuses**: queued → researching → writing → humanizing → checking → retrying → formatting → completed | failed | flagged

**Quality Thresholds**:
- Copyleaks AI score: must be < 10%
- Primary keyword density: 1.3–1.7%
- Em dash count: must be 0
- FAQ count: 5–8

**API Keys Required for Full Operation**:
- `ANTHROPIC_API_KEY` — for Claude research + writing (pipeline fails gracefully without it)
- `COPYLEAKS_EMAIL` + `COPYLEAKS_API_KEY` — optional, skipped if missing
- `GOOGLE_SERVICE_ACCOUNT_JSON` — optional, paste the full contents of your Google service account key JSON file as a single-line string. Required scopes: `documents` + `drive.file`
- `GOOGLE_DRIVE_FOLDER_ID` — optional, the Drive folder ID to place published docs into (share the folder with the service account email)

**Google Docs Setup**:
1. Create a Google Cloud project and enable the Google Docs API and Google Drive API
2. Create a service account and download its JSON key file
3. Set `GOOGLE_SERVICE_ACCOUNT_JSON` = the full JSON content (as a string)
4. Optional: create a Drive folder, share it with the service account email, copy the folder ID from the URL into `GOOGLE_DRIVE_FOLDER_ID`

### API Server (`artifacts/api-server`)
Express 5 REST API serving the blog automation frontend.

**Routes**:
- `GET/POST /api/articles` — list + create articles
- `POST /api/articles/batch` — batch create (max 3)
- `GET/DELETE /api/articles/:id` — get + delete
- `POST /api/articles/:id/retry` — retry failed/flagged
- `GET /api/articles/:id/logs` — pipeline logs
- `GET /api/stats/dashboard` — dashboard stats
- `GET /api/stats/active` — active pipeline articles

**Key Files**:
- `artifacts/api-server/src/lib/pipeline.ts` — pipeline orchestrator
- `artifacts/api-server/src/routes/articles.ts` — all routes
- `lib/db/src/schema/articles.ts` — articles table
- `lib/db/src/schema/pipeline-logs.ts` — logs table
- `lib/api-spec/openapi.yaml` — OpenAPI contract

## Render Deployment Checklist

1. Use the same commands defined in `render.yaml`:
   - Build: `pnpm install && pnpm --filter @workspace/db run push && pnpm -r --if-present run build`
   - Start: `node --enable-source-maps ./artifacts/api-server/dist/index.mjs`
2. Do not set `PORT` manually on Render (Render injects it automatically).
3. Ensure `DATABASE_URL` is present by linking a Render Postgres database to the web service.
4. DB schema push runs automatically during the Render build command.
5. Verify endpoints:
   - `GET /api/healthz`
   - `GET /`

## Render Runtime Failure Triage

If build succeeds but deploy exits immediately after start:

1. Open Render deploy logs and find the first thrown error after:
   - `node --enable-source-maps artifacts/api-server/dist/index.mjs`
2. If you see `DATABASE_URL must be set`, link/provision Postgres and redeploy.
3. If it still fails, copy the stack trace and check the referenced module for missing runtime environment or external API credentials.
