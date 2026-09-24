// adobe-mcp Python bridges — the 3D side of the pipeline.
//
//   Blender            → live:       TCP socket to the adobe-mcp Blender add-on (bridges/blender/)
//                        background: headless `blender -b [file.blend] --python <harness>`
//   Substance 3D Painter → HTTP remote scripting (`--enable-remote-scripting`, port 60041, /run.json)
//
// Both wrap user code in the same Python harness (core/harness.py): the code runs as a module
// body, `result = <value>` comes back as JSON, stdout is captured, and exceptions report the
// failing line of the user's code. Failures go through the same knowledge loop as ExtendScript.
import { execFile } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { logError, matchError, hintBlock } from "../knowledge/knowledge.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PY_HARNESS = fs.readFileSync(path.join(__dirname, "harness.py"), "utf8");

export const BLENDER_PORT = Number(process.env.BLENDER_MCP_PORT || 9877);
export const PAINTER_PORT = Number(process.env.SUBSTANCE_PAINTER_PORT || 60041);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Build the harnessed Python source. The result JSON is written to resultPath. */
export function harnessPython(userCode, resultPath) {
  const b64 = Buffer.from(userCode, "utf8").toString("base64");
  return PY_HARNESS.replace(/__USER_CODE_B64__/g, () => b64).replace(
    /__RESULT_PATH__/g,
    () => JSON.stringify(resultPath)
  );
}

function stampPaths(appKey) {
  const stamp = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  return {
    resultPath: path.join(os.tmpdir(), `adobe_mcp_result_${appKey}_${stamp}.json`),
    scriptPath: path.join(os.tmpdir(), `adobe_mcp_script_${appKey}_${stamp}.py`),
  };
}

function readResult(resultPath) {
  if (!fs.existsSync(resultPath)) return null;
  const raw = fs.readFileSync(resultPath, "utf8");
  if (!raw.length) return null;
  fs.rmSync(resultPath, { force: true });
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`Could not parse result: ${raw.slice(0, 2000)}`);
  }
}

function unwrap(parsed, label) {
  if (!parsed.ok) {
    const err = new Error(
      `${label} Python error (line ${parsed.line ?? "?"}): ${parsed.error}` +
        (parsed.stdout ? `\n--- stdout ---\n${parsed.stdout}` : "") +
        (parsed.traceback ? `\n--- traceback ---\n${parsed.traceback}` : "")
    );
    throw err;
  }
  return { result: parsed.result ?? null, stdout: parsed.stdout || "" };
}

async function withKnowledge(appKey, code, fn) {
  try {
    return await fn();
  } catch (e) {
    logError(appKey, code, e.message || e);
    const hints = matchError(appKey, e.message || String(e));
    if (hints.length) e.message = `${e.message}${hintBlock(hints)}`;
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Blender
// ---------------------------------------------------------------------------

export function blenderExecutable() {
  if (process.env.BLENDER_PATH) return process.env.BLENDER_PATH;
  const candidates = [
    "/Applications/Blender.app/Contents/MacOS/Blender",
    "C:\\Program Files\\Blender Foundation\\Blender\\blender.exe",
  ];
  try {
    // Versioned installs, e.g. /Applications/Blender 4.5.app
    for (const e of fs.readdirSync("/Applications").filter((d) => /^Blender.*\.app$/i.test(d)).sort().reverse())
      candidates.push(path.join("/Applications", e, "Contents/MacOS/Blender"));
  } catch {
    /* not macOS */
  }
  return candidates.find((c) => fs.existsSync(c)) || "blender"; // fall back to PATH
}

/** True when the adobe-mcp Blender add-on is listening. */
export function blenderLiveAlive(timeoutMs = 400) {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host: "127.0.0.1", port: BLENDER_PORT });
    const done = (v) => {
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
  });
}

function blenderLive(code, timeoutMs) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host: "127.0.0.1", port: BLENDER_PORT });
    let buf = "";
    const timer = setTimeout(() => {
      sock.destroy();
      reject(
        new Error(
          `Blender live bridge timed out after ${timeoutMs / 1000}s — Blender may be busy (rendering, modal operator) or raise timeout_seconds.`
        )
      );
    }, timeoutMs);
    sock.setEncoding("utf8");
    sock.once("connect", () => sock.write(JSON.stringify({ code }) + "\n"));
    sock.on("data", (d) => {
      buf += d;
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      clearTimeout(timer);
      sock.destroy();
      try {
        resolve(JSON.parse(buf.slice(0, nl)));
      } catch {
        reject(new Error(`Blender bridge sent unparseable reply: ${buf.slice(0, 500)}`));
      }
    });
    sock.once("error", (e) => {
      clearTimeout(timer);
      reject(
        new Error(
          `Cannot reach the Blender live bridge on 127.0.0.1:${BLENDER_PORT} (${e.code || e.message}). ` +
            "Install/enable bridges/blender/adobe_mcp_bridge.py as an add-on (Edit → Preferences → Add-ons → Install from Disk), " +
            "or use mode 'background' with a blend_file."
        )
      );
    });
  });
}

