# adobe-mcp — Adobe Creative Cloud MCP server (macOS)

Drives After Effects, Photoshop, Illustrator, Premiere Pro (and Character Animator puppet authoring) from Claude, plus Blender and Substance 3D Painter for 3D look-dev and cinematic animation. See ROADMAP.md for the full tool matrix and what is next.
Bridge: MCP client → this server → AppleScript `DoScript` → AE → temp result file → back.

## Tools

| Tool | Purpose |
|---|---|
| `run_extendscript` | Run arbitrary JSX; `return <value>` comes back as JSON. Auto undo-grouped. |
| `get_project_state` | Project item tree, or one comp's layers in detail (`comp_name`). |
| `save_frame` | Render a comp frame to PNG, returned inline so Claude can *see* its work. |
| `list_ae_scripts` | List `.jsx`/`.jsxbin` tools in `scripts/` with descriptions from header comments. |
| `run_ae_script` | Execute a library script, like File → Scripts → Run Script File. |

## 3D & cinematic VFX pipeline (Blender + Substance 3D Painter)

Two Python bridges extend the server beyond ExtendScript so one agent can take a shot from
blocking to final composite:

```
                  ┌──► Blender ──────────► Python (bpy): live add-on socket :9877, or headless `blender -b`
MCP client ───────┼──► Substance Painter ─► Python: remote scripting HTTP :60041 (/run.json)
                  └──► After Effects ────► ExtendScript via osascript (as above)
```

| Tool | Purpose |
|---|---|
| `blender_run_python` | Run bpy code (`result = ...` returns JSON). `mode`: `live` (running Blender), `background` (headless, optional `blend_file` / `save_as`), `auto`. |
| `blender_get_state` | Scene summary: frame range, fps, engine, motion blur, camera lens/DoF, passes, every object. |
| `blender_render_frame` | Render a low-sample preview frame through the scene camera, returned inline. |
| `blender_render_animation` | Render the frame range with the scene's output settings and register the output as an asset. |
| `substance_run_python` | Run Python in Substance 3D Painter (`substance_painter.*`). |
| `substance_get_state` | Texture sets, resolutions, stacks, channels, root layers. |
| `substance_bake_mesh_maps` | Start the async mesh-map bake (curvature/AO feed smart materials). |
| `substance_export_textures` | Export PBR maps with a preset (default *PBR Metallic Roughness*); registers each map. |
| `vfx_plan_creature_shot` | Turns a brief ("a photo-real dinosaur walking past the camera while turning its neck") into physically derived timing plus the ordered tool calls for every stage. |

