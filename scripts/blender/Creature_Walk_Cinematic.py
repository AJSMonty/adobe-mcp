"""
Creature_Walk_Cinematic — a physically timed heavy-biped (theropod) walk past a handheld camera,
with the head turning to look at the lens. Builds a proxy blocking rig (or drives your mesh via
PARAMS["bind"]), a documentary camera rig and a comp-ready render setup: Cycles, 180° shutter
motion blur, shadow catcher, and beauty / shadow / mist sequences for the After Effects composite.

Timing is derived, not guessed: speed from a Froude number (v = sqrt(Fr*g*h)), stride from
Alexander (1976) lambda/h = 2.3*Fr^0.3. The default Fr 0.055 at 3.1 m hip height gives about 1.3 m/s,
in line with published T. rex walking-speed estimates. Secondary motion is propagated down
the neck and tail chains with a per-joint frame lag (overlapping action), the head is gaze-stabilised,
and every footfall puts a small impact shake into the camera.
Override any key in DEFAULTS via PARAMS (run_script params). Sets `result` to the derived numbers.
"""
import math
import os

import bpy
import bmesh

DEFAULTS = {
    "fps": 24,
    "duration_s": 10.0,
    "hip_height_m": 3.1,        # T. rex-scale; drives every other dimension
    "mass_kg": 8000.0,
    "froude": 0.055,            # 0.05-0.1 = heavy walk; 0.5 = walk/run transition
    "duty_factor": 0.62,        # fraction of the cycle each foot is planted (heavy walkers > 0.6)
    "joint_lag_frames": 3,      # overlap delay per neck/tail joint (mass inertia)
    "neck_joints": 4,
    "tail_joints": 6,
    "pass_at": 0.55,            # fraction of the shot where the creature crosses the camera axis
    "look_in": 0.30, "look_hold": 0.62, "look_out": 0.85,  # head-turn window (fractions of shot)
    "look_max_deg": 70.0,
    "cam_distance_m": 14.0,     # from the walk line
    "cam_height_m": 1.7,        # eye height of a person holding the camera
    "lens_mm": 35.0,            # sells scale while keeping the whole animal readable on the pan
    "sensor_mm": 36.0,
    "fstop": 2.8,
    "operator_lag_s": 0.25,     # camera operator reaction delay while panning
    "handheld_deg": 0.25,       # handheld rotational noise amplitude
    "footfall_shake_deg": 0.35, # impact shake at 10 m for an 8 t animal
    "engine": "CYCLES",
    "samples": 128,
    "resolution": [1920, 1080],
    "shutter": 0.5,             # 180-degree shutter
    "output_dir": "//render",   # blend-relative unless absolute
    "bind": {},                 # {"Dino_Mesh": "Hips"} parents your objects to proxy controls
    "texture_dir": None,        # Substance export folder -> PBR material on bound meshes
    "proxy_render": None,       # None = render proxies only when nothing is bound
}
P = dict(DEFAULTS)
P.update(globals().get("PARAMS") or {})

G = 9.81
TAU = 2.0 * math.pi


# ---------------------------------------------------------------------------
# Gait physics (pure math, no bpy)
# ---------------------------------------------------------------------------

def derive_gait(p):
    h, fr = p["hip_height_m"], p["froude"]
    v = math.sqrt(fr * G * h)
    stride = 2.3 * (fr ** 0.3) * h          # full cycle: left + right step
    cycle_s = stride / v
    breath_s = 4.0 * (p["mass_kg"] / 70.0) ** 0.26 * 0.5  # allometric resting period, halved for exertion
    return {
        "speed_mps": v, "speed_kmh": v * 3.6, "stride_m": stride, "cycle_s": cycle_s,
        "cycle_frames": cycle_s * p["fps"], "step_frames": cycle_s * p["fps"] / 2.0,
        "breath_s": breath_s, "scale": h / 3.1,
    }


def smoothstep(x):
    x = max(0.0, min(1.0, x))
    return x * x * (3.0 - 2.0 * x)


