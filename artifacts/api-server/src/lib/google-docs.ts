import { google } from "googleapis";
import { logger } from "./logger";

const GOOGLE_SERVICE_ACCOUNT_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
const GOOGLE_DRIVE_FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID;

export function isGoogleDocsConfigured(): boolean {
  return !!GOOGLE_SERVICE_ACCOUNT_JSON;
}

function getGoogleAuthClient() {
  if (!GOOGLE_SERVICE_ACCOUNT_JSON) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON environment variable is not set.");
  }
  let credentials: object;
  try {
    credentials = JSON.parse(GOOGLE_SERVICE_ACCOUNT_JSON);
  } catch {
    throw new Error(
      "GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON. Please provide the full service account key file content.",
    );
  }
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: [
      "https://www.googleapis.com/auth/documents",
      "https://www.googleapis.com/auth/drive.file",
    ],
  });
  return auth;
}

// ─── Sequential naming: query Drive folder for highest NN_ number ─────────────

async function getNextSequentialNumber(
  driveClient: ReturnType<typeof google.drive>,
): Promise<number> {
  if (!GOOGLE_DRIVE_FOLDER_ID) return 1;
  try {
    const res = await driveClient.files.list({
      q: `'${GOOGLE_DRIVE_FOLDER_ID}' in parents and trashed = false`,
      fields: "files(name)",
      pageSize: 1000,
    });
    const files = res.data.files ?? [];
    let maxNum = 0;
    for (const file of files) {
      const match = file.name?.match(/^(\d{2})_/);
      if (match) {
        const n = parseInt(match[1], 10);
        if (n > maxNum) maxNum = n;
      }
    }
    return maxNum + 1;
  } catch (err) {
    logger.warn({ err }, "Could not list Drive folder files — defaulting to sequence 1");
    return 1;
  }
}

// ─── Markdown parsing ─────────────────────────────────────────────────────────

interface ParsedSegment {
  type: "h1" | "h2" | "h3" | "bullet" | "normal" | "bold_text" | "faq_question" | "faq_answer" | "blank";
  text: string;
}

interface TableSegment {
  type: "table";
  headers: string[];
  rows: string[][];
}

type Segment = ParsedSegment | TableSegment;

