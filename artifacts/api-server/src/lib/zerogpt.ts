import { logger } from "./logger";

/**
 * ZeroGPT Business API client.
 *
 * Wire format verified against the official docs at app.theneo.io/olive-works-llc/zerogpt-docs:
 *   - Base URL: https://api.zerogpt.com
 *   - Auth header: "ApiKey: <key>" (NOT "Authorization: Bearer <key>")
 *   - Paraphrase: POST /api/transform/paraphrase
 *       Body: { string, tone, skipRealtime, wsId?, gen_speed? }
 *       Response: { success, code, message, data: { message: "<paraphrased text>" } }
 *   - Detect:    POST /api/detect/detectText
 *       Body: { input_text }
 *       Response: { success, code, message, data: { is_gpt_generated, ... } }
 *
 * Note: ZeroGPT calls humanization "Paraphrase" in their API. The Paraphraser
 * is the same product feature that's called "Humanizer" on their consumer site.
 * We expose `humanizeText()` here as the public name to keep pipeline code
 * agnostic to ZeroGPT's internal naming.
 *
 * Configuration via environment variables:
 *   ZEROGPT_API_KEY            (required) - API key from api.zerogpt.com dashboard
 *   ZEROGPT_API_BASE_URL       (optional) - defaults to https://api.zerogpt.com
 *   ZEROGPT_PARAPHRASE_PATH    (optional) - defaults to /api/transform/paraphrase
 *   ZEROGPT_DETECT_PATH        (optional) - defaults to /api/detect/detectText
 *   ZEROGPT_DEFAULT_TONE       (optional) - default ZeroGPT tone preset when the
 *                                           user's free-text tone doesn't map to
 *                                           a ZeroGPT preset. Defaults to "Standard".
 *   ZEROGPT_GEN_SPEED          (optional) - "quick" (default) or "thinking" (VIP only)
 */

const ZEROGPT_API_KEY = process.env.ZEROGPT_API_KEY;
const ZEROGPT_API_BASE_URL = process.env.ZEROGPT_API_BASE_URL ?? "https://api.zerogpt.com";
const ZEROGPT_PARAPHRASE_PATH = process.env.ZEROGPT_PARAPHRASE_PATH ?? "/api/transform/paraphrase";
const ZEROGPT_DETECT_PATH = process.env.ZEROGPT_DETECT_PATH ?? "/api/detect/detectText";
const ZEROGPT_DEFAULT_TONE = process.env.ZEROGPT_DEFAULT_TONE ?? "Standard";
const ZEROGPT_GEN_SPEED = process.env.ZEROGPT_GEN_SPEED ?? "quick";

const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 2000;

/**
 * Valid tone values accepted by ZeroGPT's paraphraser, per their docs.
 * Anything outside this set will be rejected with a 422 by the API.
 */
const VALID_ZEROGPT_TONES = new Set([
  "Standard",
  "Academic",
  "Fluent",
  "Formal",
  "Simple",
  "Creative",
  "Engineer",
  "Doctor",
  "Lawyer",
  "Teenager",
]);

export class ZeroGptError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "ZeroGptError";
  }
}

export function isZeroGptConfigured(): boolean {
  return Boolean(ZEROGPT_API_KEY);
}

/**
 * Map a user's free-text tone field to one of ZeroGPT's 10 valid tone presets.
 *
 * The user types whatever they want into the article form's tone field
 * ("Authoritative expert", "Friendly and warm", "Technical, precise"). ZeroGPT
 * only accepts a fixed set of tone strings. We do simple keyword matching:
 * find the first ZeroGPT tone whose keyword set matches the user's text. If
 * nothing matches, fall back to the default (configurable via env var,
 * "Standard" out of the box).
 *
 * Honors user intent without forcing them to learn ZeroGPT's vocabulary, and
 * stays predictable: the same input always produces the same mapping.
 */
