// After Effects adapter.
import { z } from "zod";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runJSX, downscalePng } from "../core/bridge.mjs";

const FIND_COMP = `
function __findComp(name) {
  for (var i = 1; i <= app.project.numItems; i++) {
    var it = app.project.items[i];
    if (it instanceof CompItem && it.name === name) return it;
  }
  return null;
}
`;

export function register(server, { text, errText, registerAsset }) {
  server.registerTool(
    "ae_run_extendscript",
    {
      title: "Run ExtendScript in After Effects",
      description:
        "Execute ExtendScript (JSX) inside After Effects and return the result. Runs as a function " +
        "body: end with `return <value>` (JSON-serialized). ES3 only — no arrow functions, template " +
        "literals, let/const, JSON, Array.map. Collections are 1-indexed. Wrapped in one undo group. " +
        "GOTCHAS: text wiggly selector matchName is 'ADBE Text Wiggly Selector'; seamless noise loops = " +
        "Evolution expression time*(360/duration) + Cycle Evolution on; PSD-imported comps need nested " +
        "durations extended and anchors re-placed from PS pixel bounds. More: knowledge_search.",
      inputSchema: {
        code: z.string().describe("ExtendScript function body; `return` sends back a result."),
        timeout_seconds: z.number().optional().describe("Max seconds (default 120)."),
      },
    },
    async ({ code, timeout_seconds }) => {
      try {
        const r = await runJSX("ae", code, (timeout_seconds ?? 120) * 1000);
        return text({ ok: true, result: r === undefined ? null : r });
      } catch (e) {
        return errText(e);
      }
    }
  );

  server.registerTool(
    "ae_get_state",
    {
      title: "Inspect the open AE project",
      description:
        "Project item tree (comps, footage, folders) with sizes/durations/layer counts, or one comp's " +
        "layers in detail (kind, timing, transform, text, effects) via comp_name.",
      inputSchema: {
        comp_name: z.string().optional().describe("Comp to inspect in layer-level detail."),
      },
    },
    async ({ comp_name }) => {
      try {
        const jsx =
          comp_name == null
            ? `
var proj = app.project;
var out = { projectFile: proj.file ? String(proj.file.fsName) : null,
  activeComp: (proj.activeItem && proj.activeItem instanceof CompItem) ? proj.activeItem.name : null,
  numItems: proj.numItems, items: [] };
for (var i = 1; i <= proj.numItems; i++) {
  var it = proj.items[i];
  var rec = { index: i, name: it.name, type: it.typeName };
  if (it.parentFolder && it.parentFolder.name !== 'Root') rec.folder = it.parentFolder.name;
  if (it instanceof CompItem) { rec.width = it.width; rec.height = it.height; rec.duration = it.duration; rec.frameRate = it.frameRate; rec.numLayers = it.numLayers; }
  else if (it instanceof FootageItem) { if (it.file) rec.file = String(it.file.fsName); rec.width = it.width; rec.height = it.height; }
  else if (it instanceof FolderItem) { rec.numItems = it.numItems; }
  out.items.push(rec);
}
return out;`
            : `
${FIND_COMP}
var comp = __findComp(${JSON.stringify(comp_name)});
if (!comp) throw new Error('No comp named ' + ${JSON.stringify(comp_name)});
var out = { name: comp.name, width: comp.width, height: comp.height, duration: comp.duration,
  frameRate: comp.frameRate, currentTime: comp.time, numLayers: comp.numLayers, layers: [] };
for (var i = 1; i <= comp.numLayers; i++) {
  var L = comp.layers[i];
  var rec = { index: i, name: L.name, enabled: L.enabled, inPoint: L.inPoint, outPoint: L.outPoint,
    parentIndex: L.parent ? L.parent.index : null };
  if (L instanceof TextLayer) { rec.kind='text'; try { var td=L.property('Source Text').value; rec.text=td.text; rec.font=td.font; rec.fontSize=td.fontSize; } catch(e){} }
  else if (L instanceof ShapeLayer) rec.kind='shape';
  else if (L instanceof CameraLayer) rec.kind='camera';
  else if (L instanceof LightLayer) rec.kind='light';
  else if (L instanceof AVLayer) { rec.kind=(L.source && L.source instanceof CompItem)?'precomp':'av'; if (L.source) rec.sourceName=L.source.name; }
  else rec.kind='other';
  try { var tr=L.property('Transform');
    rec.position=tr.property('Position').value; rec.scale=tr.property('Scale').value; rec.opacity=tr.property('Opacity').value; } catch(e){}
  try { var fx=L.property('Effects');
    if (fx && fx.numProperties>0){ rec.effects=[]; for (var e2=1;e2<=fx.numProperties;e2++) rec.effects.push({name:fx.property(e2).name, matchName:fx.property(e2).matchName}); } } catch(e){}
  out.layers.push(rec);
}
return out;`;
        return text(await runJSX("ae", jsx, 60000));
      } catch (e) {
        return errText(e);
      }
    }
  );

  server.registerTool(
    "ae_save_frame",
    {
      title: "Render an AE comp frame to PNG",
      description:
        "Render one frame of a comp and return it inline so you can visually verify work. AE 2022+.",
      inputSchema: {
        comp_name: z.string().describe("Composition to render."),
        time: z.number().optional().describe("Seconds (default: comp's current time)."),
        max_width: z.number().optional().describe("Downscale to at most this width (default 1024)."),
      },
    },
    async ({ comp_name, time, max_width }) => {
      try {
        const pngPath = path.join(os.tmpdir(), `adobe_mcp_frame_${Date.now()}.png`);
        const jsx = `
${FIND_COMP}
var comp = __findComp(${JSON.stringify(comp_name)});
if (!comp) throw new Error('No comp named ' + ${JSON.stringify(comp_name)});
if (typeof comp.saveFrameToPng !== 'function') throw new Error('saveFrameToPng requires AE 2022+');
var t = ${time === undefined ? "comp.time" : JSON.stringify(time)};
comp.saveFrameToPng(t, new File(${JSON.stringify(pngPath)}));
return { time: t, width: comp.width, height: comp.height };`;
        const meta = await runJSX("ae", jsx, 120000);
        let ok = false;
        for (let i = 0; i < 50; i++) {
          if (fs.existsSync(pngPath) && fs.statSync(pngPath).size > 0) {
            const s1 = fs.statSync(pngPath).size;
            await new Promise((r) => setTimeout(r, 150));
            if (fs.statSync(pngPath).size === s1) { ok = true; break; }
          } else await new Promise((r) => setTimeout(r, 150));
        }
        if (!ok) throw new Error("Frame render did not produce a PNG.");
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
    "ae_render_comp",
    {
      title: "Render an AE comp via the Render Queue",
      description:
        "Queue a comp and render it to disk (blocks until finished). Uses an H.264 output module " +
        "template when available, else Lossless MOV. Registers the output as a workflow asset. " +
        "If the call times out, the render may still have completed — check the output file " +
        "(stable size, right duration) before re-queueing.",
      inputSchema: {
        comp_name: z.string().describe("Composition to render."),
        output_path: z.string().optional().describe("Absolute output path (default ~/Desktop/<comp>.mp4)."),
        om_template: z.string().optional().describe("Output module template name override."),
        timeout_seconds: z.number().optional().describe("Max seconds (default 570)."),
      },
    },
    async ({ comp_name, output_path, om_template, timeout_seconds }) => {
      try {
        const jsx = `
${FIND_COMP}
var comp = __findComp(${JSON.stringify(comp_name)});
if (!comp) throw new Error('No comp named ' + ${JSON.stringify(comp_name)});
var rq = app.project.renderQueue;
while (rq.numItems > 0) rq.item(1).remove();
var it = rq.items.add(comp);
var om = it.outputModule(1);
var chosen = ${om_template ? JSON.stringify(om_template) : "null"};
if (!chosen) {
  for (var t = 0; t < om.templates.length; t++) {
    if (om.templates[t].indexOf('H.264 - Match Render Settings - 15') === 0) { chosen = om.templates[t]; break; }
  }
  if (!chosen) for (var t2 = 0; t2 < om.templates.length; t2++) { if (om.templates[t2].indexOf('H.264') === 0) { chosen = om.templates[t2]; break; } }
  if (!chosen) chosen = 'Lossless';
}
om.applyTemplate(chosen);
var ext = (chosen.indexOf('H.264') === 0) ? '.mp4' : '.mov';
var outPath = ${output_path ? JSON.stringify(output_path) : "Folder('~/Desktop').fsName + '/' + comp.name.replace(/[^\\w\\- ]/g,'_') + ext"};
om.file = new File(outPath);
try { it.applyTemplate('Best Settings'); } catch (e) {}
rq.render();
var f = new File(outPath);
return { rendered: it.status === RQItemStatus.DONE, template: chosen, output: f.fsName, bytes: f.exists ? f.length : 0 };`;
        const r = await runJSX("ae", jsx, (timeout_seconds ?? 570) * 1000);
        if (r && r.rendered && r.output) registerAsset({ app: "ae", kind: "video", path: r.output, meta: { comp: comp_name } });
        return text(r);
      } catch (e) {
        return errText(e);
      }
    }
  );
}
