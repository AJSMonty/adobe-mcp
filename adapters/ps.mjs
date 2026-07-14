// Photoshop adapter.
import { z } from "zod";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runJSX, downscalePng } from "../core/bridge.mjs";

export function register(server, { text, errText, registerAsset }) {
  server.registerTool(
    "ps_run_extendscript",
    {
      title: "Run ExtendScript in Photoshop",
      description:
        "Execute ExtendScript (JSX) inside Photoshop and return the result. Runs as a function body: " +
        "end with `return <value>`. ES3 only. Key DOM: app.documents, activeDocument, artLayers, " +
        "layerSets, selection (polygon points), doc.saveAs/exportDocument, charIDToTypeID for " +
        "ActionDescriptor work. GOTCHAS: the active document can silently change between calls — " +
        "start scripts with app.activeDocument = app.documents.getByName(...); text sizes/positions " +
        "need new UnitValue(n,'px') (plain numbers can throw 'Internal error'); no ellipse selection " +
        "(pass a 72-point polygon); layer edits require the doc frontmost. More: knowledge_search.",
      inputSchema: {
        code: z.string().describe("ExtendScript function body."),
        timeout_seconds: z.number().optional().describe("Max seconds (default 120)."),
      },
    },
    async ({ code, timeout_seconds }) => {
      try {
        const r = await runJSX("ps", code, (timeout_seconds ?? 120) * 1000);
        return text({ ok: true, result: r === undefined ? null : r });
      } catch (e) {
        return errText(e);
      }
    }
  );

  server.registerTool(
    "ps_get_state",
    {
      title: "Inspect open Photoshop documents",
      description:
        "Lists open documents; for the active document returns the full layer tree (groups, layer " +
        "kinds, text contents, visibility, opacity, bounds).",
      inputSchema: {},
    },
    async () => {
      try {
        const jsx = `
function layerInfo(l){
  var rec = { name: l.name, kind: String(l.typename), visible: l.visible };
  try { rec.opacity = Math.round(l.opacity); } catch(e){}
  if (l.typename === 'ArtLayer') {
    try { rec.layerKind = String(l.kind); } catch(e){}
    try { if (l.kind == LayerKind.TEXT) { rec.text = l.textItem.contents; rec.font = l.textItem.font; } } catch(e){}
    try { var b = l.bounds; rec.bounds = [Math.round(b[0].value), Math.round(b[1].value), Math.round(b[2].value), Math.round(b[3].value)]; } catch(e){}
  } else if (l.typename === 'LayerSet') {
    rec.children = [];
    for (var i = 0; i < l.layers.length; i++) rec.children.push(layerInfo(l.layers[i]));
  }
  return rec;
}
var out = { numDocuments: app.documents.length, documents: [], activeDocument: null };
for (var d = 0; d < app.documents.length; d++) {
  var doc = app.documents[d];
  out.documents.push({ name: doc.name, width: doc.width.value, height: doc.height.value, mode: String(doc.mode), saved: doc.saved });
}
if (app.documents.length) {
  var ad = app.activeDocument;
  var layers = [];
  for (var i = 0; i < ad.layers.length; i++) layers.push(layerInfo(ad.layers[i]));
  out.activeDocument = { name: ad.name, path: (function(){ try { return String(ad.fullName.fsName); } catch(e){ return null; } })(), layers: layers };
}
return out;`;
        return text(await runJSX("ps", jsx, 60000));
      } catch (e) {
        return errText(e);
      }
    }
  );

  server.registerTool(
    "ps_save_preview",
    {
      title: "Preview the active Photoshop document",
      description:
        "Save a flattened PNG copy of the active document and return it inline for visual verification.",
      inputSchema: {
        max_width: z.number().optional().describe("Downscale to at most this width (default 1024)."),
      },
    },
    async ({ max_width }) => {
      try {
        const pngPath = path.join(os.tmpdir(), `adobe_mcp_ps_${Date.now()}.png`);
        const jsx = `
if (!app.documents.length) throw new Error('No document open in Photoshop');
var doc = app.activeDocument;
var f = new File(${JSON.stringify(pngPath)});
var opts = new PNGSaveOptions();
doc.saveAs(f, opts, true, Extension.LOWERCASE);
return { name: doc.name, width: doc.width.value, height: doc.height.value };`;
        const meta = await runJSX("ps", jsx, 120000);
        if (!fs.existsSync(pngPath)) throw new Error("Preview PNG was not written.");
        if (meta.width > (max_width ?? 1024)) await downscalePng(pngPath, max_width ?? 1024);
        const data = fs.readFileSync(pngPath).toString("base64");
        fs.rmSync(pngPath, { force: true });
        return { content: [
          { type: "text", text: JSON.stringify(meta) },
          { type: "image", data, mimeType: "image/png" },
        ] };
      } catch (e) {
        return errText(e);
      }
    }
  );

  server.registerTool(
    "ps_export",
    {
      title: "Export the active Photoshop document",
      description:
        "Export the active document to png/jpg/psd at a path. PSD keeps layers (the format AE imports " +
        "as a layered comp). Registers the file as a workflow asset.",
      inputSchema: {
        output_path: z.string().describe("Absolute output path; extension chooses format (.png/.jpg/.psd)."),
        quality: z.number().optional().describe("JPEG quality 1-12 (default 10)."),
      },
    },
    async ({ output_path, quality }) => {
      try {
        const ext = path.extname(output_path).toLowerCase();
        const jsx = `
if (!app.documents.length) throw new Error('No document open in Photoshop');
var doc = app.activeDocument;
var f = new File(${JSON.stringify(output_path)});
var ext = ${JSON.stringify(ext)};
if (ext === '.png') { doc.saveAs(f, new PNGSaveOptions(), true, Extension.LOWERCASE); }
else if (ext === '.jpg' || ext === '.jpeg') { var jo = new JPEGSaveOptions(); jo.quality = ${quality ?? 10}; doc.saveAs(f, jo, true, Extension.LOWERCASE); }
else if (ext === '.psd') { var po = new PhotoshopSaveOptions(); po.layers = true; doc.saveAs(f, po, true, Extension.LOWERCASE); }
else throw new Error('Unsupported extension ' + ext + ' (use .png/.jpg/.psd)');
return { output: f.fsName, name: doc.name };`;
        const r = await runJSX("ps", jsx, 120000);
        registerAsset({ app: "ps", kind: ext.replace(".", ""), path: r.output, meta: { doc: r.name } });
        return text(r);
      } catch (e) {
        return errText(e);
      }
    }
  );

  server.registerTool(
    "ps_run_action",
    {
      title: "Run a Photoshop action",
      description: "Play a recorded action from an action set (instant reusable 'skill').",
      inputSchema: {
        action: z.string().describe("Action name."),
        action_set: z.string().describe("Action set name."),
      },
    },
    async ({ action, action_set }) => {
      try {
        const jsx = `app.doAction(${JSON.stringify(action)}, ${JSON.stringify(action_set)}); return 'ran';`;
        return text(await runJSX("ps", jsx, 300000));
      } catch (e) {
        return errText(e);
      }
    }
  );
}
