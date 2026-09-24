# adobe-mcp Blender helpers for library textures (prepended to tool code; not an add-on).
# build_pbr_material(): Principled BSDF from canonical maps (BaseColor, Roughness, Metallic,
#   Normal [OpenGL], Height, ARM, Opacity; AO is deliberately unused — a path tracer computes
#   its own occlusion, and multiplying baked AO in double-darkens contact areas).
# set_world_hdri(): image-based lighting from an equirectangular HDRI.
import math
import os

import bpy


def _img_node(nt, path, non_color, loc):
    node = nt.nodes.new("ShaderNodeTexImage")
    node.location = loc
    node.image = bpy.data.images.load(path, check_existing=True)
    if non_color:
        node.image.colorspace_settings.name = "Non-Color"
    return node


def _has_uvs(ob):
    return ob.type == "MESH" and len(getattr(ob.data, "uv_layers", [])) > 0


def build_pbr_material(name, maps, objects=(), tile_m=2.0, projection="auto",
                       displacement_m=0.02, replace=True):
    """Create (or rebuild) material `name` from `maps` and assign it to `objects`.

    tile_m: real-world size of one texture tile in meters (box projection and UV scaling).
    projection: "uv", "box" (tri-planar in object space, for meshes without UVs) or "auto".
    """
    obs = [bpy.data.objects.get(o) if isinstance(o, str) else o for o in objects]
    missing = [o for o, ob in zip(objects, obs) if ob is None]
    if missing:
        raise RuntimeError("Objects not found: %s" % missing)
    if projection == "auto":
        projection = "uv" if obs and all(_has_uvs(ob) for ob in obs) else "box"

    mat = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    out.location = (600, 0)
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    bsdf.location = (250, 0)
    nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])

    coord = nt.nodes.new("ShaderNodeTexCoord")
    coord.location = (-1100, 0)
    mapping = nt.nodes.new("ShaderNodeMapping")
    mapping.location = (-900, 0)
    s = 1.0 / max(1e-4, float(tile_m))
    mapping.inputs["Scale"].default_value = (s, s, s)
    nt.links.new(coord.outputs["UV" if projection == "uv" else "Object"], mapping.inputs["Vector"])

    used, y = {}, 400

    def tex(key, non_color):
        nonlocal y
        node = _img_node(nt, maps[key], non_color, (-600, y))
        y -= 280
        if projection == "box":
            node.projection = "BOX"
            node.projection_blend = 0.25    # soften tri-planar seams
        nt.links.new(mapping.outputs["Vector"], node.inputs["Vector"])
        used[key] = os.path.basename(maps[key])
        return node

    if "BaseColor" in maps:
        nt.links.new(tex("BaseColor", False).outputs["Color"], bsdf.inputs["Base Color"])
    arm = None
    if "ARM" in maps and ("Roughness" not in maps or "Metallic" not in maps):
        arm_img = tex("ARM", True)
        arm = nt.nodes.new("ShaderNodeSeparateColor")
        arm.location = (-250, y + 280)
        nt.links.new(arm_img.outputs["Color"], arm.inputs["Color"])
    if "Roughness" in maps:
        nt.links.new(tex("Roughness", True).outputs["Color"], bsdf.inputs["Roughness"])
    elif arm:
        nt.links.new(arm.outputs["Green"], bsdf.inputs["Roughness"])
    if "Metallic" in maps:
        nt.links.new(tex("Metallic", True).outputs["Color"], bsdf.inputs["Metallic"])
    elif arm:
        nt.links.new(arm.outputs["Blue"], bsdf.inputs["Metallic"])
    else:
        bsdf.inputs["Metallic"].default_value = 0.0
    if "Normal" in maps:
        nm = nt.nodes.new("ShaderNodeNormalMap")
        nm.location = (-150, -500)
        nt.links.new(tex("Normal", True).outputs["Color"], nm.inputs["Color"])
        nt.links.new(nm.outputs["Normal"], bsdf.inputs["Normal"])
    if "Opacity" in maps:
        nt.links.new(tex("Opacity", True).outputs["Color"], bsdf.inputs["Alpha"])
    if "Height" in maps and displacement_m:
        disp = nt.nodes.new("ShaderNodeDisplacement")
        disp.location = (250, -500)
        disp.inputs["Midlevel"].default_value = 0.5
        disp.inputs["Scale"].default_value = float(displacement_m)
        nt.links.new(tex("Height", True).outputs["Color"], disp.inputs["Height"])
        nt.links.new(disp.outputs["Displacement"], out.inputs["Displacement"])
        try:
            mat.displacement_method = "BOTH"   # real displacement where subdivided, bump elsewhere
        except (AttributeError, TypeError):
            pass

    assigned = []
    for ob in obs:
        if not hasattr(ob.data, "materials"):
            continue
        if replace:
            ob.data.materials.clear()
        ob.data.materials.append(mat)
        assigned.append(ob.name)
    return {"material": mat.name, "projection": projection, "tile_m": tile_m,
            "maps": used, "assigned": assigned,
            "skipped": [k for k in maps if k not in used and k != "AO"] + (["AO (path tracer computes occlusion)"] if "AO" in maps else [])}


def set_world_hdri(path, strength=1.0, rotation_deg=0.0, world_name="MCP_HDRI_World"):
    """Light the scene with an equirectangular HDRI; rotation_deg turns the sun direction."""
    scene = bpy.context.scene
    world = scene.world or bpy.data.worlds.new(world_name)
    scene.world = world
    world.use_nodes = True
    nt = world.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    coord = nt.nodes.new("ShaderNodeTexCoord")
    coord.location = (-900, 0)
    mapping = nt.nodes.new("ShaderNodeMapping")
    mapping.location = (-700, 0)
    mapping.inputs["Rotation"].default_value = (0.0, 0.0, math.radians(rotation_deg))
    env = nt.nodes.new("ShaderNodeTexEnvironment")
    env.location = (-450, 0)
    env.image = bpy.data.images.load(path, check_existing=True)
    bg = nt.nodes.new("ShaderNodeBackground")
    bg.location = (-150, 0)
    bg.inputs["Strength"].default_value = float(strength)
    out = nt.nodes.new("ShaderNodeOutputWorld")
    out.location = (100, 0)
    nt.links.new(coord.outputs["Generated"], mapping.inputs["Vector"])
    nt.links.new(mapping.outputs["Vector"], env.inputs["Vector"])
    nt.links.new(env.outputs["Color"], bg.inputs["Color"])
    nt.links.new(bg.outputs["Background"], out.inputs["Surface"])
    return {"world": world.name, "hdri": os.path.basename(path), "strength": strength,
            "rotation_deg": rotation_deg}
