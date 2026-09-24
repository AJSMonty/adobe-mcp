"""
Creature_Skin_LookDev — Substance 3D Painter look-dev pass for a large reptile/creature.
Per texture set: optional mesh-map bake (curvature/AO feed the generators), an optional smart
material, a matte "aged scales" base (high roughness, zero metal), and a cavity-masked wetness
layer (low roughness where moisture collects). Texture sets whose name matches eye/mouth/teeth/
tongue get a glossy wet treatment. Everything lands in one undo step. Optional PBR export.
Override keys in DEFAULTS via PARAMS (run_script params). Sets `result` to a per-set report.
"""
import substance_painter.colormanagement as sp_cm
import substance_painter.layerstack as sp_ls
import substance_painter.project as sp_proj
import substance_painter.resource as sp_res
import substance_painter.textureset as sp_ts

DEFAULTS = {
    "texture_sets": None,                  # None = all
    "bake": False,                         # True kicks off an async bake first (edits queue behind it)
    "smart_material": None,                # e.g. "Creature Skin" (searched in the shelf); None = skip
    "base_color": [0.23, 0.2, 0.16],       # sRGB 0-1, desaturated olive-brown
    "scale_roughness": 0.78,               # matte, sun-dried scales
    "wet_roughness": 0.32,                 # moisture in folds / cavities
    "wet_generator": "Dirt",               # generator used as the cavity mask for wetness
    "gloss_sets": ["eye", "mouth", "teeth", "tongue", "gum"],
    "gloss_roughness": 0.12,               # eyes / mouth: wet, specular
    "export_dir": None,                    # absolute folder -> export PBR Metallic Roughness
}
P = dict(DEFAULTS)
P.update(globals().get("PARAMS") or {})
CT = sp_ts.ChannelType


def gray(v):
    return sp_cm.Color(v, v, v)


def set_uniform(fill, channel, value):
    """Uniform channel value; some Painter versions want a Color even for scalar channels."""
    try:
        fill.set_source(channel, value)
    except Exception:
        fill.set_source(channel, gray(value) if isinstance(value, float) else value)


def find_resource(query):
    try:
        hits = sp_res.search(query)
        return hits[0] if hits else None
    except Exception:
        return None


def look_dev_set(ts, notes):
    name = ts.name()
    stack = ts.get_stack()
    glossy = any(k in name.lower() for k in P["gloss_sets"])
    pos = sp_ls.InsertPosition.from_textureset_stack(stack)

    if P["smart_material"] and not glossy:
        res = find_resource("u:smartmaterial " + P["smart_material"])
        if res is None:
            notes.append("smart material %r not found" % P["smart_material"])
        else:
            try:
                sp_ls.insert_smart_material(pos, res.identifier())
                notes.append("smart material: " + P["smart_material"])
            except Exception as e:
                notes.append("smart material failed: %s" % e)

    base = sp_ls.insert_fill(sp_ls.InsertPosition.from_textureset_stack(stack))
    base.set_name("MCP Base Skin" if not glossy else "MCP Wet Gloss")
    base.active_channels = {CT.BaseColor, CT.Roughness, CT.Metallic}
    if not glossy:
        base.set_source(CT.BaseColor, sp_cm.Color(*P["base_color"]))
    set_uniform(base, CT.Roughness, float(P["gloss_roughness"] if glossy else P["scale_roughness"]))
    set_uniform(base, CT.Metallic, 0.0)   # organic dielectric: never metallic
    if glossy:
        # base colour stays whatever the artist painted; only the gloss changes
        base.active_channels = {CT.Roughness, CT.Metallic}
        return {"texture_set": name, "treatment": "wet gloss", "roughness": P["gloss_roughness"]}

    wet = sp_ls.insert_fill(sp_ls.InsertPosition.from_textureset_stack(stack))
    wet.set_name("MCP Cavity Wetness")
    wet.active_channels = {CT.Roughness}
    set_uniform(wet, CT.Roughness, float(P["wet_roughness"]))
    masked = False
    try:
        wet.add_mask(sp_ls.MaskBackground.Black)
        gen = find_resource("u:generator " + P["wet_generator"])
        if gen is not None:
            sp_ls.insert_generator_effect(
                sp_ls.InsertPosition.inside_node(wet, sp_ls.NodeStack.Mask), gen.identifier())
            masked = True
        else:
            notes.append("generator %r not found; wetness left unmasked at low opacity" % P["wet_generator"])
    except Exception as e:
        notes.append("wetness mask failed: %s" % e)
    if not masked:
        try:
            wet.set_opacity(0.25, CT.Roughness)
        except Exception:
            pass
    return {"texture_set": name, "treatment": "aged scales + cavity wetness",
            "roughness": [P["scale_roughness"], P["wet_roughness"]], "wet_masked": masked}


def run():
    if not sp_proj.is_open():
        raise RuntimeError("No Substance Painter project is open")
    wanted = P["texture_sets"]
    sets = [t for t in sp_ts.all_texture_sets() if wanted is None or t.name() in wanted]
    if not sets:
        raise RuntimeError("No matching texture sets: %s" % wanted)
    notes, report = [], []
    if P["bake"]:
        import substance_painter.baking as sp_bake
        if hasattr(sp_bake, "bake_async"):
            for t in sets:
                sp_bake.bake_async(t)
        else:
            sp_bake.bake_selected_textures_async()
        notes.append("bake started (async) for %d set(s)" % len(sets))
    with sp_ls.ScopedModification("adobe-mcp creature look-dev"):
        for t in sets:
            report.append(look_dev_set(t, notes))
    out = {"texture_sets": report, "notes": notes}
    if P["export_dir"]:
        import substance_painter.export as sp_exp
        cfg = {
            "exportShaderParams": False,
            "exportPath": P["export_dir"],
            "defaultExportPreset": sp_res.ResourceID(context="starter_assets", name="PBR Metallic Roughness").url(),
            "exportList": [{"rootPath": t.name()} for t in sets],
            "exportParameters": [{"parameters": {"fileFormat": "png", "bitDepth": "16", "paddingAlgorithm": "infinite"}}],
        }
        res = sp_exp.export_project_textures(cfg)
        out["export"] = {"status": str(res.status), "message": res.message,
                         "files": [p for paths in (res.textures or {}).values() for p in paths]}
    return out


result = run()
