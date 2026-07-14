// Blueprint Line Extract — converts the active layer to white line-art on black
// (desaturate + contrast boost + Smart Blur Edge Only). Composite the result in
// SCREEN blend mode over a colored ground for blueprint / technical-drawing looks.
// Best on isolated, high-contrast subjects; the levels boost makes silhouettes register.
(function () {
  var doc = app.activeDocument;
  var lyr = doc.activeLayer;
  lyr.desaturate();
  lyr.adjustLevels(30, 190, 1.15, 0, 255);
  lyr.applySmartBlur(2, 14, SmartBlurQuality.HIGH, SmartBlurMode.EDGEONLY);
  lyr.name = lyr.name + " [linework]";
})();
