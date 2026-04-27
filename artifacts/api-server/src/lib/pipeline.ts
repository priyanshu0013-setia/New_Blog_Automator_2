import Anthropic from "@anthropic-ai/sdk";
import { db } from "@workspace/db";
import { articlesTable, pipelineLogsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger";
import { publishToGoogleDocs, isGoogleDocsConfigured } from "./google-docs";
import {
  humanizeText,
  scoreAiContent,
  isZeroGptConfigured,
  ZeroGptError,
} from "./zerogpt";
import {
  gatherVerifiedSources,
  extractCitations,
  verifyCitations,
  stripUnverifiedCitations,
  type VerifiedSource,
} from "./web-search";

type ArticleStatus =
  | "queued"
  | "researching"
  | "writing"
  | "humanizing"
  | "formatting"
  | "completed"
  | "failed"
  | "flagged";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const PRIMARY_DENSITY_TARGET_MIN = 1.0;
const PRIMARY_DENSITY_TARGET_MAX = 2.5;

// ─── DB helpers ──────────────────────────────────────────────────────────────

async function updateArticleStatus(
  id: number,
  status: ArticleStatus,
  extra?: Partial<typeof articlesTable.$inferSelect>,
) {
  await db.update(articlesTable).set({ status, ...extra }).where(eq(articlesTable.id, id));
}

async function logStep(
  articleId: number,
  stepName: string,
  status: "running" | "completed" | "failed",
  details?: string,
) {
  await db.insert(pipelineLogsTable).values({
    articleId,
    stepName,
    status,
    details: details ?? null,
  });
}

// ─── Text utilities ──────────────────────────────────────────────────────────

function countWords(text: string): number {
  return text.split(/\s+/).filter((w) => w.length > 0).length;
}

function truncateReferenceInput(input: string, maxChars = 12000): string {
  if (input.length <= maxChars) return input;
  const truncated = input.slice(0, maxChars);
  const lastParagraphBreak = truncated.lastIndexOf("\n\n");
  if (lastParagraphBreak > maxChars * 0.8) return truncated.slice(0, lastParagraphBreak);
  return truncated;
}

function calculateKeywordDensity(text: string, keyword: string): number {
  if (!keyword || !text) return 0;
  const normalizedText = text
    .toLowerCase()
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/\[[^\]]+\]\([^)]+\)/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[#>*_|~]/g, " ")
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const words = normalizedText.split(/\s+/).filter((w) => w.length > 0);
  const totalWords = words.length;
  if (totalWords === 0) return 0;
  const kw = keyword
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!kw) return 0;
  const kwPattern = kw
    .split(/\s+/)
    .map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("\\s+");
  const regex = new RegExp(`\\b${kwPattern}\\b`, "g");
  const matches = normalizedText.match(regex);
  const count = matches ? matches.length : 0;
  return parseFloat(((count / totalWords) * 100).toFixed(2));
}

function densityDistanceFromBand(value: number, min: number, max: number): number {
  if (value < min) return min - value;
  if (value > max) return value - max;
  return 0;
}

function extractFAQs(text: string): string[] {
  const lines = text.split("\n");
  const faqStart = lines.findIndex((line) =>
    /^#{1,3}\s*(FAQ|Frequently Asked Questions|Common Questions)\b/i.test(line.trim()),
  );
  if (faqStart === -1) return [];
  return lines
    .slice(faqStart + 1)
    .map((l) => l.trim())
    .filter(
      (l) => l.length > 0 && !l.startsWith("#") && /^(?:\*\*)?\s*Q(?:uestion)?\s*\d+\s*[:.]/i.test(l),
    );
}

const FAQ_OVERLAP_STOPWORDS = new Set([
  "the","a","an","is","are","was","were","be","been","being","and","or","but","if","then","so",
  "of","to","in","on","at","for","with","by","from","as","it","its","this","that","these","those",
  "i","you","we","they","he","she","what","why","how","when","where","who","which","does","do","did",
  "can","could","should","would","will","has","have","had","not","no","yes","than","about","into",
  "out","your","my","our","their","there","here","more","most",
]);

function extractContentWords(text: string): Set<string> {
  return new Set(
    text.toLowerCase()
      .replace(/[^a-z0-9\s-]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 4 && !FAQ_OVERLAP_STOPWORDS.has(w))
  );
}

/**
 * Soft check: identify FAQ entries whose content significantly overlaps with
 * the article body. Returns the indices of overlapping FAQs (≥70% of meaningful
 * content words appear in the body) so the safety-net check can warn — not
 * fail. The model is asked to avoid this in the writing prompt; this is the
 * post-hoc verification.
 */
/**
 * Extract every H2 and H3 heading from the article, excluding the FAQ section
 * and any sub-headings within it. Once we hit the FAQ heading, we stop
 * collecting (FAQ Q-numbers shouldn't count toward heading-keyword stats).
 */
