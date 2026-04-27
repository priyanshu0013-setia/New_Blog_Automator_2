import Anthropic from "@anthropic-ai/sdk";
import { logger } from "./logger";

/**
 * Source gathering via Claude's web_search tool.
 *
 * Strategy:
 *   - Build 3-5 search queries from topic + primary keyword + secondary keywords
 *   - For each query, run a web_search tool call
 *   - Extract URL, title, and snippet from each result
 *   - Deduplicate by domain root (no more than 1 source per domain to broaden coverage)
 *   - Return a structured list the writing step can constrain itself to
 *
 * The list is the ONLY allowed citation pool for the writing step. Anything the
 * writing step claims with attribution must match a URL or title from this list.
 * The verification step (extractCitations + verifyCitations) checks this after.
 */

export interface VerifiedSource {
  url: string;
  title: string;
  snippet: string;
  publishedDate?: string;
  domain: string;
}

const SEARCH_MODEL = "claude-opus-4-5";
const MAX_SEARCH_QUERIES = 5;
const MAX_SOURCES_PER_QUERY = 5;
const MAX_TOTAL_SOURCES = 15;

/**
 * Build a small set of focused search queries from the article inputs.
 * Mixes broad topical queries with keyword-specific ones to surface both
 * authoritative overviews and concrete data sources.
 */
function buildSearchQueries(
  topic: string,
  primaryKeyword: string,
  secondaryKeywords: string | null,
): string[] {
  const queries: string[] = [];

  // Query 1: the topic verbatim — surfaces overviews and authoritative pieces
  queries.push(topic);

  // Query 2: primary keyword + "study" or "data" — surfaces research/statistics
  queries.push(`${primaryKeyword} study data statistics`);

  // Query 3: primary keyword + "guide" — surfaces explainers/practitioners
  queries.push(`${primaryKeyword} guide best practices`);

  // Query 4: secondary keywords (if provided) for coverage
  if (secondaryKeywords) {
    const firstSecondary = secondaryKeywords.split(",")[0]?.trim();
    if (firstSecondary) queries.push(`${firstSecondary} ${primaryKeyword}`);
  }

  // Query 5: recent news / developments
  const currentYear = new Date().getFullYear();
  queries.push(`${primaryKeyword} ${currentYear}`);

  return queries.slice(0, MAX_SEARCH_QUERIES);
}

function extractDomainRoot(url: string): string {
  try {
    const parsed = new URL(url);
    const parts = parsed.hostname.split(".");
    // "blog.example.com" → "example.com", "example.co.uk" → "example.co.uk"
    if (parts.length >= 3 && parts[parts.length - 2].length <= 3) {
      return parts.slice(-3).join(".");
    }
    return parts.slice(-2).join(".");
  } catch {
    return url;
  }
}

/**
 * Run a single web_search tool call and extract a list of VerifiedSource entries
 * from Claude's response. Claude's web_search tool returns search results inline
 * in its message content; we look for tool_use / tool_result content blocks and
 * parse the structured payload.
 *
 * If anything goes wrong (network, tool unavailable, malformed response) we
 * return an empty array and log — the caller treats source gathering as
 * best-effort and can proceed with whatever sources it managed to collect.
 */
async function runSingleSearch(
  client: Anthropic,
  query: string,
): Promise<VerifiedSource[]> {
  try {
    const response = await client.messages.create({
      model: SEARCH_MODEL,
      max_tokens: 2048,
      tools: [
        {
          type: "web_search_20250305" as const,
          name: "web_search",
          // The cast above is to handle SDK type differences across versions;
          // the underlying tool name and request shape are stable.
        } as unknown as Anthropic.Tool,
      ],
      messages: [
        {
          role: "user",
          content: `Search the web for: ${query}\n\nReturn relevant, authoritative sources. Prioritize peer-reviewed studies, established publications, and primary sources over aggregator sites.`,
        },
      ],
    });

    // Claude's web_search results land in tool_result content blocks. The SDK
    // surfaces these as content items with type "tool_result" or, in some
    // versions, as embedded structured content within tool_use blocks.
    // We walk the entire response defensively because the schema has shifted
    // between SDK versions.
    const sources: VerifiedSource[] = [];

    for (const block of response.content) {
      // Look for any block that contains an array of search results.
      const possibleResults = (block as unknown as Record<string, unknown>);

      // The web_search tool typically returns results under a `content` field
      // when delivered as a tool_result, or under a `web_search_result` field
      // depending on the SDK version. Check both.
      const candidates: unknown[] = [];

      if (Array.isArray(possibleResults.content)) {
        candidates.push(...possibleResults.content);
      }
      if (Array.isArray(possibleResults.web_search_result)) {
        candidates.push(...possibleResults.web_search_result);
      }
      if (Array.isArray(possibleResults.results)) {
        candidates.push(...possibleResults.results);
      }

      for (const candidate of candidates) {
        if (!candidate || typeof candidate !== "object") continue;
        const c = candidate as Record<string, unknown>;
        const url = typeof c.url === "string" ? c.url : null;
        const title = typeof c.title === "string" ? c.title : null;
        const snippet =
          (typeof c.snippet === "string" && c.snippet) ||
          (typeof c.text === "string" && c.text) ||
          (typeof c.content === "string" && c.content) ||
          "";
        const publishedDate =
          typeof c.published_date === "string"
            ? c.published_date
            : typeof c.date === "string"
              ? c.date
              : undefined;

        if (url && title) {
          sources.push({
            url,
            title,
            snippet: typeof snippet === "string" ? snippet.slice(0, 500) : "",
            publishedDate,
            domain: extractDomainRoot(url),
          });
        }
      }
    }

    return sources.slice(0, MAX_SOURCES_PER_QUERY);
  } catch (err) {
    logger.warn({ err, query }, "Web search failed for query; continuing with other queries");
    return [];
  }
}

