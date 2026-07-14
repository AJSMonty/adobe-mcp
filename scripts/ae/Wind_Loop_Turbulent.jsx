// Wind Loop (Turbulent) — makes the selected layers ripple as if blowing in the wind,
// looping seamlessly over the comp duration. Adds Turbulent Displace with a cycling
// Evolution (one full revolution per comp loop) plus loop-safe sway and bob expressions.
(function () {
  var comp = app.project.activeItem;
  if (!(comp instanceof CompItem) || !comp.selectedLayers.length) {
    alert("Select layer(s) in a comp first.");
    return;
  }
  app.beginUndoGroup("Wind Loop");
  var degPerSec = 360 / comp.duration;
  for (var i = 0; i < comp.selectedLayers.length; i++) {
    var l = comp.selectedLayers[i];
    var fx = l.property("ADBE Effect Parade").addProperty("ADBE Turbulent Displace");
    fx.property("Amount").setValue(12);
    fx.property("Size").setValue(150);
    fx.property("Complexity").setValue(1.3);
    try {
      fx.property("Cycle Evolution").setValue(1);
      fx.property("Cycle (in Revolutions)").setValue(1);
    } catch (e) {}
    fx.property("Evolution").expression = "time * " + degPerSec + ";";
    l.rotation.expression =
      "1.2 * Math.sin(time * Math.PI * 2 / " + comp.duration + ");";
    l.position.expression =
      "value + [0, 5 * Math.sin(time * Math.PI * 4 / " + comp.duration + ")];";
    l.motionBlur = true;
  }
  app.endUndoGroup();
})();
