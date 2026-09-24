// Free texture libraries (Poly Haven, ambientCG — all CC0) → search, download, apply in Blender.
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runBlender, blenderSaveSnippet } from "../core/pybridge.mjs";
import { searchLibraries, downloadAsset, classifyAmbientFile, TEXTURE_CACHE } from "../core/texlib.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PBR_PY = fs.readFileSync(path.join(__dirname, "..", "core", "blender_pbr.py"), "utf8");

const SOURCE = z.enum(["polyhaven", "ambientcg"]).describe("Library the asset id comes from (see texture_search).");
const RES = z.enum(["1k", "2k", "4k", "8k"]).optional().describe("Resolution (default 2k; 4k+ for hero close-ups).");
const MODE = z.enum(["auto", "live", "background"]).optional().describe("Blender bridge mode (see blender_run_python).");

/** Python that runs a blender_pbr helper with JSON kwargs. */
function pbrCall(fn, kwargs, saveAs) {
  return (
    `${PBR_PY}\nimport json as __json\n` +
    `result = ${fn}(**__json.loads(${JSON.stringify(JSON.stringify(kwargs))}))\n` +
    (saveAs ? blenderSaveSnippet(saveAs) : "")
  );
}

/** Canonical maps from a local folder (e.g. a Substance export). */
function mapsFromDir(dir) {
  const maps = {};
  for (const f of fs.readdirSync(dir).sort()) {
    if (!/\.(png|jpe?g|exr|tiff?)$/i.test(f)) continue;
    const canon = classifyAmbientFile(f);
    if (canon && !maps[canon]) maps[canon] = path.join(dir, f);
  }
  if (!Object.keys(maps).length) throw new Error(`No recognisable maps (…_BaseColor, _Roughness, _Normal…) in ${dir}`);
  return maps;
}