/**
 * Gather sources for an article. Best-effort — partial success is fine.
 * Returns an empty array if all queries fail; the pipeline will then proceed
 * without verified sources and the writing step will skip citation entirely.
 */
export async function gatherVerifiedSources(
  client: Anthropic,
  topic: string,
  primaryKeyword: string,
  secondaryKeywords: string | null,
): Promise<VerifiedSource[]> {
  const queries = buildSearchQueries(topic, primaryKeyword, secondaryKeywords);
  const allSources: VerifiedSource[] = [];

  // Run searches sequentially rather than in parallel — Claude API rate limits
  // are friendlier to sequential, and the latency cost of 5 sequential calls
  // is acceptable for a research step.
  for (const query of queries) {
    const found = await runSingleSearch(client, query);
    allSources.push(...found);
  }

  // Deduplicate by URL, then cap one source per domain to broaden coverage.
  // (A topic that searches all return links from the same site will produce
  // articles that lean too heavily on one source.)
  const seenUrls = new Set<string>();
  const seenDomains = new Set<string>();
  const deduped: VerifiedSource[] = [];

  for (const src of allSources) {
    if (seenUrls.has(src.url)) continue;
    if (seenDomains.has(src.domain) && deduped.length >= 5) continue;
    seenUrls.add(src.url);
    seenDomains.add(src.domain);
    deduped.push(src);
    if (deduped.length >= MAX_TOTAL_SOURCES) break;
  }

  return deduped;
}

/**
 * Extract citations the model produced in an article. We look for several
 * citation shapes:
 *   - Inline URLs (https://...)
 *   - Markdown links [text](url)
 *   - Named-study mentions like "a 2024 Ahrefs study", "Gartner reports that"
 *   - Domain references like "according to nytimes.com"
 *
 * We return both URL-based and named-source citations. The verification step
 * matches each against the verified source list.
 */
export interface ExtractedCitation {
  raw: string;
  type: "url" | "named-source";
  url?: string;
  domain?: string;
  namedSource?: string;
}

export function extractCitations(article: string): ExtractedCitation[] {
  const citations: ExtractedCitation[] = [];

  // (1) Markdown links [text](url)
  const mdLinkRe = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = mdLinkRe.exec(article)) !== null) {
    citations.push({
      raw: m[0],
      type: "url",
      url: m[2],
      domain: extractDomainRoot(m[2]),
    });
  }

  // (2) Bare URLs not already captured by markdown links
  const bareUrlRe = /(?<!\]\()https?:\/\/[^\s)\]]+/g;
  while ((m = bareUrlRe.exec(article)) !== null) {
    const url = m[0].replace(/[.,;:!?]+$/, ""); // strip trailing punctuation
    // Skip if this URL already came in via a markdown link
    if (citations.some((c) => c.url === url)) continue;
    citations.push({
      raw: url,
      type: "url",
      url,
      domain: extractDomainRoot(url),
    });
  }

  // (3) Named-source patterns. We're conservative — only flag patterns that
  //     clearly assert a specific source. Generic "studies show" doesn't count;
  //     "a 2024 Ahrefs study" does.
  //     Format catches: "a YEAR ORG study/report/survey/analysis"
  const namedStudyRe =
    /\b(?:a|the|this)\s+(\d{4})\s+([A-Z][A-Za-z0-9&.\- ]{1,40})\s+(study|report|survey|analysis|paper|whitepaper|review|investigation)\b/g;
  while ((m = namedStudyRe.exec(article)) !== null) {
    const org = m[2].trim();
    citations.push({
      raw: m[0],
      type: "named-source",
      namedSource: `${org} ${m[3]} (${m[1]})`,
    });
  }

  // (4) "According to ORG" patterns where ORG is a Capitalized name.
  const accordingToRe =
    /\b[Aa]ccording to\s+([A-Z][A-Za-z0-9&.\- ]{2,50}?)(?=[,.\s])/g;
  while ((m = accordingToRe.exec(article)) !== null) {
    const org = m[1].trim();
    // Skip if it's a generic word like "researchers", "experts", "sources"
    if (/^(researchers|experts|sources|reports|industry|observers|analysts)$/i.test(org)) continue;
    citations.push({
      raw: m[0],
      type: "named-source",
      namedSource: org,
    });
  }

  return citations;
}

