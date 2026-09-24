// Free CC0 texture / HDRI libraries: Poly Haven and ambientCG.
//
// Search both catalogues, download a resolution/format, and cache it under
// $WORKSPACE/textures/<source>/<id>_<res>_<fmt>/ with maps renamed to one convention
// (<id>_BaseColor.jpg, _Roughness, _Normal (OpenGL), _Height, _AO, _Metallic, _ARM, _Opacity),
// so the Blender material builder, the creature script's texture_dir and Substance can all
// consume any asset the same way. Everything both libraries publish is CC0 (public domain).
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { WORKSPACE } from "./workspace.mjs";

const POLYHAVEN_API = process.env.POLYHAVEN_API || "https://api.polyhaven.com";
const AMBIENTCG_API = process.env.AMBIENTCG_API || "https://ambientcg.com/api/v2";
// Poly Haven asks API users to send an identifying User-Agent.
const UA = "adobe-mcp (+https://github.com/AJSMonty/adobe-mcp)";
export const TEXTURE_CACHE = path.join(WORKSPACE, "textures");

async function getJSON(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`);
  return res.json();
}

async function getBytes(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// ---------------------------------------------------------------------------
// Map classification (Poly Haven map keys and ambientCG file suffixes)
// ---------------------------------------------------------------------------

/** Canonical map name for a library map key / filename, or null to skip it. */
export function classifyMap(name) {
  const n = name.toLowerCase().replace(/\.[a-z0-9]+$/, "");
  if (/preview|thumb|\.mtlx|usd|blend|gltf|_bump|bump$|idmap|mask_/.test(n)) return null;
  if (/nor(mal)?_?dx|normaldx/.test(n)) return null; // DirectX green channel; Blender wants OpenGL
  if (/nor(mal)?_?gl|normalgl|normal/.test(n)) return "Normal";
  if (/(^|_)arm($|_)/.test(n)) return "ARM"; // AO / Roughness / Metal packed in R/G/B
  if (/rough/.test(n)) return "Roughness";
  if (/metal/.test(n)) return "Metallic";
  if (/disp|height/.test(n)) return "Height";
  if (/ambientocclusion|(^|_)ao($|_)/.test(n)) return "AO";
  if (/opacity|alpha/.test(n)) return "Opacity";
  if (/diff|albedo|basecolor|base_color|color|col($|_)/.test(n)) return "BaseColor";
  return null;
}

/** ambientCG files are <AssetId>_<RES>-<FMT>_<Map>.<ext>: classify the map suffix only, so an
 *  id like "Metal032" does not turn its colour map into a metallic map. */
export function classifyAmbientFile(fileName) {
  const stem = path.basename(fileName).replace(/\.[a-z0-9]+$/i, "");
  const parts = stem.split("_");
  return parts.length > 1 ? classifyMap(parts[parts.length - 1]) : null;
}

// ---------------------------------------------------------------------------
// Minimal ZIP reader (ambientCG ships materials as zips) — store + deflate, no zip64.
// ---------------------------------------------------------------------------

export function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("Not a zip file (no end-of-central-directory record)");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let k = 0; k < count; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("Corrupt zip central directory");
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28);
    const xlen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nlen);
    p += 46 + nlen + xlen + clen;
    if (name.endsWith("/")) continue;
    const dataStart = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(dataStart, dataStart + csize);
    if (method === 0) out.push({ name, data: Buffer.from(raw) });
    else if (method === 8) out.push({ name, data: zlib.inflateRawSync(raw) });
    else throw new Error(`Unsupported zip compression method ${method} for ${name}`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

function scoreText(query, fields) {
  const terms = String(query || "").toLowerCase().split(/[\s,]+/).filter(Boolean);
  if (!terms.length) return 1;
  const hay = fields.join(" ").toLowerCase();
  return terms.filter((t) => hay.includes(t)).length / terms.length;
}

async function searchPolyHaven({ query, type, category, limit }) {
  const t = type === "hdri" ? "hdris" : "textures";
  const url = `${POLYHAVEN_API}/assets?t=${t}${category ? `&c=${encodeURIComponent(category)}` : ""}`;
  const all = await getJSON(url);
  return Object.entries(all)
    .map(([id, a]) => ({
      source: "polyhaven",
      id,
      name: a.name || id,
      type: type === "hdri" ? "hdri" : "texture",
      categories: a.categories || [],
      tags: a.tags || [],
      downloads: a.download_count || 0,
      max_resolution: Array.isArray(a.max_resolution) ? a.max_resolution : undefined,
      preview: `https://cdn.polyhaven.com/asset_img/thumbs/${id}.png?width=256`,
      page: `https://polyhaven.com/a/${id}`,
      license: "CC0",
      _score: scoreText(query, [id, a.name || "", ...(a.tags || []), ...(a.categories || [])]),
    }))
    .filter((a) => a._score > 0)
    .sort((a, b) => b._score - a._score || b.downloads - a.downloads)
    .slice(0, limit);
}

