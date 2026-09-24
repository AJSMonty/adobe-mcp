#!/usr/bin/env node
/**
 * adobe-mcp — Model Context Protocol server for the Adobe Creative Cloud suite (macOS).
 *
 * Bridges MCP tool calls into each app's scripting engine:
 *   AE / Photoshop / Illustrator → osascript (DoScript / do javascript) → ExtendScript
 *   Premiere Pro                 → mcp-bridge CEP panel (command-file handoff)
 *   Character Animator           → integrated around (PSD puppet authoring via Photoshop)
 *   Blender                      → Python (bpy) via live add-on socket or headless background process
 *   Substance 3D Painter         → Python via remote scripting (HTTP, port 60041)
 *   Poly Haven / ambientCG       → free CC0 texture + HDRI libraries (HTTPS APIs, local cache)
 *
 * Adapters register namespaced tools (ae_*, ps_*, ai_*, ppro_*, ch_*, blender_*, substance_*), plus cross-app
 * workflow tools (asset registry, layered handoffs, per-app script libraries).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { register as registerAE } from "./adapters/ae.mjs";
import { register as registerPS } from "./adapters/ps.mjs";
import { register as registerAI } from "./adapters/ai.mjs";
import { register as registerPPRO } from "./adapters/ppro.mjs";
import { register as registerCH } from "./adapters/ch.mjs";
import { register as registerBlender } from "./adapters/blender.mjs";
import { register as registerSubstance } from "./adapters/substance.mjs";
import { register as registerTexLib } from "./adapters/texlib.mjs";
import { register as registerVFX } from "./workflow/vfx.mjs";
import { register as registerWorkflow, makeRegisterAsset } from "./workflow/workflow.mjs";
import { register as registerKnowledge, instructionsDigest } from "./knowledge/knowledge.mjs";

const server = new McpServer(
  { name: "adobe-mcp", version: "1.2.0" },
  { instructions: instructionsDigest() }
);

const ctx = {
  text: (obj) => ({
    content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }],
  }),
  errText: (e) => ({
    content: [{ type: "text", text: `ERROR: ${e.message || e}` }],
    isError: true,
  }),
  registerAsset: makeRegisterAsset(),
};

registerAE(server, ctx);
registerPS(server, ctx);
registerAI(server, ctx);
registerPPRO(server, ctx);
registerCH(server, ctx);
registerBlender(server, ctx);
registerSubstance(server, ctx);
registerTexLib(server, ctx);
registerVFX(server, ctx);
registerWorkflow(server, ctx);
registerKnowledge(server, ctx);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("adobe-mcp ready (ae, ps, ai, ppro, ch, blender, substance, texture libraries + workflow + vfx + knowledge)");
