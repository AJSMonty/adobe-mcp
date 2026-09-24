// Blender adapter — Python (bpy) via the live add-on or a headless background process.
import { z } from "zod";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runBlender, blenderSaveSnippet } from "../core/pybridge.mjs";

const MODE = z
  .enum(["auto", "live", "background"])
  .optional()
  .describe(
    "live = the running Blender (needs the adobe-mcp add-on), background = headless process, " +
      "auto (default) = live if the add-on answers and no blend_file is given, else background."
  );
const BLEND = z
  .string()
  .optional()
  .describe("Absolute .blend path to open (background mode). Without it background starts from factory settings.");

const STATE_PY = `
import bpy
s = bpy.context.scene
r = s.render
objs = []
for o in s.objects:
    rec = {"name": o.name, "type": o.type, "location": [round(v, 4) for v in o.location],
           "rotation_euler": [round(v, 4) for v in o.rotation_euler], "scale": [round(v, 4) for v in o.scale],
           "parent": o.parent.name if o.parent else None, "hide_render": o.hide_render,
           "animated": bool(o.animation_data and o.animation_data.action)}
    if o.type == "CAMERA":
        rec["lens_mm"] = o.data.lens; rec["sensor_mm"] = o.data.sensor_width
        rec["dof"] = {"use": o.data.dof.use_dof, "fstop": o.data.dof.aperture_fstop,
                      "focus_object": o.data.dof.focus_object.name if o.data.dof.focus_object else None}
    elif o.type == "ARMATURE":
        rec["bones"] = [b.name for b in o.data.bones][:200]
    elif o.type == "MESH":
        rec["verts"] = len(o.data.vertices); rec["materials"] = [m.name for m in o.data.materials if m]
    objs.append(rec)
vl = bpy.context.view_layer
passes = [p for p in ("use_pass_z", "use_pass_mist", "use_pass_normal", "use_pass_ambient_occlusion",
                      "use_pass_cryptomatte_object") if getattr(vl, p, False)]
if getattr(getattr(vl, "cycles", None), "use_pass_shadow_catcher", False):
    passes.append("use_pass_shadow_catcher")
result = {
    "blender": bpy.app.version_string, "file": bpy.data.filepath or None, "scene": s.name,
    "frame_range": [s.frame_start, s.frame_end], "frame_current": s.frame_current,
    "fps": round(r.fps / r.fps_base, 3), "resolution": [r.resolution_x, r.resolution_y, r.resolution_percentage],
    "engine": r.engine, "motion_blur": r.use_motion_blur, "shutter": r.motion_blur_shutter,
    "camera": s.camera.name if s.camera else None, "output": r.filepath,
    "file_format": r.image_settings.file_format, "passes": passes,
    "unit_scale": s.unit_settings.scale_length, "objects": objs,
}
`;

