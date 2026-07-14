// Kinetic Cascade Text — rigs the selected text layers with the 2026 kinetic-typography
// staple: per-character cascade-in (position + rotation + opacity through an eased range
// selector) plus a perpetual wiggly-selector jitter. Stagger multiple layers by selection order.
(function () {
  var comp = app.project.activeItem;
  if (!(comp instanceof CompItem) || !comp.selectedLayers.length) {
    alert("Select text layer(s) in a comp first.");
    return;
  }
  app.beginUndoGroup("Kinetic Cascade");
  for (var i = 0; i < comp.selectedLayers.length; i++) {
    var l = comp.selectedLayers[i];
    if (!(l instanceof TextLayer)) continue;
    var tIn = 0.2 + i * 0.6;
    var dir = i % 2 === 0 ? -1 : 1;
    var anim = l.Text.property("ADBE Text Animators").addProperty("ADBE Text Animator");
    anim.name = "CascadeIn";
    var props = anim.property("ADBE Text Animator Properties");
    props.addProperty("ADBE Text Position 3D").setValue([0, dir * 350, 0]);
    props.addProperty("ADBE Text Rotation").setValue(dir * 90);
    props.addProperty("ADBE Text Opacity").setValue(0);
    var sel = anim.property("ADBE Text Selectors").addProperty("ADBE Text Selector");
    var off = sel.property("ADBE Text Percent Offset");
    off.setValueAtTime(tIn, -100);
    off.setValueAtTime(tIn + 1.1, 100);
    try {
      sel.property("ADBE Text Range Advanced").property("ADBE Text Levels Max Ease").setValue(85);
      sel.property("ADBE Text Range Advanced").property("ADBE Text Levels Min Ease").setValue(30);
    } catch (e) {}
    var anim2 = l.Text.property("ADBE Text Animators").addProperty("ADBE Text Animator");
    anim2.name = "Jitter";
    var props2 = anim2.property("ADBE Text Animator Properties");
    props2.addProperty("ADBE Text Position 3D").setValue([0, 14, 0]);
    props2.addProperty("ADBE Text Rotation").setValue(6);
    // NOTE matchName: "ADBE Text Wiggly Selector" (not "Selector Wiggly")
    var wig = anim2.property("ADBE Text Selectors").addProperty("ADBE Text Wiggly Selector");
    try { wig.property("ADBE Text Wiggly Frequency").setValue(2.2); } catch (e) {}
    l.motionBlur = true;
  }
  comp.motionBlur = true;
  app.endUndoGroup();
})();
