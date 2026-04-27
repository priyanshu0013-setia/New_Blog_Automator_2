import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { articlesTable, pipelineLogsTable } from "@workspace/db";
import { eq, desc, sql, and, gte } from "drizzle-orm";
import {
  CreateArticleBody,
  ListArticlesQueryParams,
  GetArticleParams,
  DeleteArticleParams,
  RetryArticleParams,
  GetArticleLogsParams,
  CreateArticlesBatchBody,
} from "@workspace/api-zod";
import { runPipeline } from "../lib/pipeline";
import { logger } from "../lib/logger";

const router: IRouter = Router();

router.get("/articles", async (req, res): Promise<void> => {
  const query = ListArticlesQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  const { status, limit = 50, offset = 0 } = query.data;
  let q = db.select().from(articlesTable).orderBy(desc(articlesTable.createdAt));
  const articles = status
    ? await db.select().from(articlesTable).where(eq(articlesTable.status, status)).orderBy(desc(articlesTable.createdAt)).limit(limit).offset(offset)
    : await db.select().from(articlesTable).orderBy(desc(articlesTable.createdAt)).limit(limit).offset(offset);

  void q;
  res.json(articles);
});

const MAX_CONCURRENT_ARTICLES = 3;

async function getActivePipelineCount(): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(articlesTable)
    .where(
      sql`status in ('queued','researching','writing','humanizing','checking','retrying','formatting')`,
    );
  return row?.count ?? 0;
}

router.post("/articles", async (req, res): Promise<void> => {
  const parsed = CreateArticleBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const activeCount = await getActivePipelineCount();
  if (activeCount >= MAX_CONCURRENT_ARTICLES) {
    res.status(429).json({
      error: `Maximum ${MAX_CONCURRENT_ARTICLES} articles can run concurrently. Please wait for a current article to finish before starting a new one.`,
    });
    return;
  }
  const data = parsed.data;
  const [article] = await db.insert(articlesTable).values({
    topic: data.topic,
    primaryKeyword: data.primaryKeyword,
    secondaryKeywords: data.secondaryKeywords ?? null,
    targetAudience: data.targetAudience ?? null,
    tone: data.tone ?? null,
    referenceInput: data.referenceInput ?? null,
    wordCountTarget: data.wordCountTarget,
    createdBy: data.createdBy ?? null,
    status: "queued",
    retryCount: 0,
  }).returning();

  req.log.info({ articleId: article.id }, "Article created, starting pipeline");

  setImmediate(() => {
    runPipeline(article.id).catch((err) => {
      logger.error({ err, articleId: article.id }, "Pipeline execution error");
    });
  });

  res.status(201).json(article);
});

router.post("/articles/batch", async (req, res): Promise<void> => {
  const parsed = CreateArticlesBatchBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const articles = parsed.data.articles;
  if (articles.length > 3) {
    res.status(400).json({ error: "Batch upload supports a maximum of 3 articles at a time" });
    return;
  }
  const activeCount = await getActivePipelineCount();
  const slots = MAX_CONCURRENT_ARTICLES - activeCount;
  if (slots <= 0) {
    res.status(429).json({
      error: `Maximum ${MAX_CONCURRENT_ARTICLES} articles can run concurrently. Please wait for a current article to finish.`,
    });
    return;
  }
  if (articles.length > slots) {
    res.status(429).json({
      error: `Only ${slots} pipeline slot(s) available. Reduce batch size or wait for running articles to complete.`,
    });
    return;
  }
  const created = [];
  for (const data of articles) {
    const [article] = await db.insert(articlesTable).values({
      topic: data.topic,
      primaryKeyword: data.primaryKeyword,
      secondaryKeywords: data.secondaryKeywords ?? null,
      targetAudience: data.targetAudience ?? null,
      tone: data.tone ?? null,
      referenceInput: data.referenceInput ?? null,
      wordCountTarget: data.wordCountTarget,
      createdBy: data.createdBy ?? null,
      status: "queued",
      retryCount: 0,
    }).returning();
    created.push(article);
    setImmediate(() => {
      runPipeline(article.id).catch((err) => {
        logger.error({ err, articleId: article.id }, "Pipeline execution error");
      });
    });
  }
  res.status(201).json(created);
});

router.get("/articles/:id", async (req, res): Promise<void> => {
  const params = GetArticleParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [article] = await db.select().from(articlesTable).where(eq(articlesTable.id, params.data.id));
  if (!article) {
    res.status(404).json({ error: "Article not found" });
    return;
  }
  res.json(article);
});

