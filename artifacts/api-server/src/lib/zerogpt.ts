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
 *   ZEROGPT_PARAPHRASE_TIMEOUT_MS (optional) - base timeout for paraphrase requests
 *                                              in ms. Defaults to 90000.
 *   ZEROGPT_PARAPHRASE_TIMEOUT_PER_WORD_MS (optional) - extra timeout budget per
 *                                              input word. Defaults to 40.
 *   ZEROGPT_PARAPHRASE_TIMEOUT_CAP_MS (optional) - max paraphrase timeout in ms.
 *                                              Defaults to 300000.
 */

const ZEROGPT_API_KEY = process.env.ZEROGPT_API_KEY;
const ZEROGPT_API_BASE_URL = process.env.ZEROGPT_API_BASE_URL ?? "https://api.zerogpt.com";
const ZEROGPT_PARAPHRASE_PATH = process.env.ZEROGPT_PARAPHRASE_PATH ?? "/api/transform/paraphrase";
const ZEROGPT_DETECT_PATH = process.env.ZEROGPT_DETECT_PATH ?? "/api/detect/detectText";
const ZEROGPT_DEFAULT_TONE = process.env.ZEROGPT_DEFAULT_TONE ?? "Standard";
const ZEROGPT_GEN_SPEED_RAW = process.env.ZEROGPT_GEN_SPEED ?? "quick";

const PARAPHRASE_MAX_ATTEMPTS = 3;
const PARAPHRASE_BASE_DELAY_MS = 2000;
const PARAPHRASE_BASE_TIMEOUT_MS = parsePositiveIntEnv("ZEROGPT_PARAPHRASE_TIMEOUT_MS", 90_000);
const PARAPHRASE_TIMEOUT_PER_WORD_MS = parsePositiveIntEnv("ZEROGPT_PARAPHRASE_TIMEOUT_PER_WORD_MS", 40);
const PARAPHRASE_TIMEOUT_CAP_MS = parsePositiveIntEnv("ZEROGPT_PARAPHRASE_TIMEOUT_CAP_MS", 300_000);
const DETECT_MAX_ATTEMPTS = 2;
const DETECT_BASE_DELAY_MS = 1000;
const DETECT_TIMEOUT_MS = 25_000;

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
const VALID_GEN_SPEEDS = new Set(["quick", "thinking"]);

export class ZeroGptError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "ZeroGptError";
  }
}

export function isZeroGptConfigured(): boolean {
  return Boolean(ZEROGPT_API_KEY);
}

function parsePositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) {
    logger.warn({ name, raw, fallback }, "Invalid positive integer env value; using fallback");
    return fallback;
  }
  return value;
}

function normalizeGenSpeed(): "quick" | "thinking" {
  const speed = ZEROGPT_GEN_SPEED_RAW.trim().toLowerCase();
  if (VALID_GEN_SPEEDS.has(speed)) return speed as "quick" | "thinking";
  logger.warn(
    { speed: ZEROGPT_GEN_SPEED_RAW },
    "Invalid ZEROGPT_GEN_SPEED; falling back to quick",
  );
  return "quick";
}

function getParaphraseTimeoutMs(text: string): number {
  const trimmed = text.trim();
  const wordCount = trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;
  const adaptive = PARAPHRASE_BASE_TIMEOUT_MS + wordCount * PARAPHRASE_TIMEOUT_PER_WORD_MS;
  return Math.min(adaptive, PARAPHRASE_TIMEOUT_CAP_MS);
}

function toErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new ZeroGptError(`ZeroGPT request timed out after ${timeoutMs}ms`, err);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
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
  const safeGenSpeed = normalizeGenSpeed();
  const paraphraseTimeoutMs = getParaphraseTimeoutMs(text);

  const url = `${ZEROGPT_API_BASE_URL}${ZEROGPT_PARAPHRASE_PATH}`;
  let lastErr: unknown;

  for (let attempt = 1; attempt <= PARAPHRASE_MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetchWithTimeout(
        url,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ApiKey: ZEROGPT_API_KEY,
          },
          body: JSON.stringify({
            string: text,
            tone: safeTone,
            skipRealtime: 1,           // do NOT use websocket (we're synchronous)
            gen_speed: safeGenSpeed,
          }),
        },
        paraphraseTimeoutMs,
      );

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
      const isLastAttempt = attempt === PARAPHRASE_MAX_ATTEMPTS;
      if (isLastAttempt) break;
      const delay = PARAPHRASE_BASE_DELAY_MS * Math.pow(2, attempt - 1);
      logger.warn(
        { err, attempt, delay, tone: safeTone, genSpeed: safeGenSpeed, timeoutMs: paraphraseTimeoutMs },
        `ZeroGPT paraphrase attempt ${attempt} failed; retrying in ${delay}ms`,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  const detail = toErrorMessage(lastErr);
  throw new ZeroGptError(
    `ZeroGPT paraphrase failed after ${PARAPHRASE_MAX_ATTEMPTS} attempts (last error: ${detail})`,
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

  for (let attempt = 1; attempt <= DETECT_MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetchWithTimeout(
        url,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ApiKey: ZEROGPT_API_KEY,
          },
          body: JSON.stringify({ input_text: text }),
        },
        DETECT_TIMEOUT_MS,
      );

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
      const isLastAttempt = attempt === DETECT_MAX_ATTEMPTS;
      if (isLastAttempt) break;
      const delay = DETECT_BASE_DELAY_MS * Math.pow(2, attempt - 1);
      logger.warn(
        { err, attempt, delay },
        `ZeroGPT detect attempt ${attempt} failed; retrying in ${delay}ms`,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  throw new ZeroGptError(
    `ZeroGPT detect failed after ${DETECT_MAX_ATTEMPTS} attempts`,
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