async function searchAmbientCG({ query, type, category, limit }) {
  const q = [query, category].filter(Boolean).join(" ");
  const url =
    `${AMBIENTCG_API}/full_json?type=${type === "hdri" ? "HDRI" : "Material"}` +
    `&limit=${limit}&sort=Popular&include=tagData,imageData` +
    (q ? `&q=${encodeURIComponent(q)}` : "");
  const data = await getJSON(url);
  return (data.foundAssets || []).map((a) => {
    const imgs = a.previewImage || {};
    return {
      source: "ambientcg",
      id: a.assetId,
      name: a.displayName || a.assetId,
      type: type === "hdri" ? "hdri" : "texture",
      categories: a.displayCategory ? [a.displayCategory] : [],
      tags: a.tags || [],
      downloads: a.downloadCount || 0,
      preview: imgs["256-PNG"] || imgs["128-PNG"] || Object.values(imgs)[0],
      page: `https://ambientcg.com/view?id=${a.assetId}`,
      license: "CC0",
    };
  });
}

export async function searchLibraries({ source = "all", query = "", type = "texture", category, limit = 12 }) {
  const jobs = [];
  if (source === "all" || source === "polyhaven") jobs.push(["polyhaven", searchPolyHaven({ query, type, category, limit })]);
  if (source === "all" || source === "ambientcg") jobs.push(["ambientcg", searchAmbientCG({ query, type, category, limit })]);
  const results = [];
  const errors = {};
  for (const [name, job] of jobs) {
    try {
      results.push(...(await job));
    } catch (e) {
      errors[name] = e.message;
    }
  }
  results.forEach((r) => delete r._score);
  return { results, ...(Object.keys(errors).length ? { errors } : {}) };
}

// ---------------------------------------------------------------------------
// Download (cached)
// ---------------------------------------------------------------------------

function cacheDir(source, id, res, fmt) {
  return path.join(TEXTURE_CACHE, source, `${id.replace(/[^\w.-]/g, "_")}_${res}_${fmt}`);
}

function readCached(dir) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, "asset.json"), "utf8"));
    if (Object.values(m.maps).every((p) => fs.existsSync(p))) return { ...m, cached: true };
  } catch {
    /* not cached */
  }
  return null;
}

function saveMap(dir, id, canon, ext, data, maps) {
  if (!canon || maps[canon]) return; // first match wins (e.g. prefer the first normal)
  const p = path.join(dir, `${id}_${canon}.${ext}`);
  fs.writeFileSync(p, data);
  maps[canon] = p;
}

async function downloadPolyHaven(id, type, res, fmt, dir) {
  const files = await getJSON(`${POLYHAVEN_API}/files/${encodeURIComponent(id)}`);
  const maps = {};
  if (type === "hdri") {
    const byRes = files.hdri?.[res];
    if (!byRes) throw new Error(`Poly Haven HDRI ${id} has no ${res}; available: ${Object.keys(files.hdri || {}).join(", ")}`);
    const f = byRes[fmt] || byRes.hdr || byRes.exr;
    const ext = byRes[fmt] ? fmt : byRes.hdr ? "hdr" : "exr";
    saveMap(dir, id, "HDRI", ext, await getBytes(f.url), maps);
    return maps;
  }
  for (const [key, byRes] of Object.entries(files)) {
    const canon = classifyMap(key);
    if (!canon || !byRes || typeof byRes !== "object") continue;
    const r = byRes[res] || null;
    if (!r) continue;
    // colour maps in the requested format; data maps prefer png/exr (jpg if that's all there is)
    const pick = r[fmt] || r.png || r.jpg || r.exr || Object.values(r)[0];
    if (!pick?.url) continue;
    const ext = path.extname(new URL(pick.url).pathname).slice(1) || fmt;
    saveMap(dir, id, canon, ext, await getBytes(pick.url), maps);
  }
  if (!Object.keys(maps).length) {
    const avail = Object.values(files).flatMap((v) => (v && typeof v === "object" ? Object.keys(v) : []));
    throw new Error(`Poly Haven ${id}: no maps at ${res}; available resolutions: ${[...new Set(avail)].join(", ")}`);
  }
  return maps;
}