function extractHeadings(article: string): { level: 2 | 3; text: string }[] {
  const headings: { level: 2 | 3; text: string }[] = [];
  let inFaqSection = false;
  for (const line of article.split("\n")) {
    const m = /^(#{2,3})\s+(.+)$/.exec(line.trim());
    if (!m) continue;
    const level = m[1].length === 2 ? 2 : 3;
    const text = m[2].trim();
    if (/^(FAQ|Frequently Asked Questions|Common Questions)\b/i.test(text)) {
      inFaqSection = true;
      continue;
    }
    if (inFaqSection && level === 2) {
      // A new H2 after the FAQ section means we're back in body content.
      // (Articles don't typically have content after FAQs, but defensively
      //  re-enable counting.)
      inFaqSection = false;
    }
    if (inFaqSection) continue;
    headings.push({ level: level as 2 | 3, text });
  }
  return headings;
}

/**
 * Check primary/secondary keyword presence in headings, per the three rules:
 *   1. At least 30% of H2/H3 headings must include the primary keyword.
 *   2. Every H2/H3 must include at least one primary OR secondary keyword.
 *   3. When secondary keywords are provided, at least 25% of H2/H3 must
 *      include at least one secondary keyword.
 *
 * Matching is case-insensitive and uses whole-word boundaries so "tone" in
 * a heading isn't matched by the keyword "stone." Multi-word keywords match
 * if all their words appear adjacent (any whitespace between).
 *
 * Returns the violation set so the pipeline can decide whether to auto-fix.
 */
type HeadingCheckResult = {
  totalHeadings: number;
  primaryHeadings: number;
  secondaryHeadings: number;
  primaryRatio: number;
  secondaryRatio: number;
  noKeywordHeadings: { level: 2 | 3; text: string }[];
  rule1Pass: boolean; // primary >= 30%
  rule2Pass: boolean; // every heading has primary OR secondary
  rule3Pass: boolean; // secondary >= 25% (only meaningful when secondaries provided)
  hasSecondaryKeywords: boolean;
};

function headingMatchesKeyword(headingText: string, keyword: string): boolean {
  const cleaned = keyword.trim().toLowerCase();
  if (!cleaned) return false;
  const escaped = cleaned.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // For multi-word keywords, allow any whitespace between words.
  const pattern = escaped.split(/\s+/).join("\\s+");
  return new RegExp(`\\b${pattern}\\b`, "i").test(headingText);
}

function checkHeadingKeywords(
  article: string,
  primaryKeyword: string,
  secondaryKeywords: string | null,
): HeadingCheckResult {
  const headings = extractHeadings(article);
  const totalHeadings = headings.length;
  if (totalHeadings === 0) {
    return {
      totalHeadings: 0, primaryHeadings: 0, secondaryHeadings: 0,
      primaryRatio: 0, secondaryRatio: 0, noKeywordHeadings: [],
      rule1Pass: false, rule2Pass: false, rule3Pass: false,
      hasSecondaryKeywords: false,
    };
  }

  const secondaryList = secondaryKeywords
    ? secondaryKeywords.split(",").map((s) => s.trim()).filter((s) => s.length > 0)
    : [];

  let primaryHeadings = 0;
  let secondaryHeadings = 0;
  const noKeywordHeadings: { level: 2 | 3; text: string }[] = [];

  for (const h of headings) {
    const hasPrimary = headingMatchesKeyword(h.text, primaryKeyword);
    const hasSecondary = secondaryList.some((kw) => headingMatchesKeyword(h.text, kw));
    if (hasPrimary) primaryHeadings++;
    if (hasSecondary) secondaryHeadings++;
    if (!hasPrimary && !hasSecondary) noKeywordHeadings.push(h);
  }

  const primaryRatio = primaryHeadings / totalHeadings;
  const secondaryRatio = secondaryList.length > 0 ? secondaryHeadings / totalHeadings : 0;
  const hasSecondaryKeywords = secondaryList.length > 0;

  return {
    totalHeadings,
    primaryHeadings,
    secondaryHeadings,
    primaryRatio,
    secondaryRatio,
    noKeywordHeadings,
    rule1Pass: primaryRatio >= 0.30,
    rule2Pass: noKeywordHeadings.length === 0,
    rule3Pass: !hasSecondaryKeywords || secondaryRatio >= 0.25,
    hasSecondaryKeywords,
  };
}

function summarizeHeadingViolations(check: HeadingCheckResult): string[] {
  const issues: string[] = [];
  if (!check.rule1Pass) {
    issues.push(
      `${check.primaryHeadings}/${check.totalHeadings} headings include primary keyword (target ≥30%, got ${(check.primaryRatio * 100).toFixed(0)}%)`,
    );
  }
  if (!check.rule2Pass) {
    issues.push(
      `${check.noKeywordHeadings.length} heading(s) missing both primary and secondary keywords`,
    );
  }
  if (!check.rule3Pass) {
    issues.push(
      `${check.secondaryHeadings}/${check.totalHeadings} headings include a secondary keyword (target ≥25%, got ${(check.secondaryRatio * 100).toFixed(0)}%)`,
    );
  }
  return issues;
}

function detectFaqBodyOverlap(text: string): { duplicateIndices: number[]; total: number } {
  const lines = text.split("\n");
  const faqStart = lines.findIndex((line) =>
    /^#{1,3}\s*(FAQ|Frequently Asked Questions|Common Questions)\b/i.test(line.trim()),
  );
  if (faqStart === -1) return { duplicateIndices: [], total: 0 };

  const body = lines.slice(0, faqStart).join("\n");
  const bodyWords = extractContentWords(body);

  // Walk the FAQ section, splitting into Q1./Q2./... blocks.
  const faqLines = lines.slice(faqStart + 1);
  const blocks: string[] = [];
  let current = "";
  for (const l of faqLines) {
    const trimmed = l.trim();
    if (/^#{1,3}\s/.test(trimmed)) break; // hit next section
    if (/^(?:\*\*)?\s*Q\d+\s*[:.]/i.test(trimmed)) {
      if (current) blocks.push(current);
      current = l + "\n";
    } else if (current) {
      current += l + "\n";
    }
  }
  if (current) blocks.push(current);

  const duplicateIndices: number[] = [];
  blocks.forEach((block, i) => {
    const words = [...extractContentWords(block)];
    if (words.length < 4) return;
    const overlap = words.filter((w) => bodyWords.has(w));
    const ratio = overlap.length / words.length;
    if (ratio >= 0.70) duplicateIndices.push(i);
  });

  return { duplicateIndices, total: blocks.length };
}

function generateSeoSlug(title: string, keyword: string): string {
  const source = title || keyword || "blog-post";
  return source
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .trim()
    .split(/\s+/)
    .filter((w) => !["a", "an", "the", "and", "or", "but", "of", "in", "on", "at", "to", "for"].includes(w))
    .slice(0, 8)
    .join("-")
    .slice(0, 80);
}

// ─── Claude API helper ───────────────────────────────────────────────────────

type ClaudeGenerationOverrides = {
  temperature?: number;
  system?: string;
  prefill?: string;
  includePrefillInReturn?: boolean;
};

function getAnthropicClient(): Anthropic {
  if (!ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not configured");
  return new Anthropic({ apiKey: ANTHROPIC_API_KEY });
}

async function callClaude(
  client: Anthropic,
  prompt: string,
  maxTokens = 8192,
  overrides: ClaudeGenerationOverrides = {},
): Promise<string> {
  const temperature = overrides.temperature ?? 0.85;
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: prompt }];
  const prefill = overrides.prefill ? overrides.prefill.replace(/\s+$/, "") : "";
  if (prefill) messages.push({ role: "assistant", content: prefill });

  const message = await client.messages.create({
    model: "claude-opus-4-5",
    max_tokens: maxTokens,
    temperature,
    ...(overrides.system ? { system: overrides.system } : {}),
    messages,
  });
  const textContent = message.content.find((c) => c.type === "text");
  const generated = textContent ? textContent.text : "";
  const includePrefill = overrides.includePrefillInReturn ?? true;
  return prefill && includePrefill ? prefill + generated : generated;
}

// ─── Main pipeline ────────────────────────────────────────────────────────────

async function runPipeline(articleId: number): Promise<void> {
  logger.info({ articleId }, "Starting pipeline");

  let article;
  try {
    [article] = await db.select().from(articlesTable).where(eq(articlesTable.id, articleId));
    if (!article) {
      logger.error({ articleId }, "Article not found");
      return;
    }
  } catch (err) {
    logger.error({ articleId, err }, "Failed to fetch article");
    return;
  }

  const client = (() => {
    try {
      return getAnthropicClient();
    } catch {
      logger.warn({ articleId }, "No Anthropic API key configured");
      return null;
    }
  })();

  if (!client) {
    await updateArticleStatus(articleId, "failed", {
      errorMessage: "ANTHROPIC_API_KEY is not configured. Please add your API key to run the pipeline.",
    });
    await logStep(articleId, "startup", "failed", "No API key configured");
    return;
  }

  try {
    // Step 1: Input collation
    await logStep(
      articleId,
      "input_collation",
      "completed",
      `Topic: ${article.topic}; Primary keyword: ${article.primaryKeyword}; Audience: ${article.targetAudience || "not provided"}; Target words: ${article.wordCountTarget}`,
    );

    // Step 2: Research
    await updateArticleStatus(articleId, "researching");
    await logStep(articleId, "research", "running", "Building research brief");

    const referenceInput = article.referenceInput ? truncateReferenceInput(article.referenceInput) : "";

    const researchPrompt = `Produce a research brief for the following blog article. The brief will be read by a writer, so it must be self-contained.

TOPIC: ${article.topic}
PRIMARY KEYWORD: ${article.primaryKeyword}
${article.secondaryKeywords ? `SECONDARY KEYWORDS: ${article.secondaryKeywords}` : ""}
${article.targetAudience ? `TARGET AUDIENCE: ${article.targetAudience}` : ""}
${article.tone ? `TONE: ${article.tone}` : ""}
TARGET WORD COUNT: ${article.wordCountTarget}
${referenceInput ? `\nREFERENCE INPUT (prioritize when forming the outline and facts):\n<<<REFERENCE\n${referenceInput}\nREFERENCE>>>\n` : ""}

Produce these sections in order, as Markdown:

## Outline
A list of 5-7 H2 sections with 1-3 sub-bullet points each describing what the section will cover. Each H2 must cover a meaningfully different aspect of the topic.

## Key facts and data
Specific statistics, dates, named sources, or concrete facts worth including in the article. Cite sources inline where possible.

## FAQ candidates
4 to 8 candidate FAQs with short answers. Only include questions that are genuinely useful and whose answers add information NOT already covered in the main outline. Quality over quantity — if you can only justify 4 distinct questions, list 4. Never pad to reach a count.

## Recommended angle
A one-paragraph hook or angle that differentiates this article from competitors.`;

    const researchOutput = await callClaude(client, researchPrompt, 4096, {
      temperature: 0.4,
      system: `You are a research assistant. Produce concise, source-aware research briefs with the exact section headings requested. Stick to facts and concrete specifics.`,
    });
    await logStep(articleId, "research", "completed", `Research brief generated (${countWords(researchOutput)} words)`);

    // Step 2b: Source gathering — DISABLED.
    // The web-search step that constrained the writer to cite only verified
    // sources is currently turned off. The pipeline writes without an explicit
    // source list; the ZeroGPT humanizer transforms the draft as-is.
    //
    // To re-enable: uncomment the block below, restore the original logging,
    // and the writing prompt's citation rules (in buildWritingPrompt) will
    // automatically activate when sourcesBlock is non-empty.
    //
    // await logStep(articleId, "source_gathering", "running", "Searching the web for verified sources");
    // try {
    //   verifiedSources = await gatherVerifiedSources(client, article.topic, article.primaryKeyword, article.secondaryKeywords);
    //   await logStep(articleId, "source_gathering", "completed",
    //     verifiedSources.length > 0 ? `Found ${verifiedSources.length} verified source(s)` : "No sources found");
    // } catch (err) {
    //   logger.warn({ articleId, err }, "Source gathering failed");
    //   await logStep(articleId, "source_gathering", "failed", "Source gathering errored");
    // }
    const verifiedSources: VerifiedSource[] = [];
    const sourcesBlock = "";

    // Step 3: Write article with keyword-density retry.
    // Density is checked on the Claude draft (not the humanized version) because
    // the humanizer paraphrases away keyword instances; trying to enforce density
    // post-humanization would be a fight against the humanizer. We aim for
    // 1.0%–2.5% density on the draft so that some buffer remains after humanization.
    // Up to 2 retries if the draft falls outside the target range.
    await updateArticleStatus(articleId, "writing");

    const targetWords = article.wordCountTarget;
    const MAX_DENSITY_ATTEMPTS = 3; // 1 initial + 2 retries

    const buildWritingPrompt = (densityHint?: { lastDensity: number; tooLow: boolean }) => {
      const densitySection = densityHint
        ? `\n\nPREVIOUS ATTEMPT: primary keyword density was ${densityHint.lastDensity}% (target ${PRIMARY_DENSITY_TARGET_MIN}%–${PRIMARY_DENSITY_TARGET_MAX}%). ${
          densityHint.tooLow
              ? `That's TOO LOW. Use the primary keyword "${article.primaryKeyword}" more often throughout the body — naturally, in ways that fit the prose. Aim for the keyword to appear roughly every 60-70 words on average.`
              : `That's TOO HIGH. Use synonyms and pronouns ("the strategy", "this approach", "it") in places where the primary keyword "${article.primaryKeyword}" appears repeatedly close together.`
        }\n`
        : "";

      return `Write a complete blog article using the research brief below.

RESEARCH BRIEF:
${researchOutput}
${sourcesBlock ? `\nVERIFIED SOURCES (the ONLY allowed citation pool):\n${sourcesBlock}\n\nCITATION RULES:\n- You may only cite, quote, or attribute claims to sources from the VERIFIED SOURCES list above.\n- When citing, use one of these forms: a markdown link to the source URL, "according to [Source Name]", or "a [year] [Org] [study/report]". The named org or domain MUST appear in the verified list.\n- Do NOT invent sources. Do NOT cite "industry reports" or "experts say" without a named source from the list.\n- If a claim isn't supported by the verified sources, either don't make it, or state it as your own observation without attribution.\n- Use sources sparingly and where they genuinely add credibility — 2 to 5 citations is typical for an article this length.\n` : ""}
ARTICLE SPECIFICATIONS:
- Topic: ${article.topic}
- Primary keyword: "${article.primaryKeyword}" — STRICT density target: ${PRIMARY_DENSITY_TARGET_MIN}% to ${PRIMARY_DENSITY_TARGET_MAX}% of total word count. For a ${targetWords}-word article, that's roughly ${Math.round(targetWords * PRIMARY_DENSITY_TARGET_MIN / 100)} to ${Math.round(targetWords * PRIMARY_DENSITY_TARGET_MAX / 100)} occurrences. The keyword must be repeated this often, woven into the prose naturally.
${article.secondaryKeywords ? `- Secondary keywords: "${article.secondaryKeywords}" — work these in naturally.` : ""}
${article.targetAudience ? `- Target audience: ${article.targetAudience}` : ""}
${article.tone ? `- Tone: ${article.tone}. Match this tone consistently across the article.` : ""}
- Target word count: ${targetWords} words. Aim for approximately this length, but prioritize quality and natural flow over hitting an exact count.

STRUCTURE:
- H1 title, then H2 sections with optional H3 subsections.
- HEADING KEYWORD RULES: Every H2 and H3 heading must include either the primary keyword or one of the secondary keywords. Aim for the primary keyword to appear in roughly 30-50% of headings (more if the topic warrants), with at least 25% of headings including a secondary keyword when secondary keywords are provided. Weave keywords naturally into the heading's actual subject — do NOT prepend them artificially or stuff them. The FAQ section's main heading stays as "Frequently Asked Questions".
- End with a "Frequently Asked Questions" section containing 4 to 8 Q&A pairs (use "Q1.", "Q2.", ... numbering). Pick the count based on how many genuinely distinct questions the topic supports — never pad to reach a number, never repeat a question whose answer already appears in the body.
- Each FAQ answer MUST cover information not already present in the body of the article. If you cannot write an FAQ whose answer is genuinely new, drop that slot rather than pad.
- Include 1-2 tables and bullet lists where appropriate.
${referenceInput ? `\nREFERENCE INPUT:\n<<<REFERENCE\n${referenceInput}\nREFERENCE>>>\n` : ""}

${article.tone ? `Write in the tone described above.` : "Write in a formal, expert voice."} Prefer direct, concrete statements with named sources and specific numbers. Start the article with the H1 line — no preamble, no commentary.${densitySection}`;
    };

    let articleDraft = "";
    let densityAttempt = 0;
    let lastDraftDensity = 0;

    while (densityAttempt < MAX_DENSITY_ATTEMPTS) {
      densityAttempt++;
      const stepLabel = densityAttempt === 1 ? "writing" : `writing_density_retry_${densityAttempt - 1}`;
      const densityHint = densityAttempt > 1
        ? { lastDensity: lastDraftDensity, tooLow: lastDraftDensity < PRIMARY_DENSITY_TARGET_MIN }
        : undefined;

      await logStep(
        articleId,
        stepLabel,
        "running",
        densityAttempt === 1
          ? `Generating article draft (target ${targetWords} words; primary keyword density target ${PRIMARY_DENSITY_TARGET_MIN}%–${PRIMARY_DENSITY_TARGET_MAX}%)`
          : `Last attempt density was ${lastDraftDensity}% (need ${PRIMARY_DENSITY_TARGET_MIN}%–${PRIMARY_DENSITY_TARGET_MAX}%); regenerating`,
      );

      articleDraft = await callClaude(client, buildWritingPrompt(densityHint), 8192, {
        temperature: 0.85,
        system: `You are writing a long-form SEO blog post for a professional publication. Output markdown only, starting with the H1.`,
      });

      const draftWords = countWords(articleDraft);
      const draftDensity = calculateKeywordDensity(articleDraft, article.primaryKeyword);
      lastDraftDensity = draftDensity;

      await logStep(
        articleId,
        stepLabel,
        "completed",
        `Draft generated (${draftWords} words; primary keyword density ${draftDensity}%)`,
      );

      if (draftDensity >= PRIMARY_DENSITY_TARGET_MIN && draftDensity <= PRIMARY_DENSITY_TARGET_MAX) {
        break; // density in band, accept
      }
    }

    // Word count is tracked but not enforced. Always record as in-band (false)
    // so the warning banner doesn't fire — actual vs target is still visible
    // in the UI from wordCountActual + wordCountTarget.
    const wordCountOutOfBand = false;

    // Step 3b: Citation verification — DISABLED.
    // The mechanical citation extraction/verification/strip step is turned off
    // because source gathering is also disabled (no verified-source list to
    // check against). Re-enabling source gathering above will need this block
    // re-enabled too.
    //
    // const extracted = extractCitations(articleDraft);
    // const unverified = verifyCitations(extracted, verifiedSources);
    // let citationStripped = 0;
    // let articleAfterCitationCheck = articleDraft;
    // if (unverified.length > 0) {
    //   const stripResult = stripUnverifiedCitations(articleDraft, unverified);
    //   articleAfterCitationCheck = stripResult.article;
    //   citationStripped = stripResult.stripped;
    // }
    // const verifiedCitationCount = extracted.length - unverified.length;
    const articleAfterCitationCheck = articleDraft;
    const citationStripped = 0;
    const verifiedCitationCount = 0;

    // Step 3c: Heading-keyword check and one-shot auto-fix (PRE-humanization).
    // Runs on the Claude draft so the model rewriting headings has clean prose
    // to work with. ZeroGPT then humanizes the heading-corrected article.
    //
    // Rules: 30% of headings include primary, every heading has primary OR
    // secondary, 25% include a secondary (when secondaries provided).
    let articleAfterHeadingFix = articleAfterCitationCheck;
    let headingCheck = checkHeadingKeywords(articleAfterCitationCheck, article.primaryKeyword, article.secondaryKeywords);
    const headingViolationsInitial = summarizeHeadingViolations(headingCheck);

    if (headingViolationsInitial.length > 0) {
      await logStep(
        articleId,
        "heading_check",
        "running",
        `Heading violations detected (${headingViolationsInitial.join("; ")}). Attempting one model rewrite before humanization.`,
      );

      try {
        const headingFixPrompt = `The article below has heading-keyword issues that need fixing. Rewrite ONLY the H2 (##) and H3 (###) headings to satisfy these rules. Do NOT change the article body content under any heading — preserve all paragraphs, lists, tables, and FAQ content verbatim.

CURRENT VIOLATIONS:
${headingViolationsInitial.map((v) => `- ${v}`).join("\n")}

KEYWORD RULES TO SATISFY:
- Primary keyword: "${article.primaryKeyword}" — must appear in at least 30% of H2/H3 headings.
${article.secondaryKeywords ? `- Secondary keywords: "${article.secondaryKeywords}" — at least 25% of H2/H3 headings must include at least one of these.` : ""}
- Every H2 and H3 heading must include at least one keyword (primary or secondary).
- Skip the FAQ section's main heading — it stays as "Frequently Asked Questions".

CRITICAL CONSTRAINTS:
- Headings must read naturally. Do NOT keyword-stuff. Do NOT just prepend the keyword to existing headings — rewrite them so the keyword fits the heading's actual subject.
- Preserve heading levels (H2 stays H2, H3 stays H3).
- Preserve heading order.
- Preserve all body content under each heading exactly.
- Return the COMPLETE article with rewritten headings only.

ARTICLE:
${articleAfterCitationCheck}`;

        const fixed = await callClaude(client, headingFixPrompt, 8192, {
          temperature: 0.4,
          system: `You are an SEO editor rewriting article headings to include target keywords naturally. Output the complete article with only the headings changed; body content stays verbatim. Output markdown only, starting with the H1.`,
        });

        if (fixed.trim().length > 0) {
          // Re-check after the fix attempt.
          const recheck = checkHeadingKeywords(fixed, article.primaryKeyword, article.secondaryKeywords);
          const recheckViolations = summarizeHeadingViolations(recheck);
          if (recheckViolations.length < headingViolationsInitial.length) {
            articleAfterHeadingFix = fixed;
            headingCheck = recheck;
            await logStep(
              articleId,
              "heading_check",
              recheckViolations.length === 0 ? "completed" : "failed",
              recheckViolations.length === 0
                ? `Heading rewrite fixed all violations (${headingCheck.primaryHeadings}/${headingCheck.totalHeadings} primary, ${headingCheck.secondaryHeadings}/${headingCheck.totalHeadings} secondary)`
                : `Heading rewrite reduced violations to: ${recheckViolations.join("; ")}. Article continuing to humanization with remaining issues flagged.`,
            );
          } else {
            await logStep(
              articleId,
              "heading_check",
              "failed",
              `Heading rewrite did not improve violations. Article continuing to humanization with: ${headingViolationsInitial.join("; ")}`,
            );
          }
        } else {
          await logStep(articleId, "heading_check", "failed", "Heading rewrite returned empty content. Article continuing with original headings.");
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn({ articleId, err }, "Heading rewrite attempt errored");
        await logStep(articleId, "heading_check", "failed", `Heading rewrite errored: ${msg}. Article continuing with original headings.`);
      }
    } else {
      await logStep(
        articleId,
        "heading_check",
        "completed",
        `Heading keywords OK (${headingCheck.primaryHeadings}/${headingCheck.totalHeadings} include primary, ${headingCheck.secondaryHeadings}/${headingCheck.totalHeadings} include secondary)`,
      );
    }

    // Step 4: ZeroGPT humanization + scoring
    await updateArticleStatus(articleId, "humanizing");
    let finalArticle = articleAfterHeadingFix;
    let zeroGptScore: number | null = null;
    let humanizationFailed = false;

    if (isZeroGptConfigured()) {
      // Humanize (3 retries built into humanizeText)
      await logStep(articleId, "zerogpt_humanize", "running", "Sending article to ZeroGPT humanizer");
      let humanizationSucceeded = false;
      try {
        const humanized = await humanizeText(articleAfterHeadingFix, article.tone);
        finalArticle = humanized;
        humanizationSucceeded = true;
        await logStep(
          articleId,
          "zerogpt_humanize",
          "completed",
          `Humanization complete (${countWords(humanized)} words)`,
        );
      } catch (err) {
        humanizationFailed = true;
        const errMsg = err instanceof ZeroGptError ? err.message : String(err);
        logger.warn(
          { articleId, err },
          "ZeroGPT humanization failed after retries; publishing un-transformed draft with warning flag",
        );
        await logStep(
          articleId,
          "zerogpt_humanize",
          "failed",
          `Humanization failed after 3 retries: ${errMsg}. Publishing un-transformed draft.`,
        );
      }

      // Step 4b: Format restoration after ZeroGPT.
      // ZeroGPT's Paraphrase API treats input as one block of text and frequently
      // mangles markdown structure: collapses paragraph breaks, joins headings
      // with following text, breaks FAQ Q-numbering, and sometimes inserts
      // chatbot-style intrusions ("Please provide the text...") directly into
      // the output. We send the broken result back to Claude with strict
      // word-preservation instructions to restore structure.
      //
      // This step only runs when humanization succeeded — if we're publishing
      // the un-transformed draft, the original structure is already intact.
      //
      // Honest caveat: the model is told not to change words, but LLMs are
      // imperfect at strict preservation. Spot-check published articles
      // periodically to catch any cases where wording drifted.
      if (humanizationSucceeded) {
        await logStep(articleId, "format_restore", "running", "Restoring markdown structure after humanization");
        try {
          const formatFixPrompt = `The text below was just paraphrased by an automated tool, which broke its formatting. Your job is to restore proper markdown formatting WITHOUT CHANGING ANY WORDS.

REFERENCE STRUCTURE (for markdown layout only; do not copy wording from here):
<<<REFERENCE_STRUCTURE
${articleAfterHeadingFix}
REFERENCE_STRUCTURE>>>

CRITICAL RULES — read carefully:
1. Preserve every word exactly as written. Do not add, remove, or substitute any words. Do not "fix" typos. Do not "improve" phrasing. Do not paraphrase anything.
2. The ONLY changes you may make are:
   - Adding blank lines between paragraphs
   - Restoring markdown headings (##, ###) on their own lines with blank lines before and after
   - Restoring FAQ numbering format (e.g., "**Q1.** What is X?" with proper spacing)
   - Restoring bullet lists and numbered lists on separate lines
   - Restoring table structure (| col | col |) with proper line breaks
   - Removing entire sentences that are clearly chatbot intrusions, such as "Please provide the text you would like me to paraphrase" or "Certainly! Please provide..." or "Here is the rewritten version" — these were not in the original article and should be deleted entirely. ONLY delete sentences that are literally chatbot meta-commentary, never delete actual article content.
3. Follow the REFERENCE_STRUCTURE only for where headings, paragraphs, lists, tables, and FAQ blocks should break. Keep the paraphrased words from ARTICLE TO RESTORE.
4. If a heading or FAQ question appears to be missing entirely (the surrounding text suggests there should be a question but no question text exists), do NOT invent one. Leave the gap and let it be flagged later.
5. Keep the article's H1, H2, H3 hierarchy as it appears in the text. If a heading has been collapsed into a paragraph, restore it to its own line.
6. Output the cleanly-formatted markdown article. Start with the H1. No preamble, no explanation, no commentary.

ARTICLE TO RESTORE:
${finalArticle}`;

          const restored = await callClaude(client, formatFixPrompt, 8192, {
            temperature: 0.1, // Very low — we want deterministic, conservative behavior
            system: `You are a markdown formatter. You restore broken markdown structure without changing any words. Output the article only, no commentary.`,
          });

          if (restored.trim().length > 0) {
            const restoredWords = countWords(restored);
            const originalWords = countWords(finalArticle);
            const sourceHeadingCount = (articleAfterHeadingFix.match(/^#{1,3}\s+\S+/gm) ?? []).length;
            const restoredHeadingCount = (restored.match(/^#{1,3}\s+\S+/gm) ?? []).length;
            const sourceFaqCount = extractFAQs(articleAfterHeadingFix).length;
            const restoredFaqCount = extractFAQs(restored).length;
            const headingCoverageOk =
              sourceHeadingCount === 0 ||
              restoredHeadingCount >= Math.max(3, Math.floor(sourceHeadingCount * 0.6));
            const faqCoverageOk = sourceFaqCount === 0 || restoredFaqCount > 0;
            // Sanity check: if word count differs by more than 5%, the model
            // changed too much. Reject the restoration and keep the broken
            // version (better to ship broken format than altered content).
            const drift = Math.abs(restoredWords - originalWords) / Math.max(originalWords, 1);
            if (drift > 0.05 || !headingCoverageOk || !faqCoverageOk) {
              await logStep(
                articleId,
                "format_restore",
                "failed",
                !headingCoverageOk || !faqCoverageOk
                  ? `Format restoration did not preserve enough structure (headings ${restoredHeadingCount}/${sourceHeadingCount}, FAQs ${restoredFaqCount}/${sourceFaqCount}). Keeping un-restored version.`
                  : `Format restoration changed word count too much (${originalWords} → ${restoredWords}, ${(drift * 100).toFixed(1)}% drift). Keeping un-restored version.`,
              );
            } else {
              finalArticle = restored;
              await logStep(
                articleId,
                "format_restore",
                "completed",
                `Format restored (${originalWords} → ${restoredWords} words, ${(drift * 100).toFixed(1)}% drift — within tolerance)`,
              );
            }
          } else {
            await logStep(articleId, "format_restore", "failed", "Format restoration returned empty content. Keeping un-restored version.");
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn({ articleId, err }, "Format restoration errored");
          await logStep(articleId, "format_restore", "failed", `Format restoration errored: ${msg}. Keeping un-restored version.`);
        }
      }

      // Step 4c: Rebalance primary keyword density on the final post-humanized
      // article. ZeroGPT paraphrasing often reduces exact keyword frequency.
      const finalDensityBeforeRebalance = calculateKeywordDensity(finalArticle, article.primaryKeyword);
      const densityOutOfBand =
        finalDensityBeforeRebalance < PRIMARY_DENSITY_TARGET_MIN ||
        finalDensityBeforeRebalance > PRIMARY_DENSITY_TARGET_MAX;
      if (densityOutOfBand) {
        await logStep(
          articleId,
          "density_rebalance",
          "running",
          `Final density is ${finalDensityBeforeRebalance}% (target ${PRIMARY_DENSITY_TARGET_MIN}%–${PRIMARY_DENSITY_TARGET_MAX}%). Attempting one controlled rewrite.`,
        );
        try {
          const rebalancePrompt = `Adjust this article so the PRIMARY KEYWORD density lands between ${PRIMARY_DENSITY_TARGET_MIN}% and ${PRIMARY_DENSITY_TARGET_MAX}%.

PRIMARY KEYWORD: "${article.primaryKeyword}"
CURRENT DENSITY: ${finalDensityBeforeRebalance}%

STRICT RULES:
- Keep markdown structure (H1/H2/H3, lists, tables, FAQ section and Q-numbering) intact.
- Keep the same factual claims and overall meaning.
- Make the smallest possible edits needed to move keyword density into range.
- Do not add preamble or commentary; return only the full markdown article.

ARTICLE:
${finalArticle}`;

          const rebalanced = await callClaude(client, rebalancePrompt, 8192, {
            temperature: 0.3,
            system:
              "You are an SEO editor making minimal edits to tune primary keyword density while preserving structure and meaning. Output markdown only.",
          });

          if (rebalanced.trim().length > 0) {
            const rebalancedDensity = calculateKeywordDensity(rebalanced, article.primaryKeyword);
            const beforeWords = countWords(finalArticle);
            const afterWords = countWords(rebalanced);
            const wordDrift = Math.abs(afterWords - beforeWords) / Math.max(beforeWords, 1);
            const beforeDistance = densityDistanceFromBand(
              finalDensityBeforeRebalance,
              PRIMARY_DENSITY_TARGET_MIN,
              PRIMARY_DENSITY_TARGET_MAX,
            );
            const afterDistance = densityDistanceFromBand(
              rebalancedDensity,
              PRIMARY_DENSITY_TARGET_MIN,
              PRIMARY_DENSITY_TARGET_MAX,
            );
            if (afterDistance < beforeDistance && wordDrift <= 0.08) {
              finalArticle = rebalanced;
              await logStep(
                articleId,
                "density_rebalance",
                "completed",
                `Density improved ${finalDensityBeforeRebalance}% → ${rebalancedDensity}%`,
              );
            } else {
              await logStep(
                articleId,
                "density_rebalance",
                "failed",
                `Rebalance not accepted (density ${finalDensityBeforeRebalance}% → ${rebalancedDensity}%, word drift ${(wordDrift * 100).toFixed(1)}%). Keeping current version.`,
              );
            }
          } else {
            await logStep(
              articleId,
              "density_rebalance",
              "failed",
              "Density rebalance returned empty content. Keeping current version.",
            );
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn({ articleId, err }, "Density rebalance attempt errored");
          await logStep(
            articleId,
            "density_rebalance",
            "failed",
            `Density rebalance errored: ${msg}. Keeping current version.`,
          );
        }
      } else {
        await logStep(
          articleId,
          "density_rebalance",
          "completed",
          `Final density already in range (${finalDensityBeforeRebalance}%).`,
        );
      }

      // Score the article we're actually going to publish
      await logStep(articleId, "zerogpt_score", "running", "Scoring article with ZeroGPT detector");
      try {
        zeroGptScore = await scoreAiContent(finalArticle);
        await logStep(
          articleId,
          "zerogpt_score",
          "completed",
          `ZeroGPT AI score: ${zeroGptScore.toFixed(1)}%`,
        );
      } catch (err) {
        const errMsg = err instanceof ZeroGptError ? err.message : String(err);
        logger.warn({ articleId, err }, "ZeroGPT scoring failed; publishing without score");
        await logStep(
          articleId,
          "zerogpt_score",
          "failed",
          `Scoring failed after 3 retries: ${errMsg}. Article will be published without a score.`,
        );
      }
    } else {
      humanizationFailed = true;
      await logStep(
        articleId,
        "zerogpt_humanize",
        "failed",
        "ZEROGPT_API_KEY not configured — article published without humanization or scoring",
      );
    }

    // Step 5: Safety-net checks (keyword density + FAQ count + FAQ uniqueness + heading keywords)
    const primaryDensity = calculateKeywordDensity(finalArticle, article.primaryKeyword);
    const faqCount = extractFAQs(finalArticle).length;
    const faqCountValid = faqCount >= 4 && faqCount <= 8;
    const densityValid =
      primaryDensity >= PRIMARY_DENSITY_TARGET_MIN &&
      primaryDensity <= PRIMARY_DENSITY_TARGET_MAX;
    const faqOverlap = detectFaqBodyOverlap(finalArticle);

    // Re-check headings on the final article (ZeroGPT humanization could have
    // altered headings). The auto-fix already ran before humanization in
    // step 3c — we don't run it again here. We just record current state.
    const headingCheckFinal = checkHeadingKeywords(finalArticle, article.primaryKeyword, article.secondaryKeywords);

    const issues: string[] = [];
    if (!densityValid) {
      issues.push(
        `primary density ${primaryDensity}% (target ${PRIMARY_DENSITY_TARGET_MIN}-${PRIMARY_DENSITY_TARGET_MAX}%)`,
      );
    }
    if (!faqCountValid) issues.push(`FAQ count ${faqCount} (allowed: 4-8)`);
    if (faqOverlap.duplicateIndices.length > 0) {
      issues.push(
        `${faqOverlap.duplicateIndices.length} of ${faqOverlap.total} FAQ(s) duplicate body content (Q${faqOverlap.duplicateIndices.map((i) => i + 1).join(", Q")})`,
      );
    }
    const headingViolationsFinal = summarizeHeadingViolations(headingCheckFinal);
    if (headingViolationsFinal.length > 0) {
      issues.push(...headingViolationsFinal);
    }

    if (issues.length > 0) {
      await logStep(
        articleId,
        "safety_checks",
        "failed",
        `Safety-net violations: ${issues.join("; ")}. Article flagged but still delivered.`,
      );
    } else {
      await logStep(articleId, "safety_checks", "completed", `Density ${primaryDensity}%, FAQs ${faqCount}, no FAQ-body overlap, headings OK`);
    }

    // Step 6: SEO metadata
    await updateArticleStatus(articleId, "formatting");
    await logStep(articleId, "seo_metadata", "running", "Generating SEO metadata");

    const h1Match = finalArticle.match(/^#\s+(.+)$/m);
    const h1Title = h1Match ? h1Match[1].trim() : article.topic;
    const firstBodyParagraph =
      finalArticle
        .split("\n")
        .map((l) => l.trim())
        .find(
          (l) => l.length > 40 && !l.startsWith("#") && !l.startsWith("|") && !l.startsWith("-"),
        ) ?? "";

    const seoPrompt = `Produce SEO metadata for this article.

Article H1: ${h1Title}
Primary keyword: ${article.primaryKeyword}
${article.secondaryKeywords ? `Secondary keywords: ${article.secondaryKeywords}` : ""}
First paragraph: ${firstBodyParagraph.slice(0, 400)}

Requirements:
- "title": 50-60 characters, includes the primary keyword.
- "metaDescription": 140-160 characters, includes the primary keyword.
- "slug": lowercase URL-friendly slug derived from the title, hyphen-separated.
- "tags": comma-separated string of exactly 5 relevant tags.

Respond with a single JSON object and nothing else.`;

    let seoData: { title: string; metaDescription: string; slug: string; tags: string } = {
      title: article.topic,
      metaDescription: "",
      slug: "",
      tags: "",
    };
    try {
      const seoRaw = await callClaude(client, seoPrompt, 512, {
        temperature: 0.2,
        system: `You generate SEO metadata. Return a single valid JSON object with exactly the keys "title", "metaDescription", "slug", "tags".`,
        prefill: "{",
      });
      const jsonMatch = seoRaw.match(/\{[\s\S]*\}/);
      if (jsonMatch) seoData = JSON.parse(jsonMatch[0]);
    } catch {
      logger.warn({ articleId }, "SEO metadata parsing failed, using defaults");
    }
    await logStep(articleId, "seo_metadata", "completed", `Title: ${seoData.title}`);

    // Step 7: Google Docs delivery
    let googleDocUrl: string | undefined;
    let docFileName: string | undefined;

    if (isGoogleDocsConfigured()) {
      await logStep(articleId, "google_docs", "running", "Publishing to Google Docs");
      try {
        const docResult = await publishToGoogleDocs({
          title: seoData.title || article.topic,
          content: finalArticle,
        });
        googleDocUrl = docResult.docUrl;
        docFileName = docResult.fileName;
        await logStep(articleId, "google_docs", "completed", `Published: ${googleDocUrl}`);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.warn({ articleId, err }, "Google Docs publishing failed");
        await logStep(articleId, "google_docs", "failed", `Google Docs error: ${errMsg}`);
      }
    } else {
      await logStep(
        articleId,
        "google_docs",
        "completed",
        "Google Docs not configured — skipped (add GOOGLE_SERVICE_ACCOUNT_JSON to enable)",
      );
    }

    // Step 8: Complete
    await updateArticleStatus(articleId, "completed", {
      title: seoData.title || article.topic,
      articleContent: finalArticle,
      wordCountActual: countWords(finalArticle),
      primaryKeywordDensity: primaryDensity,
      secondaryKeywordDensity: article.secondaryKeywords
        ? calculateKeywordDensity(finalArticle, article.secondaryKeywords.split(",")[0].trim())
        : undefined,
      faqCount,
      zeroGptScore: zeroGptScore ?? undefined,
      humanizationFailed,
      wordCountOutOfBand,
      verifiedSources: verifiedSources.length > 0 ? verifiedSources : undefined,
      citationCount: verifiedCitationCount,
      unverifiedCitationsRemoved: citationStripped,
      seoMetaDescription: seoData.metaDescription,
      seoSlug: seoData.slug || generateSeoSlug(seoData.title, article.primaryKeyword),
      seoTags: seoData.tags,
      completedAt: new Date(),
      googleDocFileName: docFileName ?? undefined,
      googleDocUrl: googleDocUrl ?? undefined,
    });

    logger.info({ articleId, zeroGptScore, humanizationFailed }, "Pipeline completed");
  } catch (err) {
    logger.error({ articleId, err }, "Pipeline failed");
    const errorMessage = err instanceof Error ? err.message : String(err);
    await updateArticleStatus(articleId, "failed", { errorMessage });
    await logStep(articleId, "pipeline", "failed", errorMessage);
  }
}

export { runPipeline };