export function register(server, { text, errText, registerAsset }) {
  server.registerTool(
    "blender_run_python",
    {
      title: "Run Python (bpy) in Blender",
      description:
        "Execute Python inside Blender with bpy available. Runs as a module body; set `result = <value>` " +
        "to return JSON (print() output comes back as stdout). Check objects exist before touching them " +
        "(bpy.data.objects.get(name)). Work in real-world meters/seconds; key animation with keyframe_insert. " +
        "In background mode nothing persists unless you pass save_as (or call bpy.ops.wm.save_mainfile). " +
        "GOTCHAS: Blender 5.x compositor lives in scene.compositing_node_group (scene.node_tree is gone); " +
        "EEVEE engine id is 'BLENDER_EEVEE_NEXT' in 4.2–4.5 but 'BLENDER_EEVEE' in 5.x. More: knowledge_search app=blender.",
      inputSchema: {
        code: z.string().describe("Python source; assign `result` to return data."),
        mode: MODE,
        blend_file: BLEND,
        save_as: z.string().optional().describe("Absolute .blend path to save to after the code runs."),
        timeout_seconds: z.number().optional().describe("Max seconds (default 120)."),
      },
    },
    async ({ code, mode, blend_file, save_as, timeout_seconds }) => {
      try {
        const full = save_as
          ? `${code}\n${blenderSaveSnippet(save_as)}`
          : code;
        const r = await runBlender(full, { mode, blendFile: blend_file, timeoutMs: (timeout_seconds ?? 120) * 1000 });
        if (save_as) registerAsset({ app: "blender", kind: "blend", path: save_as, meta: {} });
        return text({ ok: true, ...r });
      } catch (e) {
        return errText(e);
      }
    }
  );

  server.registerTool(
    "blender_get_state",
    {
      title: "Inspect the Blender scene",
      description:
        "Scene summary: version, file, frame range, fps, resolution, engine, motion blur, active camera " +
        "(lens/DoF), enabled render passes, and every object (type, transform, parent, animated, bones).",
      inputSchema: { mode: MODE, blend_file: BLEND },
    },
    async ({ mode, blend_file }) => {
      try {
        const r = await runBlender(STATE_PY, { mode, blendFile: blend_file, timeoutMs: 60000 });
        return text({ ...r.result, bridge_mode: r.mode });
      } catch (e) {
        return errText(e);
      }
    }
  );

  server.registerTool(
    "blender_render_frame",
    {
      title: "Render a Blender frame to PNG",
      description:
        "Render one frame through the scene camera and return it inline so you can visually verify " +
        "blocking, lighting and framing. Uses a reduced resolution and sample count for speed; scene " +
        "render settings are restored afterwards.",
      inputSchema: {
        frame: z.number().int().optional().describe("Frame to render (default: current frame)."),
        max_width: z.number().optional().describe("Preview width in px (default 960)."),
        samples: z.number().int().optional().describe("Cycles/EEVEE samples for the preview (default 16)."),
        mode: MODE,
        blend_file: BLEND,
        timeout_seconds: z.number().optional().describe("Max seconds (default 300)."),
      },
    },
    async ({ frame, max_width, samples, mode, blend_file, timeout_seconds }) => {
      const pngPath = path.join(os.tmpdir(), `adobe_mcp_blender_${Date.now()}.png`);
      try {
        const py = `
import bpy
s = bpy.context.scene
r = s.render
if s.camera is None:
    raise RuntimeError("Scene has no active camera (set scene.camera)")
saved = dict(fp=r.filepath, fmt=r.image_settings.file_format, pct=r.resolution_percentage,
             frame=s.frame_current, mode=r.image_settings.color_mode,
             media=getattr(r.image_settings, "media_type", None), comp=r.use_compositing)
cy_samples = s.cycles.samples if r.engine == "CYCLES" else None
ee = getattr(s, "eevee", None)
ee_samples = ee.taa_render_samples if ee is not None and hasattr(ee, "taa_render_samples") else None
try:
    frame = ${frame === undefined ? "s.frame_current" : Number(frame)}
    s.frame_set(frame)
    r.use_compositing = False   # File Output nodes would write the preview into the pass sequences
    r.resolution_percentage = max(1, min(100, int(100 * ${Number(max_width ?? 960)} / max(1, r.resolution_x))))
    if cy_samples is not None: s.cycles.samples = ${Number(samples ?? 16)}
    if ee_samples is not None: ee.taa_render_samples = ${Number(samples ?? 16)}
    if saved["media"] is not None:
        r.image_settings.media_type = "IMAGE"   # Blender 5.x
    r.image_settings.file_format = "PNG"
    r.image_settings.color_mode = "RGBA"
    r.filepath = ${JSON.stringify(pngPath)}
    bpy.ops.render.render(write_still=True)
    result = {"frame": frame, "engine": r.engine, "camera": s.camera.name,
              "size": [r.resolution_x * r.resolution_percentage // 100, r.resolution_y * r.resolution_percentage // 100]}
finally:
    r.filepath = saved["fp"]
    r.use_compositing = saved["comp"]
    if saved["media"] is not None:
        r.image_settings.media_type = saved["media"]
    r.image_settings.file_format = saved["fmt"]
    r.image_settings.color_mode = saved["mode"]; r.resolution_percentage = saved["pct"]
    if cy_samples is not None: s.cycles.samples = cy_samples
    if ee_samples is not None: ee.taa_render_samples = ee_samples
    s.frame_set(saved["frame"])
`;
        const r = await runBlender(py, { mode, blendFile: blend_file, timeoutMs: (timeout_seconds ?? 300) * 1000 });
        if (!fs.existsSync(pngPath)) throw new Error("Render finished but no PNG was written.");
        const data = fs.readFileSync(pngPath).toString("base64");
        fs.rmSync(pngPath, { force: true });
        return {
          content: [
            { type: "text", text: JSON.stringify({ ...r.result, bridge_mode: r.mode }) },
            { type: "image", data, mimeType: "image/png" },
          ],
        };
      } catch (e) {
        fs.rmSync(pngPath, { force: true });
        return errText(e);
      }
    }
  );

  server.registerTool(
    "blender_render_animation",
    {
      title: "Render a Blender animation to disk",
      description:
        "Render the scene's frame range (or an override) with the scene's own output settings — e.g. the " +
        "multilayer EXR + pass sequences set up by scripts/blender/Creature_Walk_Cinematic.py — and register " +
        "the output folder as a workflow asset for the After Effects handoff. Prefer mode 'background' with " +
        "a saved blend_file for long renders so the Blender UI stays usable.",
      inputSchema: {
        output_dir: z.string().optional().describe("Directory for frames (default: scene output path)."),
        frame_start: z.number().int().optional(),
        frame_end: z.number().int().optional(),
        mode: MODE,
        blend_file: BLEND,
        timeout_seconds: z.number().optional().describe("Max seconds (default 3600)."),
      },
    },
    async ({ output_dir, frame_start, frame_end, mode, blend_file, timeout_seconds }) => {
      try {
        const py = `
import bpy, os
s = bpy.context.scene
r = s.render
if s.camera is None:
    raise RuntimeError("Scene has no active camera")
out_dir = ${output_dir ? JSON.stringify(output_dir) : "None"}
if out_dir:
    os.makedirs(out_dir, exist_ok=True)
    r.filepath = os.path.join(out_dir, (s.camera.name or "render") + "_")
${frame_start !== undefined ? `s.frame_start = ${Number(frame_start)}` : ""}
${frame_end !== undefined ? `s.frame_end = ${Number(frame_end)}` : ""}
bpy.ops.render.render(animation=True)
folder = os.path.dirname(bpy.path.abspath(r.filepath))
files = sorted(f for f in os.listdir(folder)) if os.path.isdir(folder) else []
result = {"output_dir": folder, "frames": [s.frame_start, s.frame_end], "file_format": r.image_settings.file_format,
          "num_files": len(files), "sample": files[:5]}
`;
        const r = await runBlender(py, { mode, blendFile: blend_file, timeoutMs: (timeout_seconds ?? 3600) * 1000 });
        if (r.result?.output_dir)
          registerAsset({ app: "blender", kind: "image-sequence", path: r.result.output_dir, meta: { frames: r.result.frames } });
        return text({ ...r.result, bridge_mode: r.mode });
      } catch (e) {
        return errText(e);
      }
    }
  );
}
