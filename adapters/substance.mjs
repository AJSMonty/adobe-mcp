// Substance 3D Painter adapter — Python via the remote-scripting HTTP endpoint (port 60041).
import { z } from "zod";
import fs from "node:fs";
import { runPainter } from "../core/pybridge.mjs";

const STATE_PY = `
import substance_painter.project as sp_proj
import substance_painter.textureset as sp_ts
import substance_painter.layerstack as sp_ls
if not sp_proj.is_open():
    result = {"project_open": False}
else:
    sets = []
    for ts in sp_ts.all_texture_sets():
        rec = {"name": ts.name(), "stacks": []}
        try:
            res = ts.get_resolution(); rec["resolution"] = [res.width, res.height]
        except Exception as e:
            rec["resolution"] = str(e)
        for st in ts.all_stacks():
            srec = {"name": st.name(), "channels": [], "layers": []}
            try:
                srec["channels"] = sorted(str(k).split(".")[-1] for k in st.all_channels().keys())
            except Exception:
                pass
            try:
                srec["layers"] = [n.get_name() for n in sp_ls.get_root_layer_nodes(st)][:100]
            except Exception:
                pass
            rec["stacks"].append(srec)
        sets.append(rec)
    result = {"project_open": True, "name": sp_proj.name(), "file": sp_proj.file_path(),
              "dirty": sp_proj.needs_saving() if hasattr(sp_proj, "needs_saving") else None,
              "texture_sets": sets}
`;