def foot_world(phase, offset, gait, p, x0):
    """World (x, z, pitch) of a foot. Planted in stance, eased arc in swing."""
    beta = p["duty_factor"]
    lam = gait["stride_m"]
    u = phase + offset
    n = math.floor(u)
    phi = u - n
    base = x0 + n * lam + lam * (beta / 2.0 - offset)   # plant spot: centred under the hip at mid-stance
    if phi < beta:
        return base, 0.0, 0.0, False
    s = (phi - beta) / (1.0 - beta)
    lift = 0.12 * p["hip_height_m"]
    z = lift * math.sin(math.pi * (s ** 0.8))           # quick pick-up, careful set-down
    pitch = -math.radians(18.0) * math.sin(math.pi * s)  # toe-off / reach
    return base + lam * smoothstep(s), z, pitch, True


def body_pose(t, gait, p):
    """Root x and hip offsets at time t (seconds)."""
    ph = t / gait["cycle_s"]
    beta = p["duty_factor"]
    h = p["hip_height_m"]
    a = 0.04                                              # speed surge per step (push-off)
    x = gait["speed_mps"] * t - gait["speed_mps"] * a * math.cos(2 * TAU * ph) * gait["cycle_s"] / (2 * TAU)
    c = math.cos(TAU * (ph - beta / 2.0))                 # +1 at left mid-stance
    return {
        "phase": ph,
        "root_x": x,
        "hip_z": h - 0.028 * h * math.cos(2 * TAU * (ph - 0.06)),  # lowest just after each contact
        "hip_y": 0.04 * h * c,                              # weight over the stance foot
        "hip_roll": math.radians(3.0) * c,                  # swing side drops
        "hip_yaw": math.radians(4.0) * c,                   # pelvis follows the swinging leg
        "hip_pitch": math.radians(1.2) * math.sin(2 * TAU * ph),
    }


# ---------------------------------------------------------------------------
# Blender helpers
# ---------------------------------------------------------------------------

def collection(name):
    col = bpy.data.collections.get(name)
    if col is None:
        col = bpy.data.collections.new(name)
        bpy.context.scene.collection.children.link(col)
    return col


def remove_existing(prefix):
    """Delete a previous build; children we did not create (a bound hero mesh) keep their pose."""
    doomed = [ob for ob in bpy.data.objects if ob.name.startswith(prefix)]
    if not doomed:
        return
    bpy.context.scene.frame_set(bpy.context.scene.frame_start)
    for ob in doomed:
        for child in ob.children:
            if not child.name.startswith(prefix):
                mw = child.matrix_world.copy()
                child.parent = None
                child.matrix_world = mw
    for ob in doomed:
        bpy.data.objects.remove(ob, do_unlink=True)


def empty(name, col, parent=None, loc=(0, 0, 0), size=0.3, shape="PLAIN_AXES"):
    ob = bpy.data.objects.new(name, None)
    ob.empty_display_type = shape
    ob.empty_display_size = size
    col.objects.link(ob)
    ob.parent = parent
    ob.location = loc
    ob.rotation_mode = "XYZ"
    return ob


def proxy_box(name, col, parent, size, offset=(0, 0, 0), mat=None):
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts:
        v.co = (v.co.x * size[0] + offset[0], v.co.y * size[1] + offset[1], v.co.z * size[2] + offset[2])
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new(name, me)
    col.objects.link(ob)
    ob.parent = parent
    if mat:
        me.materials.append(mat)
    return ob


