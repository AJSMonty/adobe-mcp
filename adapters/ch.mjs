// Character Animator toolkit.
// CH has no scripting API — we integrate around it: generate rig-ready layered PSD
// puppets (correct naming taxonomy → CH auto-rigs on import), and document the taxonomy
// so custom puppets can be authored via ps_run_extendscript.
import { z } from "zod";
import path from "node:path";
import { runJSX, WORKSPACE } from "../core/bridge.mjs";

const TAXONOMY = `Character Animator auto-rig naming taxonomy (layered PSD/AI):
- Root group "+Name" — "+" makes a group warp-independent.
- "Head" group (inside root): "Left Eyebrow", "Right Eyebrow" (stage-left/right),
  "Left Eye"/"Right Eye" groups each containing "Left/Right Pupil" and "Left/Right Blink"
  (blink layer hidden), "Nose", and a "Mouth" group of viseme layers:
  Neutral, Aa, D, Ee, F, L, M, Oh, R, S, Uh, W-Oo, Smile, Surprised (only Neutral visible).
- "Body" group: "Left Arm", "Right Arm", "Left Leg", "Right Leg", torso artwork.
- Import the .psd into CH (File → Import) — it auto-tags by these names; webcam drives head/eyes,
  mic drives mouth visemes. Scenes Dynamic-Link into Premiere like AE comps.`;