async function downloadAmbientCG(id, type, res, fmt, dir) {
  const data = await getJSON(`${AMBIENTCG_API}/full_json?id=${encodeURIComponent(id)}&include=downloadData`);
  const asset = (data.foundAssets || [])[0];
  if (!asset) throw new Error(`ambientCG has no asset "${id}"`);
  const wanted = `${res.toUpperCase()}-${fmt.toUpperCase()}`;
  const downloads = [];
  for (const folder of Object.values(asset.downloadFolders || {}))
    for (const cat of Object.values(folder.downloadFiletypeCategories || {})) downloads.push(...(cat.downloads || []));
  const dl =
    downloads.find((d) => d.attribute === wanted) ||
    downloads.find((d) => String(d.attribute || "").toUpperCase().startsWith(res.toUpperCase() + "-"));
  if (!dl) throw new Error(`ambientCG ${id}: no ${wanted} download; available: ${downloads.map((d) => d.attribute).join(", ")}`);
  const bytes = await getBytes(dl.downloadLink || dl.rawLink);
  const maps = {};
  const fileName = dl.fileName || path.basename(new URL(dl.downloadLink || dl.rawLink).pathname);
  if (/\.zip$/i.test(fileName) || bytes.readUInt32LE(0) === 0x04034b50) {
    for (const f of unzip(bytes)) {
      const ext = path.extname(f.name).slice(1).toLowerCase();
      if (type === "hdri" && /^(hdr|exr)$/.test(ext)) saveMap(dir, id, "HDRI", ext, f.data, maps);
      else if (/^(jpg|jpeg|png|exr|tif|tiff)$/.test(ext)) saveMap(dir, id, classifyAmbientFile(f.name), ext, f.data, maps);
    }
  } else {
    saveMap(dir, id, type === "hdri" ? "HDRI" : classifyAmbientFile(fileName), path.extname(fileName).slice(1), bytes, maps);
  }
  if (!Object.keys(maps).length) throw new Error(`ambientCG ${id}: download contained no usable maps`);
  return maps;
}

/**
 * Download one asset (cached). Returns {source, id, type, resolution, format, dir, maps, license}.
 * res: 1k/2k/4k/8k. fmt: jpg/png/exr for textures, hdr/exr for HDRIs.
 */
export async function downloadAsset({ source, id, type = "texture", resolution = "2k", format }) {
  const res = resolution.toLowerCase();
  const fmt = (format || (type === "hdri" ? "hdr" : "jpg")).toLowerCase();
  const dir = cacheDir(source, id, res, fmt);
  const hit = readCached(dir);
  if (hit) return hit;
  fs.mkdirSync(dir, { recursive: true });
  let maps;
  if (source === "polyhaven") maps = await downloadPolyHaven(id, type, res, fmt, dir);
  else if (source === "ambientcg") maps = await downloadAmbientCG(id, type, res, fmt, dir);
  else throw new Error(`Unknown texture source "${source}" (use polyhaven or ambientcg)`);
  const meta = {
    source,
    id,
    type,
    resolution: res,
    format: fmt,
    dir,
    maps,
    license: "CC0 1.0 (public domain)",
    page: source === "polyhaven" ? `https://polyhaven.com/a/${id}` : `https://ambientcg.com/view?id=${id}`,
    downloaded: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(dir, "asset.json"), JSON.stringify(meta, null, 2));
  return { ...meta, cached: false };
}