function parseTableRow(raw: string): string[] {
  return raw
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function stripBold(text: string): string {
  return text.replace(/\*\*(.*?)\*\*/g, "$1");
}

function parseContent(content: string): Segment[] {
  const lines = content.split("\n");
  const segments: Segment[] = [];
  let i = 0;
  let inFaqSection = false;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      segments.push({ type: "blank", text: "" });
      i++;
      continue;
    }

    if (/^#\s+/.test(line)) {
      segments.push({ type: "h1", text: line.replace(/^#\s+/, "").trim() });
      i++;
      continue;
    }

    if (/^##\s+/.test(line)) {
      const heading = line.replace(/^##\s+/, "").trim();
      if (/FAQ|Frequently Asked Questions|Common Questions/i.test(heading)) {
        inFaqSection = true;
      }
      segments.push({ type: "h2", text: heading });
      i++;
      continue;
    }

    if (/^###\s+/.test(line)) {
      segments.push({ type: "h3", text: line.replace(/^###\s+/, "").trim() });
      i++;
      continue;
    }

    if (/^\s*[-*]\s+/.test(line)) {
      segments.push({ type: "bullet", text: stripBold(line.replace(/^\s*[-*]\s+/, "").trim()) });
      i++;
      continue;
    }

    if (/^\|.+\|$/.test(trimmed)) {
      if (/^\|[-|:\s]+\|$/.test(trimmed)) {
        i++;
        continue;
      }
      const headers = parseTableRow(trimmed);
      i++;
      if (i < lines.length && /^\|[-|:\s]+\|$/.test(lines[i].trim())) i++;
      const rows: string[][] = [];
      while (i < lines.length && /^\|.+\|$/.test(lines[i].trim())) {
        rows.push(parseTableRow(lines[i].trim()));
        i++;
      }
      segments.push({ type: "table", headers, rows });
      continue;
    }

    if (inFaqSection && /^(?:\*\*)?\s*Q(?:uestion)?\s*\d+\s*[:.]/i.test(trimmed)) {
      segments.push({ type: "faq_question", text: stripBold(trimmed) });
      i++;
      continue;
    }

    if (inFaqSection && segments.length > 0 && segments[segments.length - 1].type === "faq_question") {
      segments.push({ type: "faq_answer", text: stripBold(trimmed) });
      i++;
      continue;
    }

    segments.push({ type: "normal", text: trimmed });
    i++;
  }

  return segments;
}

// ─── Build Google Docs API requests ──────────────────────────────────────────
// Strategy:
//   Pass 1 — insert all NON-table text (top to bottom), tracking table insertion points
//   Pass 2 — insert tables (bottom to top) so earlier indices stay valid when
//             later tables are inserted first; fill each cell in reverse order

interface TablePlaceholder {
  insertionIndex: number;
  headers: string[];
  rows: string[][];
}

type DocRequest = Record<string, unknown>;

const H1_FONT_PT = 14;
const H2_FONT_PT = 12;
const H3_FONT_PT = 12;
const BODY_FONT_PT = 11;
// Google Docs lineSpacing uses percentage-like values (150 = 1.5 line spacing).
const BODY_LINE_SPACING = 150;
const BODY_PARAGRAPH_SPACE_BELOW_PT = 11;

function applyTextStyle(
  requests: DocRequest[],
  startIndex: number,
  endIndex: number,
  opts: { bold?: boolean; fontSize?: number; italic?: boolean },
) {
  if (startIndex >= endIndex) return;
  const fields: string[] = [];
  const textStyle: Record<string, unknown> = {};
  if (opts.bold !== undefined) {
    textStyle["bold"] = opts.bold;
    fields.push("bold");
  }
  if (opts.fontSize !== undefined) {
    textStyle["fontSize"] = { magnitude: opts.fontSize, unit: "PT" };
    fields.push("fontSize");
  }
  if (opts.italic !== undefined) {
    textStyle["italic"] = opts.italic;
    fields.push("italic");
  }
  requests.push({
    updateTextStyle: {
      range: { startIndex, endIndex },
      textStyle,
      fields: fields.join(","),
    },
  });
}

function applyParagraphSpacing(
  requests: DocRequest[],
  startIndex: number,
  endIndex: number,
) {
  if (startIndex >= endIndex) return;
  requests.push({
    updateParagraphStyle: {
      range: { startIndex, endIndex },
      paragraphStyle: {
        lineSpacing: BODY_LINE_SPACING,
        spaceBelow: { magnitude: BODY_PARAGRAPH_SPACE_BELOW_PT, unit: "PT" },
      },
      fields: "lineSpacing,spaceBelow",
    },
  });
}

function buildDocRequests(content: string): {
  textRequests: DocRequest[];
  tablePlaceholders: TablePlaceholder[];
} {
  const segments = parseContent(content);
  const textRequests: DocRequest[] = [];
  const tablePlaceholders: TablePlaceholder[] = [];
  let cursor = 1;

  const insertLine = (
    text: string,
    style?: string,
    bold?: boolean,
    fontSize?: number,
  ) => {
    const line = text.endsWith("\n") ? text : text + "\n";
    textRequests.push({
      insertText: { location: { index: cursor }, text: line },
    });
    const len = line.length;

    if (style) {
      textRequests.push({
        updateParagraphStyle: {
          range: { startIndex: cursor, endIndex: cursor + len },
          paragraphStyle: { namedStyleType: style },
          fields: "namedStyleType",
        },
      });
    }

    applyParagraphSpacing(textRequests, cursor, cursor + len);

    if (bold || fontSize) {
      applyTextStyle(textRequests, cursor, cursor + len - 1, {
        bold,
        fontSize,
      });
    }

    cursor += len;
  };

  for (const seg of segments) {
    if (seg.type === "blank") continue;

    if (seg.type === "table") {
      tablePlaceholders.push({
        insertionIndex: cursor,
        headers: seg.headers,
        rows: seg.rows,
      });
      continue;
    }

    switch (seg.type) {
      case "h1":
        insertLine(seg.text, "HEADING_1", true, H1_FONT_PT);
        break;
      case "h2":
        insertLine(seg.text, "HEADING_2", true, H2_FONT_PT);
        break;
      case "h3":
        insertLine(seg.text, "HEADING_3", true, H3_FONT_PT);
        break;
      case "bullet": {
        const bulletText = seg.text + "\n";
        textRequests.push({
          insertText: { location: { index: cursor }, text: bulletText },
        });
        const len = bulletText.length;
        textRequests.push({
          createParagraphBullets: {
            range: { startIndex: cursor, endIndex: cursor + len },
            bulletPreset: "BULLET_DISC_CIRCLE_SQUARE",
          },
        });
        applyParagraphSpacing(textRequests, cursor, cursor + len);
        applyTextStyle(textRequests, cursor, cursor + len - 1, {
          fontSize: BODY_FONT_PT,
        });
        cursor += len;
        break;
      }
      case "faq_question":
        insertLine(seg.text, undefined, true, BODY_FONT_PT);
        break;
      case "faq_answer":
        insertLine(seg.text, undefined, false, BODY_FONT_PT);
        break;
      case "bold_text":
        insertLine(seg.text, undefined, true, BODY_FONT_PT);
        break;
      default:
        insertLine(seg.text, undefined, false, BODY_FONT_PT);
        break;
    }
  }

  return { textRequests, tablePlaceholders };
}

// ─── Table requests ────────────────────────────────────────────────────────────
// Tables must be inserted AFTER the main text is in place so we know exact indices.
// We insert them from BOTTOM to TOP so earlier table indices are not shifted.
//
// Empty table structure at insertionIndex I with R rows and C columns:
//   I + 0              : table element
//   I + 1              : row 0 element
//   I + 2              : cell(0,0) element
//   I + 3              : cell(0,0) mandatory empty paragraph ("\n")
//   I + 4              : cell(0,1) element
//   I + 5              : cell(0,1) paragraph
//   ...
//   cell(r,c) paragraph = I + 1 + r*(C*2+2) + 1 + c*2 + 1
//                       = I + 3 + r*(C*2+2) + c*2

function cellParagraphIndex(tableIndex: number, r: number, c: number, numCols: number): number {
  return tableIndex + 3 + r * (numCols * 2 + 2) + c * 2;
}

function totalTableSize(numRows: number, numCols: number): number {
  return 2 + numRows * (numCols * 2 + 2);
}

function buildTableRequests(
  placeholder: TablePlaceholder,
  offsetFromPriorTables: number,
): DocRequest[] {
  const { headers, rows } = placeholder;
  const insertionIndex = placeholder.insertionIndex + offsetFromPriorTables;
  const allRows = [headers, ...rows];
  const numRows = allRows.length;
  const numCols = headers.length;

  const requests: DocRequest[] = [];

  requests.push({
    insertTable: {
      rows: numRows,
      columns: numCols,
      location: { index: insertionIndex },
    },
  });

  for (let r = numRows - 1; r >= 0; r--) {
    for (let c = numCols - 1; c >= 0; c--) {
      const cellText = allRows[r][c] ?? "";
      if (!cellText) continue;
      const cellIdx = cellParagraphIndex(insertionIndex, r, c, numCols);
      const isHeader = r === 0;

      requests.push({
        insertText: {
          location: { index: cellIdx },
          text: cellText,
        },
      });

      requests.push({
        updateTextStyle: {
          range: { startIndex: cellIdx, endIndex: cellIdx + cellText.length },
          textStyle: {
            bold: isHeader,
            fontSize: { magnitude: BODY_FONT_PT, unit: "PT" },
          },
          fields: "bold,fontSize",
        },
      });
    }
  }

  return requests;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function publishToGoogleDocs(params: {
  title: string;
  content: string;
  folderId?: string;
}): Promise<{ docUrl: string; docId: string; fileName: string }> {
  const auth = getGoogleAuthClient();
  const docsClient = google.docs({ version: "v1", auth });
  const driveClient = google.drive({ version: "v3", auth });

  const folderId = params.folderId ?? GOOGLE_DRIVE_FOLDER_ID;

  const seqNum = await getNextSequentialNumber(driveClient);
  const paddedNum = String(seqNum).padStart(2, "0");
  const safeTitle = (params.title || "Article")
    .replace(/[^a-zA-Z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
  const fileName = `${paddedNum}_${safeTitle}`;

  const createRes = await docsClient.documents.create({
    requestBody: { title: fileName },
  });

  const docId = createRes.data.documentId;
  if (!docId) throw new Error("Google Docs API did not return a document ID");

  const { textRequests, tablePlaceholders } = buildDocRequests(params.content);

  if (textRequests.length > 0) {
    await docsClient.documents.batchUpdate({
      documentId: docId,
      requestBody: { requests: textRequests },
    });
  }

  if (tablePlaceholders.length > 0) {
    const sortedByIndex = [...tablePlaceholders].sort(
      (a, b) => b.insertionIndex - a.insertionIndex,
    );

    const allTableRequests: DocRequest[] = [];
    let cumulativeOffset = 0;

    for (let i = sortedByIndex.length - 1; i >= 0; i--) {
      const ph = sortedByIndex[i];
      const requests = buildTableRequests(ph, cumulativeOffset);
      allTableRequests.push(...requests);
      cumulativeOffset += totalTableSize(ph.rows.length + 1, ph.headers.length);
    }

    if (allTableRequests.length > 0) {
      await docsClient.documents.batchUpdate({
        documentId: docId,
        requestBody: { requests: allTableRequests },
      });
    }
  }

  if (folderId) {
    try {
      const fileRes = await driveClient.files.get({
        fileId: docId,
        fields: "parents",
      });
      const previousParents = (fileRes.data.parents ?? []).join(",");
      await driveClient.files.update({
        fileId: docId,
        addParents: folderId,
        removeParents: previousParents || undefined,
        fields: "id, parents",
      });
    } catch (err) {
      logger.warn(
        { err, docId },
        "Could not move doc to Drive folder — check that folder is shared with the service account",
      );
    }
  }

  const docUrl = `https://docs.google.com/document/d/${docId}/edit`;
  logger.info({ docId, docUrl, fileName }, "Google Doc published successfully");
  return { docUrl, docId, fileName };
}