export function mapToneToZeroGpt(userTone: string | null | undefined): string {
  if (!userTone || typeof userTone !== "string") return ZEROGPT_DEFAULT_TONE;
  const lower = userTone.toLowerCase();

  // Order matters — the first match wins. Put more specific matches first
  // so "academic" doesn't get caught by the broader "formal" check.
  const mappings: { keywords: string[]; tone: string }[] = [
    { keywords: ["academic", "scholarly", "research", "scientific"], tone: "Academic" },
    { keywords: ["engineer", "technical", "developer"], tone: "Engineer" },
    { keywords: ["doctor", "medical", "clinical"], tone: "Doctor" },
    { keywords: ["lawyer", "legal", "attorney"], tone: "Lawyer" },
    { keywords: ["teen", "teenager", "youth", "young"], tone: "Teenager" },
    { keywords: ["creative", "playful", "imaginative", "artistic"], tone: "Creative" },
    { keywords: ["formal", "authoritative", "professional", "expert", "business"], tone: "Formal" },
    { keywords: ["fluent", "casual", "friendly", "conversational", "warm", "approachable"], tone: "Fluent" },
    { keywords: ["simple", "plain", "easy", "beginner", "basic"], tone: "Simple" },
    { keywords: ["standard", "neutral", "default", "general"], tone: "Standard" },
  ];

  for (const { keywords, tone } of mappings) {
    if (keywords.some((kw) => lower.includes(kw))) return tone;
  }

  return ZEROGPT_DEFAULT_TONE;
}

/**
 * Send text to ZeroGPT's paraphraser endpoint. Returns the paraphrased text or
 * throws ZeroGptError after exhausting retries.
 *
 * @param text - the article text to paraphrase
 * @param userTone - optional free-text tone from the article form. Will be
 *   mapped to one of ZeroGPT's 10 preset tones via mapToneToZeroGpt().
 */