export function register(server, { text, errText, registerAsset }) {
  server.registerTool(
    "ch_taxonomy",
    {
      title: "Character Animator rigging reference",
      description:
        "Returns the PSD/AI layer-naming taxonomy Character Animator auto-rigs from. Use with " +
        "ps_run_extendscript or ai_run_extendscript to author custom puppets.",
      inputSchema: {},
    },
    async () => text(TAXONOMY)
  );

  server.registerTool(
    "ch_build_puppet",
    {
      title: "Generate a rig-ready Character Animator puppet",
      description:
        "Builds a layered PSD puppet in Photoshop with the full CH auto-rig taxonomy (head, brows, " +
        "eyes with pupils+blinks, 14 mouth visemes, body with limbs) using a simple cartoon style, " +
        "saves it to the workspace, and registers it as an asset. Import the PSD into CH to perform it.",
      inputSchema: {
        name: z.string().describe("Character name (used for the root group and filename)."),
        skin: z.array(z.number()).optional().describe("Skin RGB 0-255 (default [255,222,184])."),
        hair: z.array(z.number()).optional().describe("Hair RGB 0-255 (default [250,225,90])."),
        shirt: z.array(z.number()).optional().describe("Shirt RGB 0-255 (default [51,140,191])."),
        timeout_seconds: z.number().optional().describe("Max seconds (default 300)."),
      },
    },
    async ({ name, skin, hair, shirt, timeout_seconds }) => {
      try {
        const outPath = path.join(WORKSPACE, `${name.replace(/[^\w\- ]/g, "_")}_puppet.psd`);
        const S = skin ?? [255, 222, 184];
        const H = hair ?? [250, 225, 90];
        const SH = shirt ?? [51, 140, 191];
        const jsx = `
var W = 1200, Hh = 1600;
var doc = app.documents.add(W, Hh, 72, ${JSON.stringify(name + " puppet")}, NewDocumentMode.RGB, DocumentFill.TRANSPARENT);
function col(r,g,b){ var c = new SolidColor(); c.rgb.red=r; c.rgb.green=g; c.rgb.blue=b; return c; }
var SKIN=col(${S[0]},${S[1]},${S[2]}), HAIR=col(${H[0]},${H[1]},${H[2]}), SHIRT=col(${SH[0]},${SH[1]},${SH[2]});
var DARK=col(60,42,30), WHITE=col(255,255,255), MOUTH=col(150,60,60);
function circlePts(cx,cy,r,ry){ ry=ry||r; var p=[]; for (var i=0;i<28;i++){ var a=i/28*2*Math.PI; p.push([cx+Math.cos(a)*r, cy+Math.sin(a)*ry]); } return p; }
function rectPts(x0,y0,x1,y1){ return [[x0,y0],[x1,y0],[x1,y1],[x0,y1]]; }
// draw a filled shape onto a NEW layer inside the given set
function shape(set, lname, pts, color, hidden){
  var lay = set.artLayers.add(); lay.name = lname;
  doc.activeLayer = lay;
  doc.selection.select(pts);
  doc.selection.fill(color);
  doc.selection.deselect();
  if (hidden) lay.visible = false;
  return lay;
}
// groups
var root = doc.layerSets.add(); root.name = '+' + ${JSON.stringify(name)};
var body = root.layerSets.add(); body.name = 'Body';
var head = root.layerSets.add(); head.name = 'Head';
// ---- BODY ----
shape(body, 'Left Leg',  rectPts(520,1230,575,1450), DARK);
shape(body, 'Right Leg', rectPts(625,1230,680,1450), DARK);
shape(body, 'Left Arm',  rectPts(415,930,470,1160), SKIN);
shape(body, 'Right Arm', rectPts(730,930,785,1160), SKIN);
shape(body, 'Torso', circlePts(600,1050,160,190), SHIRT);
// ---- HEAD (back to front: new layers land at the TOP of their container) ----
shape(head, 'Neck', rectPts(560,830,640,900), SKIN);
shape(head,'Face', circlePts(600,600,150,170), SKIN);
shape(head,'Hair', circlePts(600,470,150,90), HAIR);
shape(head,'Left Eyebrow',  rectPts(510,505,575,520), DARK);
shape(head,'Right Eyebrow', rectPts(625,505,690,520), DARK);
function eye(side, cx){
  var g = head.layerSets.add(); g.name = side + ' Eye';
  shape(g, side + ' Eyeball', circlePts(cx,560,24,24), WHITE);
  shape(g, side + ' Pupil', circlePts(cx,560,9,9), DARK);
  shape(g, side + ' Blink', circlePts(cx,560,26,8), SKIN, true);
  return g;
}
eye('Left', 540); eye('Right', 660);
shape(head,'Nose', circlePts(600,640,14,10), col(230,170,140));
var mouth = head.layerSets.add(); mouth.name='Mouth';
shape(mouth,'Neutral', circlePts(600,698,32,14), MOUTH, false);
shape(mouth,'Aa', circlePts(600,702,34,38), MOUTH, true);
shape(mouth,'D', circlePts(600,698,36,20), MOUTH, true);
shape(mouth,'Ee', circlePts(600,698,44,18), MOUTH, true);
shape(mouth,'F', rectPts(556,688,644,708), MOUTH, true);
shape(mouth,'L', circlePts(600,698,30,26), MOUTH, true);
shape(mouth,'M', rectPts(560,694,640,704), MOUTH, true);
shape(mouth,'Oh', circlePts(600,700,30,40), MOUTH, true);
shape(mouth,'R', circlePts(600,698,34,22), MOUTH, true);
shape(mouth,'S', rectPts(555,690,645,706), MOUTH, true);
shape(mouth,'Uh', circlePts(600,700,30,34), MOUTH, true);
shape(mouth,'W-Oo', circlePts(600,700,22,30), MOUTH, true);
shape(mouth,'Smile', circlePts(600,695,60,26), MOUTH, true);
shape(mouth,'Surprised', circlePts(600,700,34,44), MOUTH, true);
// save
var f = new File(${JSON.stringify(outPath)});
var po = new PhotoshopSaveOptions(); po.layers = true;
doc.saveAs(f, po, true, Extension.LOWERCASE);
return { saved: f.fsName, layers: 'CH taxonomy: head/eyes/brows/14 visemes/body limbs' };`;
        const r = await runJSX("ps", jsx, (timeout_seconds ?? 300) * 1000);
        registerAsset({ app: "ch", kind: "psd-puppet", path: outPath, meta: { character: name } });
        return text({ ...r, next: "Import this PSD into Character Animator (File → Import) — it auto-rigs. Scenes then Dynamic-Link into Premiere." });
      } catch (e) {
        return errText(e);
      }
    }
  );
}