function blenderBackground(code, { blendFile, timeoutMs }) {
  const { resultPath, scriptPath } = stampPaths("blender");
  fs.writeFileSync(scriptPath, harnessPython(code, resultPath), "utf8");
  const exe = blenderExecutable();
  const args = ["-b"];
  if (blendFile) {
    if (!fs.existsSync(blendFile)) throw new Error(`blend_file not found: ${blendFile}`);
    args.push(blendFile);
  } else args.push("--factory-startup");
  args.push("--python-exit-code", "1", "--python", scriptPath);
  return new Promise((resolve, reject) => {
    execFile(exe, args, { timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      let parsed = null;
      try {
        parsed = readResult(resultPath);
      } catch (e) {
        return reject(e);
      }
      if (parsed) {
        fs.rmSync(scriptPath, { force: true });
        return resolve(parsed);
      }
      const msg = String(stderr || (err && err.message) || "").trim().slice(-2000);
      let hint = "";
      if (err && err.code === "ENOENT")
        hint = ` Blender executable not found ("${exe}") — set BLENDER_PATH to the Blender binary.`;
      else if (err && err.killed) hint = ` Timed out after ${timeoutMs / 1000}s — raise timeout_seconds for long renders.`;
      reject(new Error(`Blender (background) produced no result.${hint} ${msg} Script kept: ${scriptPath}`));
    });
  });
}

/**
 * Run Python inside Blender. mode: 'live' (running Blender via the add-on), 'background'
 * (headless process, optional blend_file), or 'auto' (live if the add-on answers, else background).
 */
export async function runBlender(code, { mode = "auto", blendFile, timeoutMs = 120000 } = {}) {
  return withKnowledge("blender", code, async () => {
    let useLive = mode === "live";
    if (mode === "auto") useLive = !blendFile && (await blenderLiveAlive());
    const parsed = useLive ? await blenderLive(code, timeoutMs) : await blenderBackground(code, { blendFile, timeoutMs });
    return { ...unwrap(parsed, "Blender"), mode: useLive ? "live" : "background" };
  });
}

// ---------------------------------------------------------------------------
// Substance 3D Painter
// ---------------------------------------------------------------------------

async function painterPost(body, timeoutMs) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${PAINTER_PORT}/run.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    const txt = await res.text();
    try {
      return JSON.parse(txt);
    } catch {
      return txt;
    }
  } catch (e) {
    if (e.name === "AbortError")
      throw new Error(`Substance Painter did not answer within ${timeoutMs / 1000}s — a modal dialog may be open.`);
    throw new Error(
      `Cannot reach Substance 3D Painter remote scripting on 127.0.0.1:${PAINTER_PORT} (${e.cause?.code || e.message}). ` +
        "Launch Painter with --enable-remote-scripting (macOS: open -a \"Adobe Substance 3D Painter\" --args --enable-remote-scripting)."
    );
  } finally {
    clearTimeout(t);
  }
}

/**
 * Run Python inside Substance 3D Painter over its remote-scripting endpoint.
 * The payload is a single expression statement (exec of the base64 harness), so it is valid
 * whether the endpoint evals or execs it; the harness writes its JSON result to a temp file.
 */
export async function runPainter(code, { timeoutMs = 120000 } = {}) {
  return withKnowledge("substance", code, async () => {
    const { resultPath } = stampPaths("substance");
    const harness = harnessPython(code, resultPath);
    const stmt = `exec(__import__('base64').b64decode('${Buffer.from(harness, "utf8").toString("base64")}').decode('utf-8'))`;
    // Painter's lib_remote protocol base64-encodes the script; SUBSTANCE_REMOTE_ENCODING=raw sends it verbatim.
    const encodings = process.env.SUBSTANCE_REMOTE_ENCODING === "raw" ? ["raw"] : ["base64", "raw"];
    let lastReply = null;
    for (const enc of encodings) {
      const payload = enc === "base64" ? Buffer.from(stmt, "utf8").toString("base64") : stmt;
      lastReply = await painterPost({ python: payload }, timeoutMs);
      const deadline = Date.now() + 3000; // result file is written synchronously; allow FS latency
      while (Date.now() < deadline) {
        const parsed = readResult(resultPath);
        if (parsed) return unwrap(parsed, "Substance Painter");
        await sleep(100);
      }
      const errTxt = typeof lastReply === "object" && lastReply ? lastReply.error : String(lastReply);
      if (!/syntax|decode|invalid/i.test(String(errTxt || ""))) break; // not an encoding problem
    }
    throw new Error(
      `Substance Painter accepted the request but the script did not report back. Painter replied: ${JSON.stringify(lastReply).slice(0, 1500)}`
    );
  });
}

/** Python appended to Blender code to save the .blend (creating its folder). */
export function blenderSaveSnippet(filepath) {
  return (
    `\nimport bpy as __bpy, os as __os\n` +
    `__os.makedirs(__os.path.dirname(${JSON.stringify(filepath)}) or ".", exist_ok=True)\n` +
    `__bpy.ops.wm.save_as_mainfile(filepath=${JSON.stringify(filepath)})\n`
  );
}
