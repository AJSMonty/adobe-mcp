# adobe-mcp — Adobe Creative Cloud MCP server (macOS)

Drives After Effects, Photoshop, Illustrator, Premiere Pro (and Character Animator puppet authoring) from Claude. See ROADMAP.md for the full tool matrix and what is next.
Bridge: MCP client → this server → AppleScript `DoScript` → AE → temp result file → back.

## Tools

| Tool | Purpose |
|---|---|
| `run_extendscript` | Run arbitrary JSX; `return <value>` comes back as JSON. Auto undo-grouped. |
| `get_project_state` | Project item tree, or one comp's layers in detail (`comp_name`). |
| `save_frame` | Render a comp frame to PNG, returned inline so Claude can *see* its work. |
| `list_ae_scripts` | List `.jsx`/`.jsxbin` tools in `scripts/` with descriptions from header comments. |
| `run_ae_script` | Execute a library script, like File → Scripts → Run Script File. |

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

## Install (once)

1. Clone somewhere permanent:
   ```bash
   git clone https://github.com/AJSMonty/adobe-mcp.git ~/tools/adobe-mcp
   ```
2. **Node 18+** required: `node -v` (else `brew install node`).
3. In the folder: `npm install`
4. **In After Effects**: Preferences → Scripting & Expressions → enable **"Allow Scripts to Write Files and Access Network"**. Without this, results can't come back.
5. First tool call will trigger a macOS **Automation** permission prompt (your terminal/Claude controlling After Effects) — click Allow. If you missed it: System Settings → Privacy & Security → Automation.

## Hook up to your MCP client

This is a standard **stdio MCP server** — any MCP-capable client can drive it (Claude Code,
Claude Desktop, Cursor, Windsurf, VS Code Copilot agent mode, Zed, Cline, Goose, ...).
Everything below is the same one-liner expressed in each client's config format:
run `node /ABSOLUTE/PATH/tools/adobe-mcp/server.mjs` over stdio. Use absolute paths —
most clients do not expand `~`.

### Claude Code

```bash
claude mcp add --scope user adobe -- node ~/tools/adobe-mcp/server.mjs
```

`--scope user` = available in all projects; use `--scope project` from inside a repo to share via `.mcp.json` with your team. Verify: `claude mcp list`.

### Claude Desktop

Settings → Developer → Edit Config, add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "adobe": {
      "command": "node",
      "args": ["/Users/YOUR_USER/tools/adobe-mcp/server.mjs"]
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
      "command": "node",
      "args": ["/Users/YOUR_USER/tools/adobe-mcp/server.mjs"]
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
      "command": "node",
      "args": ["/Users/YOUR_USER/tools/adobe-mcp/server.mjs"]
    }
  }
}
```

### Windsurf

`~/.codeium/windsurf/mcp_config.json` — same `mcpServers` shape as Claude Desktop/Cursor above.

### Anything else

If the client supports MCP over stdio, point it at `node .../server.mjs` and you are done.

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