export function register(server, { text, errText, registerAsset }) {
  server.registerTool(
    "substance_run_python",
    {
      title: "Run Python in Substance 3D Painter",
      description:
        "Execute Python inside Substance 3D Painter (modules: substance_painter.project, .textureset, " +
        ".layerstack, .baking, .export, .resource, .colormanagement). Runs as a module body; set " +
        "`result = <value>` to return JSON. Requires Painter launched with --enable-remote-scripting " +
        "(port 60041). ALWAYS guard with substance_painter.project.is_open(). Wrap layer edits in " +
        "`with substance_painter.layerstack.ScopedModification('name'):` so they are one undo step. " +
        "GOTCHAS: baking is ASYNC — bake_*_async() returns immediately; never block/sleep the main thread " +
        "waiting for it (Painter deadlocks). There is no bake_mesh_maps(). More: knowledge_search app=substance.",
      inputSchema: {
        code: z.string().describe("Python source; assign `result` to return data."),
        timeout_seconds: z.number().optional().describe("Max seconds (default 120)."),
      },
    },
    async ({ code, timeout_seconds }) => {
      try {
        return text({ ok: true, ...(await runPainter(code, { timeoutMs: (timeout_seconds ?? 120) * 1000 })) });
      } catch (e) {
        return errText(e);
      }
    }
  );

  server.registerTool(
    "substance_get_state",
    {
      title: "Inspect the open Substance Painter project",
      description: "Project name/file and every texture set with resolution, stacks, channels and root layers.",
      inputSchema: {},
    },
    async () => {
      try {
        return text((await runPainter(STATE_PY, { timeoutMs: 60000 })).result);
      } catch (e) {
        return errText(e);
      }
    }
  );

  server.registerTool(
    "substance_bake_mesh_maps",
    {
      title: "Bake mesh maps in Substance Painter",
      description:
        "Start baking mesh maps (normal, AO, curvature, thickness, position, world-space normal, ID) — " +
        "smart materials and generators need curvature/AO to find edges and cavities. Optionally set " +
        "the bake resolution first. Baking is ASYNC: this returns once the bake has STARTED; poll " +
        "substance_get_state or just proceed — Painter queues edits behind the bake.",
      inputSchema: {
        texture_sets: z.array(z.string()).optional().describe("Texture set names (default: all)."),
        size_log2: z.number().int().min(7).max(13).optional().describe("Output size as log2 (11 = 2048)."),
      },
    },
    async ({ texture_sets, size_log2 }) => {
      try {
        const py = `
import substance_painter.project as sp_proj
import substance_painter.textureset as sp_ts
import substance_painter.baking as sp_bake
if not sp_proj.is_open():
    raise RuntimeError("No Substance Painter project is open")
wanted = ${JSON.stringify(texture_sets ?? null)}
targets = [t for t in sp_ts.all_texture_sets() if wanted is None or t.name() in wanted]
if not targets:
    raise RuntimeError("No matching texture sets: %s" % wanted)
notes = []
size_log2 = ${size_log2 ?? "None"}
if size_log2 is not None:
    for t in targets:
        try:
            params = sp_bake.BakingParameters.from_texture_set(t)
            common = params.common()
            params.set({common["OutputSize"]: (size_log2, size_log2)})
        except Exception as e:
            notes.append("size on %s not set: %s" % (t.name(), e))
started = []
if hasattr(sp_bake, "bake_async"):
    for t in targets:
        sp_bake.bake_async(t); started.append(t.name())
elif hasattr(sp_bake, "bake_selected_textures_async"):
    sp_bake.bake_selected_textures_async(); started = [t.name() for t in targets]
else:
    raise RuntimeError("This Painter version exposes no async baking API")
result = {"bake_started": started, "notes": notes}
`;
        return text((await runPainter(py, { timeoutMs: 60000 })).result);
      } catch (e) {
        return errText(e);
      }
    }
  );

  server.registerTool(
    "substance_export_textures",
    {
      title: "Export PBR texture maps from Substance Painter",
      description:
        "Export the project's textures with an export preset (default the starter-assets 'PBR Metallic " +
        "Roughness': BaseColor, Metallic, Roughness, Normal, Height/Displacement, AO). Registers each " +
        "written map as a workflow asset so Blender can pick them up for the beauty render.",
      inputSchema: {
        output_dir: z.string().describe("Absolute export folder."),
        preset: z.string().optional().describe("Starter-assets export preset name (default 'PBR Metallic Roughness')."),
        file_format: z.enum(["png", "exr", "tif", "jpeg", "tga"]).optional().describe("Default png."),
        bit_depth: z.enum(["8", "16", "32f"]).optional().describe("Default 16 (8 for jpeg)."),
        size_log2: z.number().int().min(7).max(13).optional().describe("11 = 2048, 12 = 4096 (default: texture set size)."),
        texture_sets: z.array(z.string()).optional().describe("Texture set names (default: all)."),
      },
    },
    async ({ output_dir, preset, file_format, bit_depth, size_log2, texture_sets }) => {
      try {
        fs.mkdirSync(output_dir, { recursive: true });
        const fmt = file_format ?? "png";
        const depth = bit_depth ?? (fmt === "jpeg" ? "8" : "16");
        const py = `
import substance_painter.project as sp_proj
import substance_painter.textureset as sp_ts
import substance_painter.export as sp_exp
import substance_painter.resource as sp_res
if not sp_proj.is_open():
    raise RuntimeError("No Substance Painter project is open")
wanted = ${JSON.stringify(texture_sets ?? null)}
names = [t.name() for t in sp_ts.all_texture_sets() if wanted is None or t.name() in wanted]
params = {"fileFormat": ${JSON.stringify(fmt)}, "bitDepth": ${JSON.stringify(depth)}, "dithering": True, "paddingAlgorithm": "infinite"}
size_log2 = ${size_log2 ?? "None"}
if size_log2 is not None:
    params["sizeLog2"] = size_log2
config = {
    "exportShaderParams": False,
    "exportPath": ${JSON.stringify(output_dir)},
    "defaultExportPreset": sp_res.ResourceID(context="starter_assets", name=${JSON.stringify(preset ?? "PBR Metallic Roughness")}).url(),
    "exportList": [{"rootPath": n} for n in names],
    "exportParameters": [{"parameters": params}],
}
res = sp_exp.export_project_textures(config)
files = []
for _k, paths in (res.textures or {}).items():
    files.extend(paths)
result = {"status": str(res.status), "message": res.message, "files": files}
`;
        const r = (await runPainter(py, { timeoutMs: 600000 })).result;
        for (const f of r.files || []) registerAsset({ app: "substance", kind: "texture", path: f, meta: { preset: preset ?? "PBR Metallic Roughness" } });
        return text(r);
      } catch (e) {
        return errText(e);
      }
    }
  );
}
