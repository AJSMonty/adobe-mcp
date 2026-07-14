// Illustrator adapter.
import { z } from "zod";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runJSX, downscalePng } from "../core/bridge.mjs";

export function register(server, { text, errText, registerAsset }) {
  server.registerTool(
    "ai_run_extendscript",
    {
      title: "Run ExtendScript in Illustrator",
      description:
        "Execute ExtendScript (JSX) inside Illustrator and return the result. Runs as a function body: " +
        "end with `return <value>`. ES3 only. Key DOM: app.documents, activeDocument, artboards, " +
        "layers, pathItems (setEntirePath), textFrames, groupItems, symbols. Colors via new RGBColor(). " +
        "GOTCHAS: exports/previews act on the ACTIVE document — activate by name first; documents.add() " +
        "switches the active doc; no blend API (interpolate shapes in a loop); artboardRect is " +
        "[0, H, W, 0] with Y up. More: knowledge_search.",
      inputSchema: {
        code: z.string().describe("ExtendScript function body."),
        timeout_seconds: z.number().optional().describe("Max seconds (default 120)."),
      },
    },
    async ({ code, timeout_seconds }) => {
      try {
        const r = await runJSX("ai", code, (timeout_seconds ?? 120) * 1000);
        return text({ ok: true, result: r === undefined ? null : r });
      } catch (e) {
        return errText(e);
      }
    }
  );

  server.registerTool(
    "ai_get_state",
    {
      title: "Inspect open Illustrator documents",
      description:
        "Lists open documents; for the active document returns artboards (name, rect), layers with " +
        "item counts, and text frame contents.",
      inputSchema: {},
    },
    async () => {
      try {
        const jsx = `
var out = { numDocuments: app.documents.length, documents: [], activeDocument: null };
for (var d = 0; d < app.documents.length; d++) {
  out.documents.push({ name: app.documents[d].name, width: app.documents[d].width, height: app.documents[d].height });
}
if (app.documents.length) {
  var doc = app.activeDocument;
  var abs = [];
  for (var a = 0; a < doc.artboards.length; a++) {
    var r = doc.artboards[a].artboardRect;
    abs.push({ index: a, name: doc.artboards[a].name, rect: [Math.round(r[0]), Math.round(r[1]), Math.round(r[2]), Math.round(r[3])] });
  }
  var lys = [];
  for (var l = 0; l < doc.layers.length; l++) {
    var L = doc.layers[l];
    lys.push({ name: L.name, visible: L.visible, locked: L.locked,
      pathItems: L.pathItems.length, groupItems: L.groupItems.length, textFrames: L.textFrames.length });
  }
  var txts = [];
  for (var t = 0; t < doc.textFrames.length && t < 40; t++) txts.push(doc.textFrames[t].contents.slice(0, 120));
  out.activeDocument = { name: doc.name, artboards: abs, layers: lys, textSamples: txts,
    path: (function(){ try { return String(doc.fullName.fsName); } catch(e){ return null; } })() };
}
return out;`;
        return text(await runJSX("ai", jsx, 60000));
      } catch (e) {
        return errText(e);
      }
    }
  );

  server.registerTool(
    "ai_save_preview",
    {
      title: "Preview an Illustrator artboard",
      description:
        "Export the active document (active or given artboard) as PNG and return it inline for visual " +
        "verification.",
      inputSchema: {
        artboard_index: z.number().optional().describe("Artboard index (default: active)."),
        max_width: z.number().optional().describe("Downscale to at most this width (default 1024)."),
      },
    },
    async ({ artboard_index, max_width }) => {
      try {
        const pngPath = path.join(os.tmpdir(), `adobe_mcp_ai_${Date.now()}.png`);
        const jsx = `
if (!app.documents.length) throw new Error('No document open in Illustrator');
var doc = app.activeDocument;
${artboard_index !== undefined ? `doc.artboards.setActiveArtboardIndex(${artboard_index});` : ""}
var f = new File(${JSON.stringify(pngPath)});
var opts = new ExportOptionsPNG24();
opts.artBoardClipping = true;
opts.antiAliasing = true;
doc.exportFile(f, ExportType.PNG24, opts);
var r = doc.artboards[doc.artboards.getActiveArtboardIndex()].artboardRect;
return { name: doc.name, artboard: doc.artboards.getActiveArtboardIndex(), width: Math.round(r[2]-r[0]), height: Math.round(r[1]-r[3]) };`;
        const meta = await runJSX("ai", jsx, 120000);
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
    "ai_export",
    {
      title: "Export the active Illustrator document",
      description:
        "Export to svg/png/pdf, or save a layered .ai copy (the format AE imports as a layered comp). " +
        "Exports the ACTIVE document — set app.activeDocument to the right one first. " +
        "Registers the file as a workflow asset.",
      inputSchema: {
        output_path: z.string().describe("Absolute output path; extension chooses format (.svg/.png/.pdf/.ai)."),
        scale: z.number().optional().describe("PNG scale percent (default 100)."),
      },
    },
    async ({ output_path, scale }) => {
      try {
        const ext = path.extname(output_path).toLowerCase();
        const jsx = `
if (!app.documents.length) throw new Error('No document open in Illustrator');
var doc = app.activeDocument;
var f = new File(${JSON.stringify(output_path)});
var ext = ${JSON.stringify(ext)};
if (ext === '.svg') { var so = new ExportOptionsSVG(); doc.exportFile(f, ExportType.SVG, so); }
else if (ext === '.png') { var po = new ExportOptionsPNG24(); po.artBoardClipping = true; po.horizontalScale = ${scale ?? 100}; po.verticalScale = ${scale ?? 100}; doc.exportFile(f, ExportType.PNG24, po); }
else if (ext === '.pdf') { var pd = new PDFSaveOptions(); doc.saveAs(f, pd); }
else if (ext === '.ai') { var ao = new IllustratorSaveOptions(); doc.saveAs(f, ao); }
else throw new Error('Unsupported extension ' + ext + ' (use .svg/.png/.pdf/.ai)');
return { output: f.fsName, name: doc.name };`;
        const r = await runJSX("ai", jsx, 120000);
        registerAsset({ app: "ai", kind: ext.replace(".", ""), path: r.output, meta: { doc: r.name } });
        return text(r);
      } catch (e) {
        return errText(e);
      }
    }
  );
}
