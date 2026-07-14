// Cross-app workflow: shared asset registry, native handoffs, per-app script libraries.
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runJSX, WORKSPACE, APPS } from "../core/bridge.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS_ROOT = path.join(__dirname, "..", "scripts");
const MANIFEST = path.join(WORKSPACE, "assets.json");

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
        app: z.string().optional().describe("Filter by app (ae/ps/ai/ppro)."),
        kind: z.string().optional().describe("Filter by kind (png/svg/psd/ai/video...)."),
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
        "motion handoff.",
      inputSchema: {
        file_path: z.string().describe("Absolute path (.psd/.ai for layered import, or any footage)."),
        import_as: z.enum(["comp", "footage"]).optional().describe("Default comp for .psd/.ai, else footage."),
      },
    },
    async ({ file_path, import_as }) => {
      try {
        const ext = path.extname(file_path).toLowerCase();
        const asComp = import_as ? import_as === "comp" : ext === ".psd" || ext === ".ai";
        const jsx = `
var io = new ImportOptions(new File(${JSON.stringify(file_path)}));
if (!io.file.exists) throw new Error('File not found: ' + ${JSON.stringify(file_path)});
${asComp ? "if (io.canImportAs(ImportAsType.COMP)) io.importAs = ImportAsType.COMP;" : ""}
var item = app.project.importFile(io);
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
        "List .jsx/.jsxbin tools in the per-app scripts library (scripts/{ae,ps,ai,ppro}/), with " +
        "descriptions from header comments.",
      inputSchema: {
        app: z.string().optional().describe("Filter to one app (ae/ps/ai/ppro)."),
      },
    },
    async ({ app }) => {
      try {
        const apps = app ? [app] : Object.keys(APPS);
        const out = {};
        for (const a of apps) {
          const dir = path.join(SCRIPTS_ROOT, a);
          let entries = [];
          try { entries = fs.readdirSync(dir).filter((f) => /\.(jsx|jsxbin)$/i.test(f)); } catch { /* none */ }
          out[a] = entries.map((f) => {
            let description = "[compiled .jsxbin]";
            if (/\.jsx$/i.test(f)) {
              try {
                const head = fs.readFileSync(path.join(dir, f), "utf8").slice(0, 1500);
                const m = head.match(/\/\*+([\s\S]*?)\*\//) || head.match(/^((?:\s*\/\/[^\n]*\n)+)/);
                description = m ? m[1].replace(/^\s*(\/\/|\*)?\s?/gm, "").replace(/\s+/g, " ").trim().slice(0, 250) : "(no header)";
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
        "app's run_extendscript.",
      inputSchema: {
        app: z.string().describe("Which app: ae/ps/ai/ppro."),
        name: z.string().describe("Script filename from list_scripts (case-insensitive)."),
        timeout_seconds: z.number().optional().describe("Max seconds (default 120)."),
      },
    },
    async ({ app, name, timeout_seconds }) => {
      try {
        const dir = path.join(SCRIPTS_ROOT, app);
        const match = fs.readdirSync(dir).find((f) => f.toLowerCase() === name.toLowerCase());
        if (!match) throw new Error(`No script "${name}" in scripts/${app}/.`);
        const full = path.join(dir, match);
        const jsx = `
var __sf = new File(${JSON.stringify(full)});
if (!__sf.exists) throw new Error('Script not found: ' + __sf.fsName);
$.evalFile(__sf);
return 'Ran ' + ${JSON.stringify(match)};`;
        return text(await runJSX(app, jsx, (timeout_seconds ?? 120) * 1000));
      } catch (e) {
        return errText(e);
      }
    }
  );
}