router.delete("/articles/:id", async (req, res): Promise<void> => {
  const params = DeleteArticleParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [deleted] = await db.delete(articlesTable).where(eq(articlesTable.id, params.data.id)).returning();
  if (!deleted) {
    res.status(404).json({ error: "Article not found" });
    return;
  }
  res.sendStatus(204);
});

router.post("/articles/:id/retry", async (req, res): Promise<void> => {
  const params = RetryArticleParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [article] = await db.select().from(articlesTable).where(eq(articlesTable.id, params.data.id));
  if (!article) {
    res.status(404).json({ error: "Article not found" });
    return;
  }
  const [updated] = await db.update(articlesTable).set({ status: "queued", errorMessage: null }).where(eq(articlesTable.id, params.data.id)).returning();
  setImmediate(() => {
    runPipeline(params.data.id).catch((err) => {
      logger.error({ err, articleId: params.data.id }, "Retry pipeline error");
    });
  });
  res.json(updated);
});

router.post("/articles/:id/regenerate", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid article id" });
    return;
  }
  const [source] = await db.select().from(articlesTable).where(eq(articlesTable.id, id));
  if (!source) {
    res.status(404).json({ error: "Source article not found" });
    return;
  }
  const activeCount = await getActivePipelineCount();
  if (activeCount >= MAX_CONCURRENT_ARTICLES) {
    res.status(429).json({
      error: `Maximum ${MAX_CONCURRENT_ARTICLES} articles can run concurrently. Please wait for a current article to finish before regenerating.`,
    });
    return;
  }
  // Create a new article record copying the user inputs from the source.
  // We don't reuse the original record; the user wants a fresh attempt with
  // the same prompt configuration and a new pipeline run.
  const [newArticle] = await db.insert(articlesTable).values({
    topic: source.topic,
    primaryKeyword: source.primaryKeyword,
    secondaryKeywords: source.secondaryKeywords,
    targetAudience: source.targetAudience,
    tone: source.tone,
    referenceInput: source.referenceInput,
    wordCountTarget: source.wordCountTarget,
    createdBy: source.createdBy,
    status: "queued",
    retryCount: 0,
  }).returning();
  req.log.info({ sourceId: id, newId: newArticle.id }, "Article regenerated as new record");
  setImmediate(() => {
    runPipeline(newArticle.id).catch((err) => {
      logger.error({ err, articleId: newArticle.id }, "Regenerate pipeline error");
    });
  });
  res.status(201).json(newArticle);
});

router.get("/articles/:id/logs", async (req, res): Promise<void> => {
  const params = GetArticleLogsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const logs = await db.select().from(pipelineLogsTable).where(eq(pipelineLogsTable.articleId, params.data.id)).orderBy(pipelineLogsTable.createdAt);
  res.json(logs);
});

router.get("/stats/dashboard", async (_req, res): Promise<void> => {
  const [totals] = await db.select({
    total: sql<number>`count(*)::int`,
    completed: sql<number>`count(*) filter (where status = 'completed')::int`,
    failed: sql<number>`count(*) filter (where status = 'failed')::int`,
    active: sql<number>`count(*) filter (where status in ('queued','researching','writing','humanizing','checking','retrying','formatting'))::int`,
    avgZeroGptScore: sql<number>`avg(zero_gpt_score) filter (where zero_gpt_score is not null)`,
    avgDensity: sql<number>`avg(primary_keyword_density) filter (where primary_keyword_density is not null)`,
  }).from(articlesTable);

  const oneWeekAgo = new Date();
  oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);
  const [weekCount] = await db.select({
    count: sql<number>`count(*)::int`,
  }).from(articlesTable).where(gte(articlesTable.createdAt, oneWeekAgo));

  const total = totals.total ?? 0;
  const completed = totals.completed ?? 0;

  res.json({
    totalArticles: total,
    completedArticles: completed,
    failedArticles: totals.failed ?? 0,
    activeArticles: totals.active ?? 0,
    avgZeroGptScore: totals.avgZeroGptScore ? parseFloat(String(totals.avgZeroGptScore)) : null,
    avgPrimaryDensity: totals.avgDensity ? parseFloat(String(totals.avgDensity)) : null,
    successRate: total > 0 ? parseFloat(((completed / total) * 100).toFixed(1)) : null,
    articlesThisWeek: weekCount.count ?? 0,
  });
});

router.get("/stats/active", async (_req, res): Promise<void> => {
  const active = await db.select().from(articlesTable).where(
    sql`status in ('queued','researching','writing','humanizing','checking','retrying','formatting')`
  ).orderBy(desc(articlesTable.createdAt));
  res.json(active);
});

export default router;