export async function humanizeText(
  text: string,
  userTone?: string | null,
): Promise<string> {
  if (!ZEROGPT_API_KEY) {
    throw new ZeroGptError("ZEROGPT_API_KEY is not configured");
  }

  const tone = mapToneToZeroGpt(userTone);
  if (!VALID_ZEROGPT_TONES.has(tone)) {
    // Defensive: should never happen since mapToneToZeroGpt only returns valid
    // values, but if env var ZEROGPT_DEFAULT_TONE is misconfigured we'd hit
    // this. Fall back to "Standard" to keep the call alive.
    logger.warn({ tone }, "Mapped tone is not a valid ZeroGPT preset; using Standard");
  }
  const safeTone = VALID_ZEROGPT_TONES.has(tone) ? tone : "Standard";

  const url = `${ZEROGPT_API_BASE_URL}${ZEROGPT_PARAPHRASE_PATH}`;
  let lastErr: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ApiKey: ZEROGPT_API_KEY,
        },
        body: JSON.stringify({
          string: text,
          tone: safeTone,
          skipRealtime: 1,           // do NOT use websocket (we're synchronous)
          gen_speed: ZEROGPT_GEN_SPEED,
        }),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "<unreadable>");
        throw new ZeroGptError(
          `ZeroGPT paraphrase returned ${response.status}: ${body.slice(0, 300)}`,
        );
      }

      const json = (await response.json()) as unknown;

      // Verified shape: { success, code, message, data: { message: "<text>" } }
      // The paraphrased text lives at data.message. We also defend against the
      // top-level success flag being false even on 200 responses.
      if (!isObjectLike(json)) {
        throw new ZeroGptError("ZeroGPT paraphrase response was not a JSON object");
      }
      if (json.success === false) {
        throw new ZeroGptError(
          `ZeroGPT paraphrase reported failure: ${typeof json.message === "string" ? json.message : "unknown"}`,
        );
      }

      const paraphrased = extractParaphrased(json);
      if (!paraphrased || paraphrased.trim().length === 0) {
        throw new ZeroGptError("ZeroGPT paraphrase returned empty text");
      }
      return paraphrased;
    } catch (err) {
      lastErr = err;
      const isLastAttempt = attempt === MAX_ATTEMPTS;
      if (isLastAttempt) break;
      const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
      logger.warn(
        { err, attempt, delay, tone: safeTone },
        `ZeroGPT paraphrase attempt ${attempt} failed; retrying in ${delay}ms`,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  throw new ZeroGptError(
    `ZeroGPT paraphrase failed after ${MAX_ATTEMPTS} attempts`,
    lastErr,
  );
}

/**
 * Send text to ZeroGPT's AI-detection endpoint. Returns the AI-generated
 * percentage (0-100) or throws ZeroGptError after exhausting retries.
 */
export async function scoreAiContent(text: string): Promise<number> {
  if (!ZEROGPT_API_KEY) {
    throw new ZeroGptError("ZEROGPT_API_KEY is not configured");
  }

  const url = `${ZEROGPT_API_BASE_URL}${ZEROGPT_DETECT_PATH}`;
  let lastErr: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ApiKey: ZEROGPT_API_KEY,
        },
        body: JSON.stringify({ input_text: text }),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "<unreadable>");
        throw new ZeroGptError(
          `ZeroGPT detect returned ${response.status}: ${body.slice(0, 300)}`,
        );
      }

      const json = (await response.json()) as unknown;
      if (!isObjectLike(json)) {
        throw new ZeroGptError("ZeroGPT detect response was not a JSON object");
      }
      if (json.success === false) {
        throw new ZeroGptError(
          `ZeroGPT detect reported failure: ${typeof json.message === "string" ? json.message : "unknown"}`,
        );
      }

      const score = extractAiScore(json);
      if (score === null) {
        throw new ZeroGptError("ZeroGPT detect response missing AI score");
      }
      return score;
    } catch (err) {
      lastErr = err;
      const isLastAttempt = attempt === MAX_ATTEMPTS;
      if (isLastAttempt) break;
      const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
      logger.warn(
        { err, attempt, delay },
        `ZeroGPT detect attempt ${attempt} failed; retrying in ${delay}ms`,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  throw new ZeroGptError(
    `ZeroGPT detect failed after ${MAX_ATTEMPTS} attempts`,
    lastErr,
  );
}

// ─── Response parsers ─────────────────────────────────────────────────────────

function isObjectLike(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/**
 * Extract paraphrased text from a ZeroGPT paraphrase response.
 * Verified shape per docs: { data: { message: "<text>" } }.
 * The fallback paths exist defensively in case ZeroGPT changes the response
 * shape or returns variants on different tiers.
 */
function extractParaphrased(json: Record<string, unknown>): string {
  const data = isObjectLike(json.data) ? json.data : null;
  if (data) {
    if (typeof data.message === "string") return data.message;
    if (typeof data.paraphrased === "string") return data.paraphrased;
    if (typeof data.output === "string") return data.output;
    if (typeof data.text === "string") return data.text;
    if (typeof data.result === "string") return data.result;
  }
  if (typeof json.message === "string" && json.message.length > 100) return json.message;
  return "";
}

/**
 * Extract AI-detection score from a ZeroGPT detect response.
 * Per the public ZeroGPT detect docs, the field is `is_gpt_generated`,
 * a 0-100 integer. Defensive fallbacks for adjacent field names.
 */
function extractAiScore(json: Record<string, unknown>): number | null {
  const data = isObjectLike(json.data) ? json.data : null;
  if (data) {
    if (typeof data.is_gpt_generated === "number") return data.is_gpt_generated;
    if (typeof data.fakePercentage === "number") return data.fakePercentage;
    if (typeof data.ai_percentage === "number") return data.ai_percentage;
    if (typeof data.ai_score === "number") return data.ai_score;
  }
  return null;
}
