// Auto Vertical Reframe — runs Premiere's AI Auto Reframe on the active sequence to
// produce a 9:16 vertical duplicate with subject tracking, named "<sequence> 9x16".
// Gotcha encoded here: the motion preset argument MUST be the string 'default'
// (a numeric preset throws 'Illegal Parameter type').
(function () {
  var seq = app.project.activeSequence;
  if (!seq) return "no active sequence";
  var v = seq.autoReframeSequence(9, 16, "default", seq.name + " 9x16", false);
  return v ? "created: " + v.name : "autoReframeSequence returned null";
})();