Free CC0 texture & HDRI libraries ([Poly Haven](https://polyhaven.com), [ambientCG](https://ambientcg.com)):
everything both publish is public domain, so it's free for commercial work with no attribution.

| Tool | Purpose |
|---|---|
| `texture_search` | Search both libraries for PBR materials (`type=texture`) or HDRIs (`type=hdri`); returns ids, tags, thumbnails. |
| `texture_download` | Download one asset at 1k–8k into `<workspace>/textures` (cached), maps renamed `<id>_BaseColor/_Roughness/_Normal/_Height/_Metallic/_ARM/_AO`. |
| `blender_apply_texture` | Build a Principled material from a library asset or a local map folder (e.g. a Substance export) and assign it: correct colour spaces, OpenGL normals, true displacement, ARM unpacking, real-world `tile_m` scale, tri-planar projection for meshes without UVs. |
| `blender_set_hdri` | Light the scene with a library HDRI (strength, rotation) to match the plate. |

The downloaded folder also works as `texture_dir` for `Creature_Walk_Cinematic.py`. Set
`POLYHAVEN_API` / `AMBIENTCG_API` to point at a mirror if you need to.

Library scripts (run with `run_script`, parameters via `params`):

- `scripts/blender/Creature_Walk_Cinematic.py`: a heavy-biped walk timed from physics. Speed comes
  from the Froude number, stride from Alexander (1976), and feet stay planted with zero slide. The
  neck and tail lag 3 frames per joint, the head is gaze-stabilised and turns toward the lens, and
  the chest breathes. The camera is a handheld rig with operator lag and footfall impact shake. The
  render setup is Cycles with a 180° shutter, a shadow catcher, and beauty/shadow/mist PNG sequences
  plus a multilayer EXR. Tested headless against Blender 5.0.1 (`bpy`); it also handles the 4.x APIs.
- `scripts/substance/Creature_Skin_LookDev.py`: optional bake, then a matte "aged scales" base,
  a cavity-masked wetness layer, and glossy eye/mouth sets, all in one undo step. Optional export.
- `scripts/ae/Cinematic_3D_Composite.jsx`: imports the passes, multiplies the shadow, adds a
  precomped edge light wrap, depth haze from mist, an optional depth lens blur, CG softening, and
  grain on the CG only.

Setup:

- **Blender live mode**: Edit → Preferences → Add-ons → Install from Disk →
  `bridges/blender/adobe_mcp_bridge.py`, then enable it (listens on `127.0.0.1:9877`; override with
  `BLENDER_MCP_PORT`). **Background mode** needs no add-on; it finds `/Applications/Blender*.app`
  or `blender` on `PATH` (override with `BLENDER_PATH`).
- **Substance 3D Painter**: launch with remote scripting enabled:
  `open -a "Adobe Substance 3D Painter" --args --enable-remote-scripting` (port override:
  `SUBSTANCE_PAINTER_PORT`).
- Both bridges are local-only and unauthenticated: anything on the machine that can reach the
  port can run Python in the app. Disable the Blender add-on or quit Painter when you're done.

## Knowledge system (the server learns as it goes)

The server ships with a curated knowledge base (`knowledge/lessons.jsonl`) seeded from real
production sessions — matchName gotchas, API quirks, parameter-type traps, and techniques
(blueprint line extraction, seamless wind loops, QE transitions, Auto Reframe...).

Three mechanisms keep it useful and growing:

1. **Auto-surfaced gotchas** — every failed `*_run_extendscript` call is matched against the
   lesson keywords; hits are appended to the error message the client sees (e.g. hit
   `Illegal Parameter type` in Premiere and the fix for `autoReframeSequence`'s string preset
   arrives with the error). Failures are also logged to `$WORKSPACE/error-log.jsonl` as raw
   material for new lessons.
2. **`knowledge_search` / `knowledge_add` tools** — agents consult lessons before attempting
   unusual scripting, and record new gotchas when they solve one that wasn't auto-suggested.
   Runtime lessons persist to `$WORKSPACE/learned.jsonl` (survives repo updates, per-install).
3. **Server instructions + tool descriptions** — the highest-value rules (explicit document
   targeting, visual verification, render-timeout handling, ES3 limits) are baked into the MCP
   instructions and the per-tool descriptions, so a fresh install starts smart.

The `scripts/` per-app libraries are the executable side of the same idea — distilled,
reusable skills (`list_scripts` / `run_script`): blueprint line extraction (PS), seamless
wind loops and kinetic typography rigs (AE), one-call vertical Auto Reframe (Premiere).

## Install

### Option A — one-click for Claude Desktop & Cowork (no Node needed)

1. Have the Adobe apps you want to drive installed. In After Effects, enable Preferences → Scripting & Expressions → **"Allow Scripts to Write Files and Access Network"**.
2. Download the latest `adobe-mcp-x.y.z.mcpb` from [Releases](https://github.com/AJSMonty/adobe-mcp/releases) and **double-click it** (or drag it onto Claude Desktop → Settings → Extensions). Claude Desktop bundles its own Node runtime — nothing else to install.
3. Use it. The first tool call for each app triggers a one-time macOS **Automation** permission prompt — click Allow.

**Upgrading?** Remove the old version first (Settings → Extensions → Adobe Creative Cloud → Uninstall), then install the new `.mcpb` — in-place installs over an existing version can leave stale files behind while reporting the new version number.

### Option B — any MCP client via npm

Requires Node 18+ installed system-wide ([nodejs.org](https://nodejs.org) installer or `brew install node` — note GUI apps often cannot see nvm-managed installs). No clone, no `npm install`: every client config below just runs

```
npx -y @ajsmonty/adobe-mcp
```

### Option C — from source (contributors)

```bash
git clone https://github.com/AJSMonty/adobe-mcp.git ~/tools/adobe-mcp
cd ~/tools/adobe-mcp && npm install
# point your client at: node ~/tools/adobe-mcp/server.mjs
```

**Premiere Pro only:** the `ppro_*` tools need the bundled CEP panel installed once — copy `cep/mcp-bridge` to `~/Library/Application Support/Adobe/CEP/extensions/` and enable `PlayerDebugMode` (see Notes), then open Window → Extensions → MCP Bridge inside Premiere.

## Hook up to your MCP client

This is a standard **stdio MCP server** — any MCP-capable client can drive it (Claude Code,
Claude Desktop, Cursor, Windsurf, VS Code Copilot agent mode, Zed, Cline, Goose, ...).
Everything below is the same one-liner expressed in each client's config format:
run `npx -y @ajsmonty/adobe-mcp` over stdio (or `node .../server.mjs` for a source checkout).

### Claude Code

```bash
claude mcp add --scope user adobe -- npx -y @ajsmonty/adobe-mcp
```

`--scope user` = available in all projects; use `--scope project` from inside a repo to share via `.mcp.json` with your team. Verify: `claude mcp list`.

### Claude Desktop

Settings → Developer → Edit Config, add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "adobe": {
      "command": "npx",
      "args": ["-y", "@ajsmonty/adobe-mcp"]
    }
  }
}
```

Fully quit and reopen Claude Desktop.

### Cursor

Settings → MCP → Add server, or edit `~/.cursor/mcp.json` (global) / `.cursor/mcp.json` (per-project):

```json
{
  "mcpServers": {
    "adobe": {
      "command": "npx",
      "args": ["-y", "@ajsmonty/adobe-mcp"]
    }
  }
}
```

Enable it under Settings → MCP, then use Agent mode (composer) — tool calls appear with approval prompts.

### VS Code (Copilot agent mode)

`.vscode/mcp.json` in the workspace (or user `mcp.json` via the "MCP: Add Server" command):

```json
{
  "servers": {
    "adobe": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@ajsmonty/adobe-mcp"]
    }
  }
}
```

### Windsurf

`~/.codeium/windsurf/mcp_config.json` — same `mcpServers` shape as Claude Desktop/Cursor above.

### Anything else

If the client supports MCP over stdio, point it at `npx -y @ajsmonty/adobe-mcp` and you are done.

### Client caveats

- **macOS Automation permission is per host app.** The first tool call from each new client
  (Cursor, VS Code, a different terminal) triggers its own Automation prompt for controlling
  the Adobe apps — approve it once per host in System Settings → Privacy & Security → Automation.
- **Inline image previews** (`ae_save_frame`, `ps_save_preview`, `ai_save_preview`,
  `ppro_save_frame`) return MCP image content. Claude clients and Cursor render these inline;
  clients without image rendering still get the metadata text, and the model can fall back to
  exporting a file and reading it from disk.
- **Server instructions** (the working rules + knowledge-base pointers) are sent via the MCP
  `instructions` field; most clients pass them to the model, but if yours does not, the same
  rules are baked into the tool descriptions and `knowledge_search`.

## Script library ("skills")

Drop `.jsx` / `.jsxbin` files into `scripts/` — they're immediately available via `list_ae_scripts` / `run_ae_script`.

- **Action scripts** (operate on the current selection, no UI) run headlessly — set up selection first via `run_extendscript`.
- **ScriptUI panel scripts** open their palette in the AE window for a human to click.
- Plain `.jsx` panels with a separable core function can often be driven headlessly by evaluating the source with the UI kickoff stripped.

> ⚠️ `scripts/` may contain third-party/purchased tools. Keep this repo **private** unless you've cleared redistribution rights, or add `scripts/` to `.gitignore`.

## Notes

- AE app auto-detected from `/Applications` (newest "Adobe After Effects *"). Override with env var `AE_APP_NAME`, e.g. `"env": {"AE_APP_NAME": "Adobe After Effects 2025"}` in the Desktop config or `--env AE_APP_NAME=...` in `claude mcp add`.
- **AE must be open** with a project (the empty default project is fine).
- Timeouts usually mean AE is showing a modal dialog — dismiss it.
- `save_frame` needs AE 2022+.

## ExtendScript gotchas (learned the hard way)

- ExtendScript is **ES3**: no arrow functions, template literals, `let`/`const`, `JSON`, `Array.map`.
- Collections (`project.items`, `comp.layers`, property groups) are **1-indexed**.
- Address effect params by **matchName** (`"ADBE Glo2-0002"`), not display name — display names collide.
- A `.property()` miss throws a **native error whose own stringification throws** — wrap `e.toString()` in its own try/catch or your error handler dies too.
- Text layers auto-rename to their source text — rename them if you need stable lookups.
- Cameras: Point of Interest lives in the **Anchor Point** slot (`ADBE Anchor Point`).
- Spatial properties need **1-element** ease arrays in `setTemporalEaseAtKey`, regardless of dimensions.
- Parenting a child to a rotated layer bakes compensation into the child's transform — zero the child's rotation *after* parenting if it should inherit orientation.
- Grid effect: set **Size From** (`ADBE Grid-0002 = 3`) before animating the anchor, or your "scroll" resizes cells instead.

## Smoke test

With AE open, ask Claude: *"Use get_project_state to show me what's in my AE project, then create a 1920x1080 comp called 'Test' with a headline text layer and show me a frame."*

## Contributing & governance

PRs welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). All merges to `main` and `dev` require
maintainer approval (branch protection + CODEOWNERS). Lessons for the knowledge base are the
easiest high-value contribution. Read [SECURITY.md](SECURITY.md) before installing: this
server executes scripts in your Adobe apps by design.

## License

[MIT](LICENSE)
