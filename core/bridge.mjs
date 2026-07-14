// adobe-mcp core bridge: routes ExtendScript to each app.
// AE/PS/AI: osascript (AppleScript DoScript / do javascript).
// Premiere: command-file handoff to the mcp-bridge CEP panel.
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { logError, matchError, hintBlock } from "../knowledge/knowledge.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HARNESS = fs.readFileSync(path.join(__dirname, "harness.jsx"), "utf8");

export const WORKSPACE =
  process.env.ADOBE_MCP_WORKSPACE || path.join(os.homedir(), "AdobeMCP");
export const PPRO_BRIDGE_DIR = path.join(WORKSPACE, "ppro-bridge");
fs.mkdirSync(WORKSPACE, { recursive: true });
fs.mkdirSync(PPRO_BRIDGE_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// App registry
// ---------------------------------------------------------------------------

function findApp(dirPattern, fallback, envVar) {
  if (process.env[envVar]) return process.env[envVar];
  try {
    const dirs = fs
      .readdirSync("/Applications")
      .filter((e) => dirPattern.test(e))
      .sort();
    if (dirs.length) {
      const dir = dirs[dirs.length - 1];
      if (dir.endsWith(".app")) return dir.replace(/\.app$/, "");
      const inner = fs
        .readdirSync(path.join("/Applications", dir))
        .find((f) => f.endsWith(".app"));
      if (inner) return inner.replace(/\.app$/, "");
      return dir;
    }
  } catch {
    /* fall through */
  }
  return fallback;
}

export const APPS = {
  ae: {
    label: "After Effects",
    bridge: "osascript",
    appName: () => findApp(/^Adobe After Effects/i, "Adobe After Effects", "AE_APP_NAME"),
    osa: (app, jsxPath) =>
      `tell application "${app}" to DoScript "$.evalFile('${jsxPath}')"`,
    undoGroup: true,
    writePrefHint:
      ' Enable AE Preferences → Scripting & Expressions → "Allow Scripts to Write Files and Access Network".',
  },
  ps: {
    label: "Photoshop",
    bridge: "osascript",
    appName: () => findApp(/^Adobe Photoshop/i, "Adobe Photoshop 2026", "PS_APP_NAME"),
    osa: (app, jsxPath) =>
      `tell application "${app}" to do javascript "$.evalFile(new File('${jsxPath}'))"`,
    undoGroup: false,
    writePrefHint: "",
  },
  ai: {
    label: "Illustrator",
    bridge: "osascript",
    appName: () => findApp(/^Adobe Illustrator/i, "Adobe Illustrator", "AI_APP_NAME"),
    osa: (app, jsxPath) =>
      `tell application "${app}" to do javascript "$.evalFile(new File('${jsxPath}'))"`,
    undoGroup: false,
    writePrefHint: "",
  },
  ppro: {
    label: "Premiere Pro",
    bridge: "panel",
    appName: () => findApp(/^Adobe Premiere Pro/i, "Adobe Premiere Pro 2026", "PPRO_APP_NAME"),
    undoGroup: false,
    writePrefHint: "",
  },
};

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

function osascript(script, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(
      "osascript",
      ["-e", script],
      { timeout: timeoutMs, killSignal: "SIGKILL" },
      (err, stdout, stderr) => {
        if (err) {
          err.stderr = stderr;
          reject(err);
        } else resolve(stdout);
      }
    );
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function writeHarnessed(appKey, userCode, resultPath, scriptPath) {
  const app = APPS[appKey];
  const undoOpen = app.undoGroup ? "app.beginUndoGroup('adobe-mcp');" : "";
  const undoClose = app.undoGroup ? "app.endUndoGroup();" : "";
  const wrapped = HARNESS.replace(/__RESULT_PATH__/g, () => JSON.stringify(resultPath))
    .replace(/__USER_CODE__/g, () => userCode)
    .replace(/__UNDO_OPEN__/g, () => undoOpen)
    .replace(/__UNDO_CLOSE__/g, () => undoClose);
  fs.writeFileSync(scriptPath, wrapped, "utf8");
}

async function awaitResultFile(resultPath, timeoutMs, failMsg) {
  const deadline = Date.now() + timeoutMs;
  let raw = null;
  while (Date.now() < deadline) {
    if (fs.existsSync(resultPath)) {
      raw = fs.readFileSync(resultPath, "utf8");
      if (raw.length) break;
    }
    await sleep(120);
  }
  if (raw === null) throw new Error(failMsg);
  fs.rmSync(resultPath, { force: true });
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Could not parse result: ${raw.slice(0, 2000)}`);
  }
  if (!parsed.ok) throw new Error(`ExtendScript error (line ${parsed.line}): ${parsed.error}`);
  return parsed.result;
}

export function pproPanelAlive() {
  const hb = path.join(PPRO_BRIDGE_DIR, "heartbeat");
  try {
    return Date.now() - Number(fs.readFileSync(hb, "utf8")) < 5000;
  } catch {
    return false;
  }
}

/**
 * Run ExtendScript inside the given app. Returns the JSON-decoded result.
 * On failure: logs the error to the workspace error log and appends any
 * matching knowledge-base lessons to the error message (the learning loop).
 */
export async function runJSX(appKey, userCode, timeoutMs = 120000) {
  try {
    return await runJSXInner(appKey, userCode, timeoutMs);
  } catch (e) {
    logError(appKey, userCode, e.message || e);
    const hints = matchError(appKey, e.message || String(e));
    if (hints.length) e.message = `${e.message}${hintBlock(hints)}`;
    throw e;
  }
}

async function runJSXInner(appKey, userCode, timeoutMs = 120000) {
  const app = APPS[appKey];
  if (!app) throw new Error(`Unknown app "${appKey}". Use: ${Object.keys(APPS).join(", ")}`);
  const stamp = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const resultPath = path.join(os.tmpdir(), `adobe_mcp_result_${appKey}_${stamp}.json`);
  const scriptPath = path.join(os.tmpdir(), `adobe_mcp_script_${appKey}_${stamp}.jsx`);
  writeHarnessed(appKey, userCode, resultPath, scriptPath);

  if (app.bridge === "osascript") {
    const appName = app.appName();
    try {
      await osascript(app.osa(appName, scriptPath), timeoutMs);
    } catch (err) {
      fs.rmSync(resultPath, { force: true });
      const msg = String(err.stderr || err.message || err);
      let hint = "";
      if (err.killed || /timed?.?out/i.test(msg)) {
        hint = ` Timed out after ${timeoutMs / 1000}s — ${app.label} may be showing a modal dialog, or raise timeout_seconds. Script kept: ${scriptPath}`;
      } else if (/-600|isn.t running|can.t be found|-1728|-10810/i.test(msg)) {
        hint = ` Is ${app.label} open? (Looked for app "${appName}"; override with env var.)`;
      } else if (/-1743|not authori[sz]ed/i.test(msg)) {
        hint = ` macOS blocked Automation permission for ${app.label} — approve in System Settings → Privacy & Security → Automation.`;
      }
      throw new Error(`osascript failed: ${msg.trim()}.${hint}`);
    }
    const result = await awaitResultFile(
      resultPath,
      15000,
      `${app.label} ran the script but no result file appeared.${app.writePrefHint} Script kept: ${scriptPath}`
    );
    fs.rmSync(scriptPath, { force: true });
    return result;
  }

  // panel bridge (Premiere)
  if (!pproPanelAlive()) {
    throw new Error(
      "Premiere mcp-bridge panel is not running. In Premiere: Window → Extensions → MCP Bridge " +
        "(requires the panel installed under ~/Library/Application Support/Adobe/CEP/extensions and " +
        "PlayerDebugMode=1 for com.adobe.CSXS.11)."
    );
  }
  const cmdPath = path.join(PPRO_BRIDGE_DIR, `cmd_${stamp}.json`);
  fs.writeFileSync(cmdPath, JSON.stringify({ jsx: scriptPath }), "utf8");
  const result = await awaitResultFile(
    resultPath,
    timeoutMs,
    `Premiere panel accepted the command but no result appeared. A modal dialog may be open, or the JSX failed to parse. Script kept: ${scriptPath}`
  );
  fs.rmSync(scriptPath, { force: true });
  return result;
}

// Small helper shared by preview tools: downscale a PNG with sips.
export async function downscalePng(pngPath, maxWidth) {
  await new Promise((resolve) =>
    execFile("sips", ["-Z", String(maxWidth), pngPath], () => resolve())
  );
}