/**
 * Check each extracted citation against the verified source list.
 *
 * URL citations match if either the full URL or the domain root appears in the
 * verified list.
 *
 * Named-source citations match if the named org appears (case-insensitive) in
 * any verified source's title, URL, or snippet. This is permissive on purpose:
 * citations like "Ahrefs found that..." count as verified if the verified list
 * has a result from ahrefs.com OR a result whose snippet mentions Ahrefs.
 *
 * Returns the citations that did NOT match anything in the verified list.
 */
export function verifyCitations(
  extracted: ExtractedCitation[],
  verifiedSources: VerifiedSource[],
): ExtractedCitation[] {
  if (verifiedSources.length === 0) {
    // No verified list means we can't verify anything; return all citations
    // as unverified (caller decides what to do).
    return [...extracted];
  }

  const unverified: ExtractedCitation[] = [];

  const verifiedUrls = new Set(verifiedSources.map((s) => s.url.toLowerCase()));
  const verifiedDomains = new Set(verifiedSources.map((s) => s.domain.toLowerCase()));
  const verifiedHaystack = verifiedSources
    .map((s) => `${s.title}\n${s.url}\n${s.snippet}`.toLowerCase())
    .join("\n---\n");

  for (const cite of extracted) {
    if (cite.type === "url" && cite.url) {
      const urlLower = cite.url.toLowerCase();
      const domainLower = (cite.domain ?? "").toLowerCase();
      if (verifiedUrls.has(urlLower)) continue;
      if (domainLower && verifiedDomains.has(domainLower)) continue;
      unverified.push(cite);
      continue;
    }
    if (cite.type === "named-source" && cite.namedSource) {
      // Pull the org out; for "Ahrefs study (2024)" the first word is the org
      const firstToken = cite.namedSource.split(/\s+/)[0].toLowerCase();
      if (firstToken.length < 3) {
        unverified.push(cite);
        continue;
      }
      if (verifiedHaystack.includes(firstToken)) continue;
      unverified.push(cite);
    }
  }

  return unverified;
}

/**
 * Strip unverified citations from an article. We use targeted regex
 * substitutions rather than asking the model to rewrite, because the user
 * specifically asked for "remove the source" — surgical removal is more
 * predictable than a full rewrite pass.
 *
 * Strategy:
 *   - For URL citations: remove the URL (or the markdown link wrapper, keeping
 *     the link text) and any orphan parens left behind.
 *   - For named-source citations: remove the matched phrase. If removing it
 *     would leave a sentence ungrammatical, we collapse the surrounding
 *     whitespace and let the next humanization pass smooth it out. (Not perfect
 *     but predictable.)
 *
 * Returns the cleaned article + a count of how many citations were stripped.
 */
export function stripUnverifiedCitations(
  article: string,
  unverified: ExtractedCitation[],
): { article: string; stripped: number } {
  let result = article;
  let stripped = 0;

  for (const cite of unverified) {
    if (cite.type === "url" && cite.url) {
      // Markdown link: "[text](url)" → "text"
      const mdEscaped = cite.url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const mdLinkRe = new RegExp(`\\[([^\\]]+)\\]\\(${mdEscaped}\\)`, "g");
      const beforeMd = result;
      result = result.replace(mdLinkRe, "$1");
      if (result !== beforeMd) {
        stripped++;
        continue;
      }

      // Bare URL: remove the URL and any " (url)" wrapper or surrounding parens
      const bareEscaped = cite.url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const bareUrlRe = new RegExp(`\\s*\\(?${bareEscaped}\\)?`, "g");
      const beforeBare = result;
      result = result.replace(bareUrlRe, "");
      if (result !== beforeBare) stripped++;
    } else if (cite.type === "named-source") {
      const escaped = cite.raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(escaped, "g");
      const before = result;
      result = result.replace(re, "");
      if (result !== before) stripped++;
    }
  }

  // Tidy up: collapse double spaces, double commas, orphan parens
  result = result
    .replace(/\(\s*\)/g, "")
    .replace(/\s+,/g, ",")
    .replace(/,,+/g, ",")
    .replace(/[ \t]+/g, " ")
    .replace(/ +([.,;!?])/g, "$1");

  return { article: result, stripped };
}
