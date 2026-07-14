// adobe-mcp knowledge system.
//
// Two-tier lesson store:
//   knowledge/lessons.jsonl        — curated lessons shipped with the repo (seeded from real sessions)
//   $WORKSPACE/learned.jsonl       — lessons added at runtime via knowledge_add (survives repo updates)
//
// Learning loop:
//   1. Every ExtendScript failure is logged to $WORKSPACE/error-log.jsonl (raw material for new lessons).
//   2. The bridge matches error text against each lesson's `match` keywords and appends the winning
//      lessons to the error message the client sees — so a gotcha discovered once is surfaced
//      automatically the next time anyone trips it.
//   3. Agents can consult the store up front (knowledge_search) and contribute (knowledge_add).
import { z } from "zod";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE =
  process.env.ADOBE_MCP_WORKSPACE || path.join(os.homedir(), "AdobeMCP");
const SEED_PATH = path.join(__dirname, "lessons.jsonl");
const LEARNED_PATH = path.join(WORKSPACE, "learned.jsonl");
const ERROR_LOG = path.join(WORKSPACE, "error-log.jsonl");

function readJsonl(p) {
  try {
    return fs
      .readFileSync(p, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function loadLessons() {
  return [...readJsonl(SEED_PATH), ...readJsonl(LEARNED_PATH)];
}

/** Lessons whose `match` keywords appear in the error text (best two). */
export function matchError(appKey, errText) {
  const hay = String(errText).toLowerCase();
  const scored = [];
  for (const l of loadLessons()) {
    if (l.app && l.app !== "any" && l.app !== appKey) continue;
    if (!Array.isArray(l.match) || !l.match.length) continue;
    const hits = l.match.filter((kw) => hay.includes(kw.toLowerCase())).length;
    if (hits) scored.push([hits, l]);
  }
  scored.sort((a, b) => b[0] - a[0]);
  return scored.slice(0, 2).map(([, l]) => l);
}

/** Keyword search over title + lesson text. */
export function searchLessons(query, appKey) {
  const terms = String(query || "")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  const scored = [];
  for (const l of loadLessons()) {
    if (appKey && l.app !== appKey && l.app !== "any") continue;
    const hay = `${l.title} ${l.lesson} ${(l.match || []).join(" ")}`.toLowerCase();
    const hits = terms.filter((t) => hay.includes(t)).length;
    if (!terms.length || hits) scored.push([hits, l]);
  }
  scored.sort((a, b) => b[0] - a[0]);
  return scored.map(([, l]) => l);
}

export function addLesson({ app, title, lesson, match = [], example }) {
  fs.mkdirSync(WORKSPACE, { recursive: true });
  const entry = {
    id: `learned-${Date.now().toString(36)}`,
    app: app || "any",
    title,
    lesson,
    match,
    ...(example ? { example } : {}),
    added: new Date().toISOString(),
    source: "runtime",
  };
  fs.appendFileSync(LEARNED_PATH, JSON.stringify(entry) + "\n", "utf8");
  return entry;
}

/** Called by the bridge on every failed script run. */
export function logError(appKey, code, errMsg) {
  try {
    fs.mkdirSync(WORKSPACE, { recursive: true });
    fs.appendFileSync(
      ERROR_LOG,
      JSON.stringify({
        at: new Date().toISOString(),
        app: appKey,
        error: String(errMsg).slice(0, 600),
        code: String(code).slice(0, 1200),
      }) + "\n",
      "utf8"
    );
  } catch {
    /* never let logging break the actual error path */
  }
}

/** Format lessons as a hint block appended to error messages. */
export function hintBlock(lessons) {
  if (!lessons.length) return "";
  return (
    "\n\nKNOWN GOTCHA" +
    (lessons.length > 1 ? "S" : "") +
    " (from adobe-mcp knowledge base):\n" +
    lessons.map((l) => `- ${l.title}: ${l.lesson}`).join("\n")
  );
}

/** Startup digest for the MCP server `instructions` field. */
export function instructionsDigest() {
  const n = loadLessons().length;
  return [
    "adobe-mcp drives AE, Photoshop, Illustrator, Premiere and CH puppet authoring via ExtendScript.",
    "",
    "WORKING RULES (learned from real sessions):",
    "1. TARGET DOCUMENTS EXPLICITLY. PS/AI active document can silently change between calls — start every PS/AI script with app.activeDocument = app.documents.getByName(...). Exports always act on the ACTIVE document.",
    "2. VERIFY VISUALLY AT EVERY STAGE. Use ae_save_frame / ps_save_preview / ai_save_preview after each meaningful change, and verify final renders by extracting frames from the output file. For seamless loops, diff first vs last frame.",
    "3. A RENDER TIMEOUT IS NOT A FAILED RENDER. If ae_render_comp/exports time out, check the output file (stable size, right duration) before re-running.",
    "4. ES3 ONLY inside the apps: no JSON, let/const, arrows, Array.map. Collections are 1-indexed in AE.",
    `5. CONSULT THE KNOWLEDGE BASE: ${n} lessons loaded. knowledge_search before attempting something unusual; failed scripts auto-surface matching lessons. When you solve a NEW gotcha (an error whose fix wasn't suggested), record it with knowledge_add so the server learns.`,
  ].join("\n");
}

export function register(server, { text, errText }) {
  server.registerTool(
    "knowledge_search",
    {
      title: "Search the adobe-mcp knowledge base",
      description:
        "Search accumulated scripting lessons/gotchas for the Adobe apps (seeded + learned at runtime). " +
        "Query by keywords, optionally filtered by app (ae/ps/ai/ppro/ch). Empty query lists everything. " +
        "Consult this BEFORE attempting unusual scripting; it is cheaper than rediscovering a gotcha.",
      inputSchema: {
        query: z.string().optional().describe("Keywords (empty = list all)."),
        app: z.string().optional().describe("Filter: ae, ps, ai, ppro, ch."),
      },
    },
    async ({ query, app }) => {
      try {
        const out = searchLessons(query || "", app).map((l) => ({
          app: l.app,
          title: l.title,
          lesson: l.lesson,
          ...(l.example ? { example: l.example } : {}),
        }));
        return text({ count: out.length, lessons: out.slice(0, 25) });
      } catch (e) {
        return errText(e);
      }
    }
  );

  server.registerTool(
    "knowledge_add",
    {
      title: "Record a new lesson in the knowledge base",
      description:
        "Persist a scripting lesson/gotcha so future sessions (and other users of this install) benefit. " +
        "Use after solving an error whose fix was NOT auto-suggested, or discovering a non-obvious technique. " +
        "`match` keywords are matched against future error text to auto-surface the lesson — choose distinctive " +
        "substrings of the error message (e.g. 'Illegal Parameter type').",
      inputSchema: {
        app: z.string().describe("ae, ps, ai, ppro, ch, or 'any'."),
        title: z.string().describe("Short name for the lesson."),
        lesson: z.string().describe("The gotcha and its fix, 1-3 sentences."),
        match: z
          .array(z.string())
          .optional()
          .describe("Error-text substrings that should auto-surface this lesson."),
        example: z.string().optional().describe("Minimal working code example."),
      },
    },
    async ({ app, title, lesson, match, example }) => {
      try {
        return text(addLesson({ app, title, lesson, match, example }));
      } catch (e) {
        return errText(e);
      }
    }
  );
}
