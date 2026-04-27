import { pgTable, text, serial, timestamp, integer, real, boolean, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const articlesTable = pgTable("articles", {
  id: serial("id").primaryKey(),
  title: text("title"),
  topic: text("topic").notNull(),
  primaryKeyword: text("primary_keyword").notNull(),
  secondaryKeywords: text("secondary_keywords"),
  targetAudience: text("target_audience"),
  tone: text("tone"),
  referenceInput: text("reference_input"),
  wordCountTarget: integer("word_count_target").notNull().default(1500),
  wordCountActual: integer("word_count_actual"),
  // True if the article shipped outside the ±200-word tolerance after retries.
  wordCountOutOfBand: boolean("word_count_out_of_band").notNull().default(false),
  status: text("status").notNull().default("queued"),
  // ZeroGPT AI-detection score (0-100). Populated by the ZeroGPT scoring step
  // after humanization. Null if ZeroGPT was not configured or scoring failed.
  zeroGptScore: real("zero_gpt_score"),
  // True if ZeroGPT humanization failed after retries and the pipeline
  // published the un-transformed Claude draft. Flag for the UI.
  humanizationFailed: boolean("humanization_failed").notNull().default(false),
  // Verified-source list collected during the source-gathering step. Stored as
  // JSON for UI display (so the user can see what the article was allowed to
  // cite). Each entry: { url, title, snippet, publishedDate, domain }.
  verifiedSources: jsonb("verified_sources"),
  // Number of citations the writing step produced that matched the verified
  // source list (citationCount = matched, not total).
  citationCount: integer("citation_count").notNull().default(0),
  // Number of citations that did NOT match the verified source list and were
  // stripped from the article before publish. Surfaced in the UI so the user
  // knows the final article had its citations cleaned.
  unverifiedCitationsRemoved: integer("unverified_citations_removed").notNull().default(0),
  // Legacy columns kept for backward compatibility with existing data; always
  // null/zero on new articles.
  copyleaksScore: real("copyleaks_score"),
  burstinessScore: real("burstiness_score"),
  lexicalFingerprintScore: real("lexical_fingerprint_score"),
  primaryKeywordDensity: real("primary_keyword_density"),
  secondaryKeywordDensity: real("secondary_keyword_density"),
  emDashCount: integer("em_dash_count"),
  faqCount: integer("faq_count"),
  googleDocUrl: text("google_doc_url"),
  googleDocFileName: text("google_doc_file_name"),
  seoMetaDescription: text("seo_meta_description"),
  seoSlug: text("seo_slug"),
  seoTags: text("seo_tags"),
  retryCount: integer("retry_count").notNull().default(0),
  aiSignatureRetryCount: integer("ai_signature_retry_count").notNull().default(0),
  createdBy: text("created_by"),
  errorMessage: text("error_message"),
  articleContent: text("article_content"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});

export const insertArticleSchema = createInsertSchema(articlesTable).omit({
  id: true,
  createdAt: true,
  completedAt: true,
});

export type InsertArticle = z.infer<typeof insertArticleSchema>;
export type Article = typeof articlesTable.$inferSelect;