export function register(server, { text, errText, registerAsset }) {
  const fetchAsset = async (args) => {
    const a = await downloadAsset(args);
    if (!a.cached)
      for (const [map, p] of Object.entries(a.maps))
        registerAsset({ app: a.source, kind: a.type === "hdri" ? "hdri" : "texture", path: p, meta: { id: a.id, map, resolution: a.resolution, license: a.license } });
    return a;
  };

  server.registerTool(
    "texture_search",
    {
      title: "Search free CC0 texture & HDRI libraries",
      description:
        "Search Poly Haven and ambientCG, the two big free, CC0 (public domain, no attribution) PBR libraries " +
        "Blender artists use. Returns asset ids, names, tags, preview thumbnails and pages. type=texture for " +
        "materials (rock, bark, scales, ground, concrete…), type=hdri for image-based lighting that matches a plate. " +
        "Poly Haven categories include e.g. rock, terrain, wood, fabric, brick; ambientCG is keyword search.",
      inputSchema: {
        query: z.string().optional().describe("Keywords, e.g. 'wet rock', 'reptile skin', 'forest ground'."),
        type: z.enum(["texture", "hdri"]).optional().describe("Default texture."),
        source: z.enum(["all", "polyhaven", "ambientcg"]).optional().describe("Default all."),
        category: z.string().optional().describe("Optional category filter (Poly Haven category / extra ambientCG keyword)."),
        limit: z.number().int().min(1).max(50).optional().describe("Results per library (default 12)."),
      },
    },
    async ({ query, type, source, category, limit }) => {
      try {
        const r = await searchLibraries({ query, type: type ?? "texture", source: source ?? "all", category, limit: limit ?? 12 });
        return text({ count: r.results.length, ...r, license: "All results are CC0 — free for commercial use, no attribution required." });
      } catch (e) {
        return errText(e);
      }
    }
  );

  server.registerTool(
    "texture_download",
    {
      title: "Download a library texture or HDRI",
      description:
        "Download one asset at a resolution into the local cache (<workspace>/textures, reused on repeat calls) " +
        "with maps renamed to a common convention (<id>_BaseColor, _Roughness, _Normal (OpenGL), _Height, _AO, " +
        "_Metallic, _ARM, _Opacity; HDRIs as _HDRI). Registers every map as a workflow asset. The folder works " +
        "directly as texture_dir for Creature_Walk_Cinematic.py or blender_apply_texture.",
      inputSchema: {
        source: SOURCE,
        id: z.string().describe("Asset id from texture_search (e.g. 'rock_face' or 'Rock030')."),
        type: z.enum(["texture", "hdri"]).optional().describe("Default texture."),
        resolution: RES,
        format: z.enum(["jpg", "png", "exr", "hdr"]).optional().describe("Textures: jpg (default)/png/exr. HDRIs: hdr (default)/exr."),
      },
    },
    async ({ source, id, type, resolution, format }) => {
      try {
        return text(await fetchAsset({ source, id, type: type ?? "texture", resolution: resolution ?? "2k", format }));
      } catch (e) {
        return errText(e);
      }
    }
  );

  server.registerTool(
    "blender_apply_texture",
    {
      title: "Apply a library (or local) PBR texture to Blender objects",
      description:
        "Build a Principled BSDF material from a Poly Haven / ambientCG asset (downloaded on demand) or a local " +
        "folder of maps (e.g. a Substance Painter export), and assign it to objects. Colour maps are sRGB, data " +
        "maps Non-Color, normals OpenGL, height drives true displacement (method BOTH), ARM is unpacked when " +
        "separate maps are missing, and baked AO is left out (Cycles computes its own). Meshes without UVs get " +
        "tri-planar box projection. Set tile_m to the real-world size one tile covers so scale reads correctly.",
      inputSchema: {
        objects: z.array(z.string()).min(1).describe("Blender object names to assign the material to."),
        source: SOURCE.optional(),
        id: z.string().optional().describe("Library asset id (with source)."),
        texture_dir: z.string().optional().describe("Alternative: absolute folder of maps named *_BaseColor, *_Roughness, *_Normal…"),
        resolution: RES,
        format: z.enum(["jpg", "png", "exr"]).optional(),
        material_name: z.string().optional().describe("Default: the asset id."),
        tile_m: z.number().positive().optional().describe("Meters covered by one texture tile (default 2)."),
        projection: z.enum(["auto", "uv", "box"]).optional().describe("Default auto (uv if every object has UVs)."),
        displacement_m: z.number().min(0).optional().describe("Height-map displacement in meters (default 0.02; 0 disables)."),
        mode: MODE,
        blend_file: z.string().optional(),
        save_as: z.string().optional().describe("Save the .blend here afterwards (needed in background mode)."),
      },
    },
    async (a) => {
      try {
        let maps, label;
        if (a.texture_dir) {
          maps = mapsFromDir(a.texture_dir);
          label = path.basename(a.texture_dir);
        } else {
          if (!a.source || !a.id) throw new Error("Pass source + id (from texture_search) or texture_dir.");
          const asset = await fetchAsset({ source: a.source, id: a.id, type: "texture", resolution: a.resolution ?? "2k", format: a.format });
          maps = asset.maps;
          label = a.id;
        }
        const kwargs = {
          name: a.material_name ?? label,
          maps,
          objects: a.objects,
          tile_m: a.tile_m ?? 2.0,
          projection: a.projection ?? "auto",
          displacement_m: a.displacement_m ?? 0.02,
        };
        const r = await runBlender(pbrCall("build_pbr_material", kwargs, a.save_as), { mode: a.mode, blendFile: a.blend_file, timeoutMs: 180000 });
        return text({ ...r.result, bridge_mode: r.mode, saved: a.save_as ?? null });
      } catch (e) {
        return errText(e);
      }
    }
  );

  server.registerTool(
    "blender_set_hdri",
    {
      title: "Light the Blender scene with a library HDRI",
      description:
        "Download a Poly Haven / ambientCG HDRI (or use a local .hdr/.exr) and set it as the world light. Pick " +
        "an HDRI whose sun height, colour and cloud cover match the live-action plate, then rotate it " +
        "(rotation_deg) until CG shadows line up with the plate's. This is the biggest single win for photo-real " +
        "integration.",
      inputSchema: {
        source: SOURCE.optional(),
        id: z.string().optional().describe("HDRI asset id from texture_search type=hdri."),
        hdri_path: z.string().optional().describe("Alternative: absolute path to a local .hdr/.exr."),
        resolution: RES,
        strength: z.number().min(0).optional().describe("Background strength (default 1)."),
        rotation_deg: z.number().optional().describe("Rotate the environment around Z (default 0)."),
        mode: MODE,
        blend_file: z.string().optional(),
        save_as: z.string().optional(),
      },
    },
    async (a) => {
      try {
        let hdri = a.hdri_path;
        if (!hdri) {
          if (!a.source || !a.id) throw new Error("Pass source + id (texture_search type=hdri) or hdri_path.");
          const asset = await fetchAsset({ source: a.source, id: a.id, type: "hdri", resolution: a.resolution ?? "2k" });
          hdri = asset.maps.HDRI;
        }
        if (!fs.existsSync(hdri)) throw new Error(`HDRI not found: ${hdri}`);
        const kwargs = { path: hdri, strength: a.strength ?? 1.0, rotation_deg: a.rotation_deg ?? 0 };
        const r = await runBlender(pbrCall("set_world_hdri", kwargs, a.save_as), { mode: a.mode, blendFile: a.blend_file, timeoutMs: 120000 });
        return text({ ...r.result, path: hdri, bridge_mode: r.mode, saved: a.save_as ?? null });
      } catch (e) {
        return errText(e);
      }
    }
  );
}

export { TEXTURE_CACHE };
