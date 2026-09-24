// Cross-app workflow: shared asset registry, native handoffs, per-app script libraries.
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runJSX, WORKSPACE, APPS } from "../core/bridge.mjs";
import { runBlender, runPainter, blenderSaveSnippet } from "../core/pybridge.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS_ROOT = path.join(__dirname, "..", "scripts");
const MANIFEST = path.join(WORKSPACE, "assets.json");
// Python-scripted apps: library scripts are .py, run through the Python bridges.
const PY_APPS = { blender: runBlender, substance: runPainter };
const scriptApps = () => [...Object.keys(APPS), ...Object.keys(PY_APPS)];
const SCRIPT_EXT = (a) => (PY_APPS[a] ? /\.py$/i : /\.(jsx|jsxbin)$/i);

function loadManifest() {
  try { return JSON.parse(fs.readFileSync(MANIFEST, "utf8")); } catch { return []; }
}

export function makeRegisterAsset() {
  return function registerAsset(asset) {
    const list = loadManifest();
    list.push({ id: `${asset.app}-${Date.now().toString(36)}`, at: new Date().toISOString(), ...asset });
    fs.writeFileSync(MANIFEST, JSON.stringify(list, null, 2), "utf8");
  };
}

export function register(server, { text, errText, registerAsset }) {
  server.registerTool(
    "workflow_assets",
    {
      title: "List workflow assets",
      description:
        "The shared cross-app asset registry. Every export/render from any adapter registers here " +
        "with {id, app, kind, path}. Use it to pull one app's output into another.",
      inputSchema: {
        app: z.string().optional().describe("Filter by app (ae/ps/ai/ppro/blender/substance)."),
        kind: z.string().optional().describe("Filter by kind (png/svg/psd/ai/video/texture/image-sequence/blend...)."),
      },
    },
    async ({ app, kind }) => {
      try {
        let list = loadManifest();
        if (app) list = list.filter((a) => a.app === app);
        if (kind) list = list.filter((a) => a.kind === kind);
        // drop entries whose file vanished
        list = list.filter((a) => { try { return fs.existsSync(a.path); } catch { return false; } });
        return text({ workspace: WORKSPACE, count: list.length, assets: list });
      } catch (e) {
        return errText(e);
      }
    }
  );

  server.registerTool(
    "handoff_import_to_ae",
    {
      title: "Import a file into After Effects (layered handoff)",
      description:
        "Import a file into the AE project. Layered .psd (Photoshop) and .ai (Illustrator) files can " +
        "import as a COMP — every source layer becomes an animatable AE layer. This is the design→" +
        "motion handoff. For Blender renders pass the first frame of a sequence (or its folder) with " +
        "sequence=true and the render fps.",
      inputSchema: {
        file_path: z.string().describe("Absolute path (.psd/.ai for layered import, any footage, or a sequence folder/first frame)."),
        import_as: z.enum(["comp", "footage"]).optional().describe("Default comp for .psd/.ai, else footage."),
        sequence: z.boolean().optional().describe("Import as a numbered image sequence (default: true when file_path is a folder)."),
        fps: z.number().optional().describe("Conform the sequence frame rate (e.g. 24)."),
      },
    },
    async ({ file_path, import_as, sequence, fps }) => {
      try {
        let target = file_path;
        let isSeq = sequence ?? false;
        if (fs.existsSync(file_path) && fs.statSync(file_path).isDirectory()) {
          const first = fs.readdirSync(file_path).filter((f) => /\.(png|exr|tif|tiff|jpg|dpx)$/i.test(f)).sort()[0];
          if (!first) throw new Error(`No image frames in ${file_path}`);
          target = path.join(file_path, first);
          isSeq = sequence ?? true;
        }
        const ext = path.extname(target).toLowerCase();
        const asComp = import_as ? import_as === "comp" : ext === ".psd" || ext === ".ai";
        const jsx = `
var io = new ImportOptions(new File(${JSON.stringify(target)}));
if (!io.file.exists) throw new Error('File not found: ' + ${JSON.stringify(target)});
${asComp ? "if (io.canImportAs(ImportAsType.COMP)) io.importAs = ImportAsType.COMP;" : ""}
${isSeq ? "io.sequence = true;" : ""}
var item = app.project.importFile(io);
${fps ? `if (item.mainSource && item.mainSource.conformFrameRate !== undefined) item.mainSource.conformFrameRate = ${Number(fps)};` : ""}
return { imported: item.name, type: item.typeName,
  isComp: item instanceof CompItem,
  numLayers: (item instanceof CompItem) ? item.numLayers : null };`;
        return text(await runJSX("ae", jsx, 120000));
      } catch (e) {
        return errText(e);
      }
    }
  );

  server.registerTool(
    "handoff_place_in_ps",
    {
      title: "Place a file into the active Photoshop document",
      description:
        "Place an image/vector file (SVG, PNG, AI...) as a layer in the active Photoshop document — " +
        "the Illustrator→Photoshop handoff.",
      inputSchema: {
        file_path: z.string().describe("Absolute path to place."),
      },
    },
    async ({ file_path }) => {
      try {
        const jsx = `
if (!app.documents.length) throw new Error('No document open in Photoshop');
var idPlc = charIDToTypeID('Plc ');
var desc = new ActionDescriptor();
desc.putPath(charIDToTypeID('null'), new File(${JSON.stringify(file_path)}));
desc.putEnumerated(charIDToTypeID('FTcs'), charIDToTypeID('QCSt'), charIDToTypeID('Qcsa'));
executeAction(idPlc, desc, DialogModes.NO);
return { placed: ${JSON.stringify(path.basename(file_path))}, layer: app.activeDocument.activeLayer.name };`;
        return text(await runJSX("ps", jsx, 120000));
      } catch (e) {
        return errText(e);
      }
    }
  );

  server.registerTool(
    "list_scripts",
    {
      title: "List installed script tools",
      description:
        "List tools in the per-app scripts library (scripts/{ae,ps,ai,ppro}/*.jsx, " +
        "scripts/{blender,substance}/*.py), with descriptions from header comments/docstrings.",
      inputSchema: {
        app: z.string().optional().describe("Filter to one app (ae/ps/ai/ppro/blender/substance)."),
      },
    },
    async ({ app }) => {
      try {
        const apps = app ? [app] : scriptApps();
        const out = {};
        for (const a of apps) {
          const dir = path.join(SCRIPTS_ROOT, a);
          let entries = [];
          try { entries = fs.readdirSync(dir).filter((f) => SCRIPT_EXT(a).test(f)); } catch { /* none */ }
          out[a] = entries.map((f) => {
            let description = "[compiled .jsxbin]";
            if (/\.(jsx|py)$/i.test(f)) {
              try {
                const head = fs.readFileSync(path.join(dir, f), "utf8").slice(0, 1500);
                const m = /\.py$/i.test(f)
                  ? head.match(/^\s*(?:"""|''')([\s\S]*?)(?:"""|''')/) || head.match(/^((?:\s*#[^\n]*\n)+)/)
                  : head.match(/\/\*+([\s\S]*?)\*\//) || head.match(/^((?:\s*\/\/[^\n]*\n)+)/);
                description = m ? m[1].replace(/^\s*(\/\/|\*|#)?\s?/gm, "").replace(/\s+/g, " ").trim().slice(0, 250) : "(no header)";
              } catch { description = "(unreadable)"; }
            }
            return { name: f, description };
          });
        }
        return text(out);
      } catch (e) {
        return errText(e);
      }
    }
  );

  server.registerTool(
    "run_script",
    {
      title: "Run an installed script tool",
      description:
        "Execute a script from the library in its app (like File → Scripts → Run Script File). Action " +
        "scripts run immediately; ScriptUI panels open for the user. Set up selections first via the " +
        "app's run_extendscript. `params` is exposed to the script as PARAMS (JSX: $.global.PARAMS; " +
        "Python: a PARAMS dict) — each script's header lists its keys. Scripts that report back " +
        "(JSX: $.global.MCP_RESULT, Python: result) return that value.",
      inputSchema: {
        app: z.string().describe("Which app: ae/ps/ai/ppro/blender/substance."),
        name: z.string().describe("Script filename from list_scripts (case-insensitive)."),
        params: z.record(z.any()).optional().describe("Parameters passed to the script as PARAMS."),
        mode: z.enum(["auto", "live", "background"]).optional().describe("Blender only: bridge mode."),
        blend_file: z.string().optional().describe("Blender only: .blend to open in background mode."),
        save_as: z.string().optional().describe("Blender only: save the .blend here after the script runs."),
        timeout_seconds: z.number().optional().describe("Max seconds (default 120; 600 for Blender)."),
      },
    },
    async ({ app, name, params, mode, blend_file, save_as, timeout_seconds }) => {
      try {
        const dir = path.join(SCRIPTS_ROOT, app);
        const match = fs.readdirSync(dir).find((f) => f.toLowerCase() === name.toLowerCase());
        if (!match) throw new Error(`No script "${name}" in scripts/${app}/.`);
        const full = path.join(dir, match);
        if (PY_APPS[app]) {
          let py = `PARAMS = ${JSON.stringify(JSON.stringify(params ?? {}))}\nimport json as __json\nPARAMS = __json.loads(PARAMS)\n`;
          py += fs.readFileSync(full, "utf8");
          if (app === "blender" && save_as)
            py += blenderSaveSnippet(save_as);
          const timeoutMs = (timeout_seconds ?? (app === "blender" ? 600 : 120)) * 1000;
          const r = await PY_APPS[app](py, { mode, blendFile: blend_file, timeoutMs });
          if (app === "blender" && save_as) registerAsset({ app: "blender", kind: "blend", path: save_as, meta: { script: match } });
          return text({ ran: match, ...r });
        }
        const jsx = `
var __sf = new File(${JSON.stringify(full)});
if (!__sf.exists) throw new Error('Script not found: ' + __sf.fsName);
$.global.PARAMS = ${params ? toES3Literal(params) : "undefined"};
$.global.MCP_RESULT = undefined;
$.evalFile(__sf);
var __r = $.global.MCP_RESULT;
$.global.PARAMS = undefined; $.global.MCP_RESULT = undefined;
return __r === undefined ? 'Ran ' + ${JSON.stringify(match)} : __r;`;
        return text(await runJSX(app, jsx, (timeout_seconds ?? 120) * 1000));
      } catch (e) {
        return errText(e);
      }
    }
  );
}

// JSON is a valid ES3 object literal as long as it has no U+2028/2029 line separators.
function toES3Literal(v) {
  return JSON.stringify(v).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}
