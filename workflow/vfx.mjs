// VFX pipeline planner: turns a creature-shot brief into physically derived timing and the
// ordered Blender → Substance → Blender → After Effects tool calls that execute it.
import { z } from "zod";
import path from "node:path";
import { WORKSPACE } from "../core/workspace.mjs";

const G = 9.81;

/** Same gait model as scripts/blender/Creature_Walk_Cinematic.py (keep in sync). */
export function deriveGait({ hip_height_m = 3.1, froude = 0.055, mass_kg = 8000, fps = 24 }) {
  const v = Math.sqrt(froude * G * hip_height_m);
  const stride = 2.3 * froude ** 0.3 * hip_height_m; // Alexander (1976)
  const cycle_s = stride / v;
  return {
    speed_mps: +v.toFixed(3),
    speed_kmh: +(v * 3.6).toFixed(2),
    stride_m: +stride.toFixed(3),
    cycle_s: +cycle_s.toFixed(3),
    cycle_frames: +(cycle_s * fps).toFixed(1),
    step_frames: +((cycle_s * fps) / 2).toFixed(1),
    breath_s: +(4.0 * (mass_kg / 70) ** 0.26 * 0.5).toFixed(2),
    gait: froude < 0.5 ? "walk" : froude < 1 ? "fast walk / trot transition" : "run",
  };
}

export function register(server, { text, errText }) {
  server.registerTool(
    "vfx_plan_creature_shot",
    {
      title: "Plan a photo-real creature shot (Blender → Substance → AE)",
      description:
        "For briefs like 'a photo-real dinosaur walking past the camera while turning its neck'. Derives " +
        "physical timing from size and mass (Froude-scaled speed, Alexander stride, steps per frame, " +
        "breathing period) and returns the four-stage pipeline as concrete tool calls: 1) block + animate " +
        "in Blender (run_script Creature_Walk_Cinematic.py), 2) look-dev in Substance Painter " +
        "(Creature_Skin_LookDev.py + export), 3) bind textures and render passes in Blender, " +
        "4) composite in After Effects (Cinematic_3D_Composite.jsx). Call this first, then run each step, " +
        "verifying visually (blender_render_frame / ae_save_frame) between steps.",
      inputSchema: {
        brief: z.string().optional().describe("The shot description, echoed into the plan."),
        hip_height_m: z.number().optional().describe("Hip height in meters (default 3.1, adult T. rex)."),
        mass_kg: z.number().optional().describe("Body mass (default 8000)."),
        froude: z.number().optional().describe("Gait intensity v²/(g·h): 0.05 plodding, 0.25 brisk, 0.5 walk→run (default 0.055)."),
        fps: z.number().optional().describe("Frame rate (default 24)."),
        duration_s: z.number().optional().describe("Shot length in seconds (default 10)."),
        lens_mm: z.number().optional().describe("Focal length on a 36 mm sensor (default 35)."),
        cam_distance_m: z.number().optional().describe("Camera distance from the walk line (default 14)."),
        hero_mesh: z.string().optional().describe("Existing Blender object to drive (default: proxy blocking rig only)."),
        shot_dir: z.string().optional().describe("Absolute folder for renders/textures (default <workspace>/shots/creature)."),
      },
    },
    async (a) => {
      try {
        const fps = a.fps ?? 24;
        const g = deriveGait({ hip_height_m: a.hip_height_m, froude: a.froude, mass_kg: a.mass_kg, fps });
        const shot = a.shot_dir ?? path.join(WORKSPACE, "shots", "creature");
        const blend = path.join(shot, "creature_shot.blend");
        const params = {
          fps,
          duration_s: a.duration_s ?? 10,
          hip_height_m: a.hip_height_m ?? 3.1,
          mass_kg: a.mass_kg ?? 8000,
          froude: a.froude ?? 0.055,
          lens_mm: a.lens_mm ?? 35,
          cam_distance_m: a.cam_distance_m ?? 14,
          output_dir: path.join(shot, "render"),
          ...(a.hero_mesh ? { bind: { [a.hero_mesh]: "Hips" } } : {}),
        };
        const plan = {
          brief: a.brief ?? null,
          physics: {
            ...g,
            notes: [
              `A ${params.mass_kg} kg animal with ${params.hip_height_m} m hips walks at ${g.speed_kmh} km/h: one step every ${g.step_frames} frames at ${fps} fps.`,
              "Feet are planted for 62% of each cycle (duty factor) — heavy walkers never have an airborne phase.",
              "Hips drop just after each contact (weight acceptance), sway over the stance foot and roll toward the swing side.",
              "Neck and tail lag the hips by 3 frames per joint (overlapping action); the head is gaze-stabilised and leads the look-turn.",
              "Every footfall puts a mass- and distance-scaled impact shake into the handheld camera; timeline markers mark contacts.",
            ],
          },
          stages: [
            {
              stage: "1. Analyze & block + 2. Animate (Blender)",
              tool: "run_script",
              args: { app: "blender", name: "Creature_Walk_Cinematic.py", mode: "background", params, save_as: blend },
              verify: { tool: "blender_render_frame", args: { blend_file: blend, frame: Math.round(params.duration_s * fps * 0.55) } },
            },
            {
              stage: "2b. Light & dress to match the plate (free CC0 libraries)",
              tool: "texture_search",
              args: { type: "hdri", query: "<sky that matches the plate: e.g. 'partly cloudy afternoon'>" },
              then: [
                { tool: "blender_set_hdri", args: { source: "<from search>", id: "<from search>", blend_file: blend, save_as: blend, mode: "background", rotation_deg: 0 } },
                { tool: "blender_apply_texture", args: { objects: ["<set-dressing objects>"], source: "<from texture_search query='forest ground'>", id: "<id>", blend_file: blend, save_as: blend, mode: "background", tile_m: 2 } },
              ],
              note: "Rotate the HDRI until CG shadow direction matches the plate. The ground is a shadow catcher, so only texture set-dressing and props.",
            },
            {
              stage: "3. Texture & materialize (Substance 3D Painter, project with the hero mesh open)",
              tool: "run_script",
              args: {
                app: "substance",
                name: "Creature_Skin_LookDev.py",
                params: { bake: true, export_dir: path.join(shot, "textures") },
              },
              note: "Bake is async: if the export runs before the bake finishes, re-run substance_export_textures afterwards.",
            },
            {
              stage: "3b. Bind textures + render passes (Blender)",
              tool: "run_script",
              args: {
                app: "blender",
                name: "Creature_Walk_Cinematic.py",
                mode: "background",
                blend_file: blend,
                save_as: blend,
                params: { ...params, texture_dir: path.join(shot, "textures") },
              },
              then: { tool: "blender_render_animation", args: { blend_file: blend, mode: "background" } },
              note: a.hero_mesh ? undefined : "No hero_mesh given: proxies render as the creature (blocking pass).",
            },
            {
              stage: "4. Composite & polish (After Effects, plate layer named BG_Plate in the active comp)",
              tool: "run_script",
              args: { app: "ae", name: "Cinematic_3D_Composite.jsx", params: { render_dir: params.output_dir, fps } },
              verify: { tool: "ae_save_frame", args: { comp_name: "<your comp>" } },
            },
          ],
        };
        return text(plan);
      } catch (e) {
        return errText(e);
      }
    }
  );
}
