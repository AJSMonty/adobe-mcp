/*
 Cinematic_3D_Composite — lands a Blender CG render on a live-action plate in the active comp.
 Imports the beauty / shadow / mist PNG sequences from PARAMS.render_dir (the folders written by
 scripts/blender/Creature_Walk_Cinematic.py) or uses existing layers named Dino_Render_Beauty,
 Dino_Shadow, Dino_Mist and BG_Plate. Builds: multiplied shadow-catcher pass, a precomped edge
 light wrap (blurred plate inside the CG's inner edge, screened), depth haze from the mist pass,
 an optional depth lens blur, a 0.5 px CG softening, and plate-matched grain on the CG only.
 Motion blur is NOT added here: the 180-degree shutter is already baked into the render.
 PARAMS keys: render_dir, fps (24), wrap_px (18), wrap_opacity (55), shadow_opacity (85),
 haze_color ([0.62,0.68,0.74]), haze_amount (35), lens_blur_radius (0), focus_value (0.1).
*/
(function () {
  var P = (typeof $.global.PARAMS === "object" && $.global.PARAMS) ? $.global.PARAMS : {};
  function opt(k, d) { return (P[k] === undefined || P[k] === null) ? d : P[k]; }
  var report = { steps: [] };
  function note(s) { report.steps.push(s); }

  function findProp(group, name) {
    for (var i = 1; i <= group.numProperties; i++) {
      var p = group.property(i);
      if (p.name === name || p.matchName === name) return p;
      if (p.propertyType !== PropertyType.PROPERTY) {
        var hit = findProp(p, name);
        if (hit) return hit;
      }
    }
    return null;
  }
  function setP(effect, name, value) {
    var p = findProp(effect, name);
    if (p) { p.setValue(value); return true; }
    note("param '" + name + "' not found on " + effect.name);
    return false;
  }
  // Layer-reference params store an index; set them only after the stack stops changing.
  var layerRefs = [];
  function setLayerRef(effect, name, layer) { layerRefs.push({ effect: effect, name: name, layer: layer }); }
  function layerNamed(comp, name) {
    for (var i = 1; i <= comp.numLayers; i++) if (comp.layer(i).name === name) return comp.layer(i);
    return null;
  }
  function firstPng(folder) {
    var f = new Folder(folder);
    if (!f.exists) return null;
    var all = f.getFiles("*.png"), files = [];
    for (var i = 0; i < all.length; i++) if (/\d+\.png$/i.test(all[i].name)) files.push(all[i]);
    if (!files.length) return null;
    files.sort(function (a, b) { return a.name < b.name ? -1 : 1; });
    return files[0];
  }
  function importSeq(folder, name, fps) {
    var first = firstPng(folder);
    if (!first) return null;
    var io = new ImportOptions(first);
    io.sequence = true;
    var item = app.project.importFile(io);
    item.mainSource.conformFrameRate = fps;
    item.name = name;
    return item;
  }
  function matteTo(layer, matte, type) {
    if (typeof layer.setTrackMatte === "function") layer.setTrackMatte(matte, type); // AE 23+
    else { matte.moveBefore(layer); layer.trackMatteType = type; }
  }

  app.beginUndoGroup("Cinematic 3D Composite");
  var fps = opt("fps", 24);
  var comp = app.project.activeItem;
  var dir = opt("render_dir", null);
  var items = {};
  if (dir) {
    items.beauty = importSeq(dir + "/beauty", "Dino_Render_Beauty", fps);
    items.shadow = importSeq(dir + "/shadow", "Dino_Shadow", fps);
    items.mist = importSeq(dir + "/mist", "Dino_Mist", fps);
    if (!items.beauty) throw new Error("No beauty PNG sequence in " + dir + "/beauty");
    note("imported sequences from " + dir);
  }
  if (!(comp instanceof CompItem)) {
    if (!items.beauty) throw new Error("Open a composition first (or pass PARAMS.render_dir).");
    comp = app.project.items.addComp("Dino_Shot", items.beauty.width, items.beauty.height, 1,
                                     items.beauty.duration, fps);
    comp.openInViewer();
    note("created comp Dino_Shot");
  }
  var beauty = layerNamed(comp, "Dino_Render_Beauty") || (items.beauty ? comp.layers.add(items.beauty) : null);
  if (!beauty) throw new Error("No layer named Dino_Render_Beauty in comp " + comp.name);
  beauty.name = "Dino_Render_Beauty";
  var shadow = layerNamed(comp, "Dino_Shadow") || (items.shadow ? comp.layers.add(items.shadow) : null);
  var mist = layerNamed(comp, "Dino_Mist") || (items.mist ? comp.layers.add(items.mist) : null);
  var plate = layerNamed(comp, "BG_Plate");
  if (!plate) note("no BG_Plate layer: light wrap and grain matching need one (name your plate BG_Plate)");

  // Stack order (top -> bottom): light wrap, haze, beauty, shadow, plate
  if (plate) plate.moveToEnd();
  if (shadow) {
    if (plate) shadow.moveBefore(plate); else shadow.moveToEnd();
    shadow.name = "Dino_Shadow";
    shadow.blendingMode = BlendingMode.MULTIPLY;     // shadow catcher: white = no shadow
    shadow.opacity.setValue(opt("shadow_opacity", 85));
    note("shadow pass multiplied at " + opt("shadow_opacity", 85) + "%");
  }
  beauty.moveToBeginning();

  // CG is sharper than any real lens: soften by half a pixel before grain
  var soft = beauty.Effects.addProperty("ADBE Gaussian Blur 2");
  soft.name = "CG Softening";
  setP(soft, "Blurriness", 0.5);

  var lensR = opt("lens_blur_radius", 0);
  if (mist && lensR > 0) {
    var lb = beauty.Effects.addProperty("ADBE Camera Lens Blur");
    setP(lb, "Blur Radius", lensR);
    setLayerRef(lb, "Layer", mist);
    setP(lb, "Blur Focal Distance", Math.round(255 * opt("focus_value", 0.1)));
    note("depth lens blur r=" + lensR + " from mist pass");
  }

  if (mist) {
    mist.name = "Dino_Mist";
    // Atmospheric perspective: haze colour, matted by depth, clipped to the CG
    var hazeSolid = comp.layers.addSolid(opt("haze_color", [0.62, 0.68, 0.74]), "Dino_Haze",
                                         comp.width, comp.height, comp.pixelAspect, comp.duration);
    hazeSolid.moveBefore(beauty);
    var hazeMatte = comp.layers.add(mist.source);
    hazeMatte.name = "Dino_Haze_Matte";
    hazeMatte.moveBefore(hazeSolid);
    matteTo(hazeSolid, hazeMatte, TrackMatteType.LUMA);
    hazeSolid.opacity.setValue(opt("haze_amount", 35));
    // keep the haze on the CG only
    var hazeClip = hazeSolid.Effects.addProperty("ADBE Set Matte3");
    setLayerRef(hazeClip, "Take Matte From Layer", beauty);
    mist.enabled = false;
    note("depth haze " + opt("haze_amount", 35) + "% from mist pass");
  }

  if (plate) {
    // Light wrap precomp: blurred plate, visible only in the CG's inner edge
    var lw = app.project.items.addComp("Dino_LightWrap", comp.width, comp.height, comp.pixelAspect,
                                       comp.duration, comp.frameRate);
    var base = lw.layers.add(beauty.source);
    var fill = base.Effects.addProperty("ADBE Fill");
    setP(fill, "Color", [0, 0, 0]);
    var wrapPlate = lw.layers.add(plate.source);
    var pb = wrapPlate.Effects.addProperty("ADBE Gaussian Blur 2");
    setP(pb, "Blurriness", 60);
    setP(pb, "Repeat Edge Pixels", 1);
    wrapPlate.preserveTransparency = true;           // only over the CG
    var edge = lw.layers.add(beauty.source);
    var eb = edge.Effects.addProperty("ADBE Gaussian Blur 2");
    setP(eb, "Blurriness", opt("wrap_px", 18));
    matteTo(wrapPlate, edge, TrackMatteType.ALPHA_INVERTED); // inner edge only
    var wrapLayer = comp.layers.add(lw);
    wrapLayer.moveToBeginning();
    wrapLayer.blendingMode = BlendingMode.SCREEN;
    wrapLayer.opacity.setValue(opt("wrap_opacity", 55));
    note("light wrap precomp (" + opt("wrap_px", 18) + " px edge, screen " + opt("wrap_opacity", 55) + "%)");
  }

  for (var r = 0; r < layerRefs.length; r++) setP(layerRefs[r].effect, layerRefs[r].name, layerRefs[r].layer.index);

  // Grain on the CG only (the plate already has its own)
  var grain = beauty.Effects.addProperty("ADBE Add Grain");
  setP(grain, "Viewing Mode", 3);                    // Final Output (default is a preview box)
  setP(grain, "Intensity", 0.35);
  setP(grain, "Size", 0.9);
  note("grain on CG (Add Grain, Final Output)");

  app.endUndoGroup();
  report.comp = comp.name;
  report.layers = [];
  for (var i = 1; i <= comp.numLayers; i++) report.layers.push(comp.layer(i).name);
  $.global.MCP_RESULT = report;
})();
