// Premiere Pro adapter — routed through the mcp-bridge CEP panel.
import { z } from "zod";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runJSX, downscalePng, pproPanelAlive } from "../core/bridge.mjs";

export function register(server, { text, errText, registerAsset }) {
  server.registerTool(
    "ppro_run_extendscript",
    {
      title: "Run ExtendScript in Premiere Pro",
      description:
        "Execute ExtendScript inside Premiere via the mcp-bridge panel (must be open: Window → " +
        "Extensions → MCP Bridge). Runs as a function body; end with `return <value>`. Key DOM: " +
        "app.project (rootItem, sequences, importFiles, importAEComps), app.project.activeSequence " +
        "(videoTracks/audioTracks/clips, markers), app.encoder. GOTCHAS: app.enableQE() unlocks qe.* " +
        "(getVideoTransitionList returns an array of name strings; clip.addTransition(trans, atStart, " +
        "'00:00:00:12')); autoReframeSequence needs the motion preset as the STRING 'default'; pre-trim " +
        "cut lists with projectItem.setInPoint/setOutPoint(sec, 4) before createNewSequenceFromClips; " +
        "dynamic-linked comps are named 'Comp/Project.aep'. More: knowledge_search.",
      inputSchema: {
        code: z.string().describe("ExtendScript function body."),
        timeout_seconds: z.number().optional().describe("Max seconds (default 120)."),
      },
    },
    async ({ code, timeout_seconds }) => {
      try {
        const r = await runJSX("ppro", code, (timeout_seconds ?? 120) * 1000);
        return text({ ok: true, result: r === undefined ? null : r });
      } catch (e) {
        return errText(e);
      }
    }
  );

  server.registerTool(
    "ppro_get_state",
    {
      title: "Inspect the open Premiere project",
      description:
        "Project name/path, bin tree, sequences with track/clip inventory (clip name, start, end, " +
        "duration in seconds). Also reports whether the bridge panel is alive.",
      inputSchema: {},
    },
    async () => {
      try {
        if (!pproPanelAlive()) return text({ panelAlive: false, hint: "Open Window → Extensions → MCP Bridge in Premiere." });
        const jsx = `
function binTree(item){
  var rec = { name: item.name, type: 'bin', children: [] };
  for (var i = 0; i < item.children.numItems; i++) {
    var c = item.children[i];
    if (c.type === ProjectItemType.BIN) rec.children.push(binTree(c));
    else rec.children.push({ name: c.name, type: (c.type === ProjectItemType.CLIP ? 'clip' : 'file'),
      media: (function(){ try { return String(c.getMediaPath()); } catch(e){ return null; } })() });
  }
  return rec;
}
var p = app.project;
var out = { name: p.name, path: String(p.path), bins: binTree(p.rootItem), sequences: [], activeSequence: null };
for (var s = 0; s < p.sequences.numSequences; s++) out.sequences.push(p.sequences[s].name);
var seq = p.activeSequence;
if (seq) {
  var so = { name: seq.name, videoTracks: [], audioTracks: [] };
  for (var v = 0; v < seq.videoTracks.numTracks; v++) {
    var tr = seq.videoTracks[v]; var clips = [];
    for (var c = 0; c < tr.clips.numItems; c++) {
      var cl = tr.clips[c];
      clips.push({ name: cl.name, start: cl.start.seconds, end: cl.end.seconds });
    }
    so.videoTracks.push({ index: v, clips: clips });
  }
  for (var a = 0; a < seq.audioTracks.numTracks; a++) {
    var tra = seq.audioTracks[a]; var aclips = [];
    for (var c2 = 0; c2 < tra.clips.numItems; c2++) {
      var cla = tra.clips[c2];
      aclips.push({ name: cla.name, start: cla.start.seconds, end: cla.end.seconds });
    }
    so.audioTracks.push({ index: a, clips: aclips });
  }
  out.activeSequence = so;
}
return out;`;
        return text(await runJSX("ppro", jsx, 60000));
      } catch (e) {
        return errText(e);
      }
    }
  );

  server.registerTool(
    "ppro_import_media",
    {
      title: "Import media files into Premiere",
      description: "Import files into the project root (or a named bin, created if missing).",
      inputSchema: {
        paths: z.array(z.string()).describe("Absolute file paths to import."),
        bin_name: z.string().optional().describe("Target bin name."),
      },
    },
    async ({ paths, bin_name }) => {
      try {
        const jsx = `
var p = app.project;
var target = p.rootItem;
${bin_name ? `
var found = null;
for (var i = 0; i < p.rootItem.children.numItems; i++) {
  var c = p.rootItem.children[i];
  if (c.type === ProjectItemType.BIN && c.name === ${JSON.stringify(bin_name)}) { found = c; break; }
}
target = found || p.rootItem.createBin(${JSON.stringify(bin_name)});` : ""}
var ok = p.importFiles(${JSON.stringify(paths)}, true, target, false);
return { imported: ok, count: ${paths.length} };`;
        return text(await runJSX("ppro", jsx, 120000));
      } catch (e) {
        return errText(e);
      }
    }
  );

  server.registerTool(
    "ppro_import_ae_comp",
    {
      title: "Dynamic Link an AE comp into Premiere",
      description:
        "Import comps from an After Effects project file via Dynamic Link — no intermediate render; " +
        "AE edits update the Premiere timeline live.",
      inputSchema: {
        aep_path: z.string().describe("Absolute path to the .aep project file (must be saved)."),
        comp_names: z.array(z.string()).describe("Comp names to link."),
      },
    },
    async ({ aep_path, comp_names }) => {
      try {
        const jsx = `
var ok = app.project.importAEComps(${JSON.stringify(aep_path)}, ${JSON.stringify(comp_names)});
return { linked: ok, comps: ${JSON.stringify(comp_names)} };`;
        return text(await runJSX("ppro", jsx, 120000));
      } catch (e) {
        return errText(e);
      }
    }
  );

  server.registerTool(
    "ppro_save_frame",
    {
      title: "Export a frame of the active Premiere sequence",
      description: "Render one frame of the active sequence to PNG and return it inline.",
      inputSchema: {
        seconds: z.number().optional().describe("Time in seconds (default: playhead)."),
        max_width: z.number().optional().describe("Downscale to at most this width (default 1024)."),
      },
    },
    async ({ seconds, max_width }) => {
      try {
        const pngPath = path.join(os.tmpdir(), `adobe_mcp_ppro_${Date.now()}.png`);
        const jsx = `
var seq = app.project.activeSequence;
if (!seq) throw new Error('No active sequence');
var t = ${seconds !== undefined ? JSON.stringify(seconds) : "seq.getPlayerPosition().seconds"};
if (typeof seq.exportFramePNG !== 'function') throw new Error('exportFramePNG not available in this Premiere version');
var tick = new Time(); tick.seconds = t;
seq.exportFramePNG(tick.ticks, ${JSON.stringify(pngPath)});
var fs2 = seq.getSettings();
return { time: t, width: fs2.videoFrameWidth, height: fs2.videoFrameHeight };`;
        const meta = await runJSX("ppro", jsx, 120000);
        let ok = false;
        for (let i = 0; i < 50; i++) {
          if (fs.existsSync(pngPath) && fs.statSync(pngPath).size > 0) { ok = true; break; }
          await new Promise((r) => setTimeout(r, 150));
        }
        if (!ok) throw new Error("Frame export did not produce a PNG.");
        if ((meta.width ?? 1920) > (max_width ?? 1024)) await downscalePng(pngPath, max_width ?? 1024);
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
    "ppro_export_sequence",
    {
      title: "Export the active Premiere sequence",
      description:
        "Render the active sequence to a file using an Adobe .epr encoder preset (searches Premiere's " +
        "system presets for a match-source H.264 preset by default). Registers the output as an asset.",
      inputSchema: {
        output_path: z.string().describe("Absolute output path (e.g. ~/Desktop/edit.mp4)."),
        preset_path: z.string().optional().describe("Absolute path to an .epr preset (default: Match Source H.264)."),
        work_area_only: z.boolean().optional().describe("Export work area only (default false)."),
        timeout_seconds: z.number().optional().describe("Max seconds (default 570)."),
      },
    },
    async ({ output_path, preset_path, work_area_only, timeout_seconds }) => {
      try {
        let preset = preset_path;
        if (!preset) {
          const roots = fs.readdirSync("/Applications").filter((d) => /^Adobe Premiere Pro/.test(d));
          outer: for (const r of roots.sort().reverse()) {
            const base = path.join("/Applications", r);
            const stack = [base];
            while (stack.length) {
              const dir = stack.pop();
              let entries = [];
              try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
              for (const e of entries) {
                const full = path.join(dir, e.name);
                if (e.isDirectory()) stack.push(full);
                else if (/Match Source.*(Adaptive|High).*\.epr$/i.test(e.name) || /HighQuality.*720|1080.*\.epr$/i.test(e.name)) {
                  preset = full; break outer;
                }
              }
            }
          }
        }
        if (!preset) throw new Error("No .epr encoder preset found — pass preset_path explicitly.");
        const jsx = `
var seq = app.project.activeSequence;
if (!seq) throw new Error('No active sequence');
var res = seq.exportAsMediaDirect(${JSON.stringify(output_path)}, ${JSON.stringify(preset)}, ${work_area_only ? 1 : 0});
return { result: String(res), output: ${JSON.stringify(output_path)} };`;
        const r = await runJSX("ppro", jsx, (timeout_seconds ?? 570) * 1000);
        registerAsset({ app: "ppro", kind: "video", path: output_path, meta: { preset } });
        return text(r);
      } catch (e) {
        return errText(e);
      }
    }
  );
}