def proxy_material():
    mat = bpy.data.materials.get("PROXY_Skin") or bpy.data.materials.new("PROXY_Skin")
    mat.use_nodes = True
    bsdf = next((n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None)
    if bsdf:
        bsdf.inputs["Base Color"].default_value = (0.23, 0.2, 0.16, 1.0)
        bsdf.inputs["Roughness"].default_value = 0.72     # matte, aged scales
    return mat


def fcurves_of(ob):
    """F-curves for an object's action on Blender 4.x (legacy) and 5.x (slotted actions)."""
    ad = ob.animation_data
    if not ad or not ad.action:
        return []
    act = ad.action
    if hasattr(act, "fcurves") and not getattr(act, "is_action_layered", False):
        return list(act.fcurves)
    from bpy_extras import anim_utils
    cb = anim_utils.action_get_channelbag_for_slot(act, ad.action_slot)
    return list(cb.fcurves) if cb else []


def key(ob, frame, loc=None, rot=None, scale=None):
    if loc is not None:
        ob.location = loc
        ob.keyframe_insert("location", frame=frame)
    if rot is not None:
        ob.rotation_euler = rot
        ob.keyframe_insert("rotation_euler", frame=frame)
    if scale is not None:
        ob.scale = scale
        ob.keyframe_insert("scale", frame=frame)


def apply_pbr(ob, tex_dir):
    """Principled material from Substance 'PBR Metallic Roughness' exports found in tex_dir."""
    files = os.listdir(tex_dir)

    def find(*keys):
        for f in files:
            low = f.lower().replace("_", "")
            if any(k in low for k in keys):
                return os.path.join(tex_dir, f)
        return None

    mat = bpy.data.materials.new(ob.name + "_PBR")
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED")
    out = next(n for n in nt.nodes if n.type == "OUTPUT_MATERIAL")
    used = {}

    def img(path, non_color):
        node = nt.nodes.new("ShaderNodeTexImage")
        node.image = bpy.data.images.load(path, check_existing=True)
        if non_color:
            node.image.colorspace_settings.name = "Non-Color"
        return node

    for label, keys, sock, non_color in (
        ("base", ("basecolor", "albedo", "diffuse"), "Base Color", False),
        ("rough", ("roughness",), "Roughness", True),
        ("metal", ("metallic", "metalness"), "Metallic", True),
    ):
        f = find(*keys)
        if f:
            nt.links.new(img(f, non_color).outputs["Color"], bsdf.inputs[sock])
            used[label] = os.path.basename(f)
    f = find("normal")
    if f:
        nm = nt.nodes.new("ShaderNodeNormalMap")
        nt.links.new(img(f, True).outputs["Color"], nm.inputs["Color"])
        nt.links.new(nm.outputs["Normal"], bsdf.inputs["Normal"])
        used["normal"] = os.path.basename(f)
    f = find("height", "displacement")
    if f:
        disp = nt.nodes.new("ShaderNodeDisplacement")
        disp.inputs["Scale"].default_value = 0.02 * P["hip_height_m"] / 3.1
        nt.links.new(img(f, True).outputs["Color"], disp.inputs["Height"])
        nt.links.new(disp.outputs["Displacement"], out.inputs["Displacement"])
        try:
            mat.displacement_method = "BOTH"   # true micro-displacement + bump
        except (AttributeError, TypeError):
            pass
        used["height"] = os.path.basename(f)
    if ob.data and hasattr(ob.data, "materials"):
        ob.data.materials.clear()
        ob.data.materials.append(mat)
    return used


# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------

def build():
    scene = bpy.context.scene
    gait = derive_gait(P)
    s = gait["scale"]
    h = P["hip_height_m"]
    fps = int(P["fps"])
    f0, f1 = 1, int(round(P["duration_s"] * fps))

    scene.render.fps = fps
    scene.render.fps_base = 1.0
    scene.frame_start, scene.frame_end = f0, f1
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.scale_length = 1.0

    if "Cube" in bpy.data.objects:
        bpy.data.objects.remove(bpy.data.objects["Cube"], do_unlink=True)
    remove_existing("CR_")
    col = collection("Creature_Rig")
    cam_col = collection("Camera_Rig")
    mat = proxy_material()

    # --- proxy rig (body faces +X) -------------------------------------------------
    root = empty("CR_Root", col, size=1.5 * s, shape="ARROWS")
    hips = empty("CR_Hips", col, root, (0, 0, h), 0.8 * s, "CUBE")
    proxies = [proxy_box("CR_px_Hips", col, hips, (1.5 * s, 1.0 * s, 1.1 * s), mat=mat)]
    spine, parent = [], hips
    for i, off in enumerate(((0.9 * s, 0, 0.12 * s), (0.9 * s, 0, 0.1 * s))):
        j = empty("CR_Spine%d" % (i + 1), col, parent, off, 0.5 * s)
        proxies.append(proxy_box("CR_px_Spine%d" % (i + 1), col, j, (1.1 * s, 1.1 * s, 1.3 * s), mat=mat))
        spine.append(j)
        parent = j
    chest = spine[-1]
    neck, parent = [], empty("CR_NeckBase", col, chest, (0.7 * s, 0, 0.3 * s), 0.4 * s)
    for i in range(P["neck_joints"]):
        j = empty("CR_Neck%d" % (i + 1), col, parent, (0.32 * s, 0, 0.12 * s), 0.35 * s)
        proxies.append(proxy_box("CR_px_Neck%d" % (i + 1), col, j, (0.45 * s, 0.6 * s, 0.7 * s), mat=mat))
        neck.append(j)
        parent = j
    head = empty("CR_Head", col, parent, (0.35 * s, 0, 0.05 * s), 0.4 * s, "SPHERE")
    proxies.append(proxy_box("CR_px_Head", col, head, (1.5 * s, 0.6 * s, 0.65 * s), (0.6 * s, 0, 0), mat=mat))
    tail, parent = [], hips
    for i in range(P["tail_joints"]):
        taper = 1.0 - 0.13 * i
        j = empty("CR_Tail%d" % (i + 1), col, parent, (-0.85 * s if i else -0.7 * s, 0, 0), 0.4 * s * taper)
        proxies.append(proxy_box("CR_px_Tail%d" % (i + 1), col, j, (0.9 * s, 0.8 * s * taper, 0.8 * s * taper),
                                 (-0.45 * s, 0, 0), mat=mat))
        tail.append(j)
        parent = j
    feet, legs = {}, {}
    for side, sy in (("L", 1.0), ("R", -1.0)):
        sock = empty("CR_HipSocket_%s" % side, col, hips, (0, sy * 0.5 * s, -0.15 * s), 0.25 * s)
        foot = empty("CR_Foot_%s" % side, col, None, (0, sy * 0.38 * s, 0), 0.5 * s, "CUBE")
        proxies.append(proxy_box("CR_px_Foot_%s" % side, col, foot, (0.9 * s, 0.4 * s, 0.2 * s), (0.2 * s, 0, 0.1 * s), mat=mat))
        leg = proxy_box("CR_px_Leg_%s" % side, col, sock, (0.45 * s, 1.0, 0.45 * s), (0, 0.5, 0), mat=mat)
        st = leg.constraints.new("STRETCH_TO")
        st.target = foot
        st.rest_length = 1.0
        st.volume = "NO_VOLUME"
        proxies.append(leg)
        feet[side], legs[side] = foot, leg

    # --- shot layout ----------------------------------------------------------------
    dur = P["duration_s"]
    cam_x = 0.0
    x0 = cam_x - gait["speed_mps"] * P["pass_at"] * dur
    cam_pos = (cam_x, -P["cam_distance_m"], P["cam_height_m"])

    # --- camera rig: operator pans a tripod-less camera, reacting late ---------------
    remove_existing("CAM_")
    aim = empty("CAM_Aim", cam_col, None, (0, 0, h), 0.5)
    rig = empty("CAM_Rig", cam_col, None, cam_pos, 0.5)
    tt = rig.constraints.new("TRACK_TO")
    tt.target = aim
    tt.track_axis = "TRACK_NEGATIVE_Z"
    tt.up_axis = "UP_Y"
    cam_data = bpy.data.cameras.new("CAM_Cinematic")
    cam = bpy.data.objects.new("CAM_Cinematic", cam_data)
    cam_col.objects.link(cam)
    cam.parent = rig
    cam.rotation_mode = "XYZ"
    cam_data.lens = P["lens_mm"]
    cam_data.sensor_fit = "HORIZONTAL"
    cam_data.sensor_width = P["sensor_mm"]
    cam_data.clip_end = 1000.0
    cam_data.dof.use_dof = True
    cam_data.dof.focus_object = head
    cam_data.dof.aperture_fstop = P["fstop"]
    cam_data.dof.aperture_blades = 7
    scene.camera = cam

    # --- bake the animation -------------------------------------------------------
    lag = P["joint_lag_frames"] / float(fps)
    N, M = len(neck), len(tail)
    look_max = math.radians(P["look_max_deg"])
    contacts = []
    prev_swing = {"L": None, "R": None}
    for f in range(f0, f1 + 1):
        t = (f - f0) / float(fps)
        b = body_pose(t, gait, P)
        key(root, f, loc=(x0 + b["root_x"], 0, 0))
        key(hips, f, loc=(0, b["hip_y"], b["hip_z"]), rot=(b["hip_roll"], b["hip_pitch"], b["hip_yaw"]))
        # spine counter-rotates the pelvis yaw (shoulders vs hips), lagged
        for i, j in enumerate(spine):
            bl = body_pose(t - (i + 1) * lag, gait, P)
            key(j, f, rot=(-0.4 * bl["hip_roll"], 0.0, -0.35 * bl["hip_yaw"]))
        breathe = 1.0 + 0.012 * math.sin(TAU * t / gait["breath_s"])
        key(chest, f, scale=(1.0, breathe, breathe))

        # head-look toward the lens: head leads, each joint toward the base engages later
        head_x = x0 + b["root_x"] + 3.3 * s
        want = math.atan2(cam_pos[1] - 0.0, cam_pos[0] - head_x)
        want = max(-look_max, min(look_max, want))

        def look_w(tt_):
            u = tt_ / dur
            return smoothstep((u - P["look_in"]) / 0.12) * (1.0 - smoothstep((u - P["look_hold"]) / max(0.01, P["look_out"] - P["look_hold"])))

        body_yaw = b["hip_yaw"] - 0.35 * b["hip_yaw"] * len(spine)
        neck_pitch_sum = 0.0
        for k, j in enumerate(neck):
            tk = t - (k + 1) * lag
            bk = body_pose(tk, gait, P)
            amp = math.radians(2.2) * (k + 1) / N
            pitch = amp * math.cos(2 * TAU * (bk["phase"] - 0.06))       # neck droops after the hips drop
            yaw_bal = -math.radians(1.5) * math.cos(TAU * (bk["phase"] - P["duty_factor"] / 2.0))
            w = look_w(t - (N - k) * lag)
            yaw = yaw_bal + w * (want - body_yaw) * 0.6 / N
            neck_pitch_sum += pitch
            key(j, f, rot=(0.0, pitch, yaw))
        # gaze stabilisation: the head cancels most of the body/neck pitch
        key(head, f, rot=(0.0, -0.85 * (neck_pitch_sum + b["hip_pitch"]), look_w(t) * (want - body_yaw) * 0.4))

        for k, j in enumerate(tail):
            tk = t - (k + 1) * lag
            bk = body_pose(tk, gait, P)
            r = ((k + 1) / float(M)) ** 0.7
            yaw = -math.radians(3.2) * r * math.cos(TAU * (bk["phase"] - P["duty_factor"] / 2.0))
            pitch = -math.radians(1.4) * r * math.cos(2 * TAU * (bk["phase"] - 0.06))
            key(j, f, rot=(0.0, pitch, yaw))

        for side, off, sy in (("L", 0.0, 1.0), ("R", 0.5, -1.0)):
            fx, fz, fp, swing = foot_world(b["phase"], off, gait, P, x0)
            key(feet[side], f, loc=(fx, sy * 0.38 * s, fz), rot=(0.0, fp, 0.0))
            if prev_swing[side] and not swing:
                contacts.append((f, side))
            prev_swing[side] = swing

        # operator follows the chest late (reaction lag), aim point smoothed
        ba = body_pose(max(0.0, t - P["operator_lag_s"]), gait, P)
        key(aim, f, loc=(x0 + ba["root_x"] + 1.8 * s, 0.0, 0.95 * h))

    # --- camera: footfall impacts + handheld noise ---------------------------------
    for m in [m for m in scene.timeline_markers if m.name.endswith("_contact")]:
        scene.timeline_markers.remove(m)
    shake = math.radians(P["footfall_shake_deg"]) * (P["mass_kg"] / 8000.0) ** (1 / 3.0) * (10.0 / max(1.0, P["cam_distance_m"]))
    for f in range(f0, f1 + 1):
        rx = rz = 0.0
        for c, _side in contacts:
            d = (f - c) / float(fps)
            if 0.0 <= d < 0.6:
                env = math.exp(-d / 0.12)
                rx += shake * env * math.sin(TAU * d * 9.0)
                rz += 0.35 * shake * env * math.sin(TAU * d * 7.0 + 1.3)
        key(cam, f, rot=(rx, 0.0, rz))
    for c, side in contacts:
        scene.timeline_markers.new("%s_contact" % side, frame=c)
    for fc in fcurves_of(cam):
        if fc.data_path == "rotation_euler":
            mod = fc.modifiers.new("NOISE")
            mod.scale = 38.0 + 7.0 * fc.array_index
            mod.strength = math.radians(P["handheld_deg"]) * 2.0
            mod.phase = 11.0 * (fc.array_index + 1)

    # --- bind the hero asset ---------------------------------------------------------
    bound = {}
    for obj_name, ctrl_name in (P["bind"] or {}).items():
        ob = bpy.data.objects.get(obj_name)
        ctrl = bpy.data.objects.get("CR_" + ctrl_name) or bpy.data.objects.get(ctrl_name)
        if ob is None or ctrl is None:
            bound[obj_name] = "skipped (object or control missing)"
            continue
        scene.frame_set(f0)
        mw = ob.matrix_world.copy()
        ob.parent = ctrl
        ob.matrix_parent_inverse = ctrl.matrix_world.inverted()
        ob.matrix_world = mw
        bound[obj_name] = ctrl.name
        if P["texture_dir"] and os.path.isdir(bpy.path.abspath(P["texture_dir"])):
            bound[obj_name + ":pbr"] = apply_pbr(ob, bpy.path.abspath(P["texture_dir"]))
    show_proxies = P["proxy_render"] if P["proxy_render"] is not None else not any(v.startswith("CR_") for v in bound.values() if isinstance(v, str))
    for px in proxies:
        px.hide_render = not show_proxies

    # --- ground / light / world ------------------------------------------------------
    remove_existing("ENV_")
    env_col = collection("Environment")
    gme = bpy.data.meshes.new("ENV_Ground")
    bm = bmesh.new()
    bmesh.ops.create_grid(bm, x_segments=1, y_segments=1, size=150.0)
    bm.to_mesh(gme)
    bm.free()
    ground = bpy.data.objects.new("ENV_Ground", gme)
    env_col.objects.link(ground)
    ground.is_shadow_catcher = True     # shadows only; the plate provides the ground in comp
    sun_data = bpy.data.lights.new("ENV_Sun", "SUN")
    sun_data.energy = 4.0
    sun_data.angle = math.radians(0.8)
    sun = bpy.data.objects.new("ENV_Sun", sun_data)
    env_col.objects.link(sun)
    sun.rotation_euler = (math.radians(48), 0.0, math.radians(35))
    world = scene.world or bpy.data.worlds.new("World")
    scene.world = world
    world.mist_settings.start = max(0.0, P["cam_distance_m"] - 6.0)
    world.mist_settings.depth = 60.0
    world.mist_settings.falloff = "LINEAR"

    # --- render / passes ---------------------------------------------------------------
    r = scene.render
    r.engine = P["engine"]
    r.resolution_x, r.resolution_y = P["resolution"]
    r.resolution_percentage = 100
    r.use_motion_blur = True
    r.motion_blur_shutter = P["shutter"]
    r.film_transparent = True
    if r.engine == "CYCLES":
        scene.cycles.samples = P["samples"]
        scene.cycles.use_denoising = True
    vl = bpy.context.view_layer
    for attr in ("use_pass_z", "use_pass_mist", "use_pass_normal", "use_pass_cryptomatte_object"):
        if hasattr(vl, attr):
            setattr(vl, attr, True)
    if hasattr(vl, "cycles") and hasattr(vl.cycles, "use_pass_shadow_catcher"):
        vl.cycles.use_pass_shadow_catcher = True
    out_dir = P["output_dir"]
    if hasattr(r.image_settings, "media_type"):            # Blender 5.x
        r.image_settings.media_type = "MULTI_LAYER_IMAGE"
    else:
        r.image_settings.file_format = "OPEN_EXR_MULTILAYER"
    r.image_settings.color_depth = "16"
    r.filepath = os.path.join(out_dir, "exr", "Dino_Render_")
    comp_outputs = setup_pass_outputs(scene, out_dir)

    scene.frame_set(f0)
    return {
        "gait": {k: round(v, 3) for k, v in gait.items()},
        "frames": [f0, f1], "fps": fps,
        "contacts": [c for c, _ in contacts],
        "camera": {"lens_mm": P["lens_mm"], "distance_m": P["cam_distance_m"], "fstop": P["fstop"],
                   "shutter": P["shutter"], "footfall_shake_deg": round(math.degrees(shake), 3)},
        "bound": bound, "proxies_render": show_proxies,
        "outputs": {"multilayer_exr": r.filepath, **comp_outputs},
    }


def setup_pass_outputs(scene, out_dir):
    """PNG sequences AE can import directly: beauty (RGBA), shadow catcher, mist."""
    want = (("Image", "beauty", "Dino_Render_Beauty_", "RGBA"),
            ("Shadow Catcher", "shadow", "Dino_Shadow_", "RGB"),
            ("Mist", "mist", "Dino_Mist_", "BW"))
    written = {}
    try:
        if hasattr(scene, "compositing_node_group"):      # Blender 5.x
            tree = scene.compositing_node_group
            if tree is None:
                tree = bpy.data.node_groups.new("MCP_Compositor", "CompositorNodeTree")
                scene.compositing_node_group = tree
        else:                                               # Blender 4.x
            scene.use_nodes = True
            tree = scene.node_tree
        for n in [n for n in tree.nodes if n.name.startswith("MCP_")]:
            tree.nodes.remove(n)
        rl = tree.nodes.new("CompositorNodeRLayers")
        rl.name = "MCP_RenderLayers"
        for i, (sock_name, sub, base, mode) in enumerate(want):
            sock = next((o for o in rl.outputs if o.name == sock_name and o.enabled), None)
            if sock is None:
                written[sub] = "skipped (pass %r unavailable for this engine)" % sock_name
                continue
            fo = tree.nodes.new("CompositorNodeOutputFile")
            fo.name = "MCP_Out_" + sub
            fo.location = (400, -200 * i)
            if hasattr(fo.format, "media_type"):              # 5.x defaults nodes to multilayer EXR
                fo.format.media_type = "IMAGE"
            fo.format.file_format = "PNG"
            fo.format.color_depth = "16"
            fo.format.color_mode = mode
            folder = os.path.join(out_dir, sub)
            if hasattr(fo, "file_output_items"):             # 5.x
                fo.directory = folder
                fo.file_name = base
                fo.file_output_items.clear()
                item = fo.file_output_items.new("RGBA" if mode != "BW" else "FLOAT", "")
                tree.links.new(sock, fo.inputs[item.name] if item.name else fo.inputs[0])
            else:                                            # 4.x
                fo.base_path = folder
                fo.file_slots[0].path = base
                tree.links.new(sock, fo.inputs[0])
            written[sub] = os.path.join(folder, base + "####.png")
    except Exception as e:  # never lose the shot over comp plumbing; the EXR has every pass
        written["error"] = "pass outputs not configured: %s" % e
    return written


result = build()
