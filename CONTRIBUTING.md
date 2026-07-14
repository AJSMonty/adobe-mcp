# Contributing to adobe-mcp

Thanks for wanting to make this better. The short version: fork, branch, PR — every
change lands through a pull request approved by the maintainer (enforced by branch
protection + CODEOWNERS on `main` and `dev`).

## Workflow

1. Fork the repo and create a feature branch from `dev`.
2. Make your change. Keep the dependency footprint where it is (`@modelcontextprotocol/sdk` + `zod`); this server stays small on purpose.
3. Sanity check: `node --check` every `.mjs` you touched, and boot the server once (`node server.mjs` should print `adobe-mcp ready ...`). CI runs the same checks.
4. Open a PR against `dev`. Describe what you tested against which app versions (e.g. "AE 2026 / PS 26.x on macOS 15").

`dev` → `main` promotion is done by the maintainer.

## What contributions are most valuable

- **Lessons** (`knowledge/lessons.jsonl`): real gotchas you hit, with `match` keywords
  taken from the literal error text so they auto-surface for the next person. One JSON
  line per lesson; keep the `lesson` field to 1–3 sentences with the fix.
- **Adapter improvements**: new tools, better state introspection, Windows support
  (the bridge is currently macOS `osascript` — a `cscript`/COM path would be welcome).
- **Library scripts** (`scripts/{ae,ps,ai,ppro}/`): reusable in-app skills with a
  header comment describing what they do (that comment becomes the `list_scripts` description).

## Script provenance (important)

Only submit scripts you wrote or have a license to redistribute under MIT. No compiled
`.jsxbin` files, no marketplace/commercial scripts, no embedded API keys or telemetry
tokens. PRs adding scripts must state provenance in the description.

## Style

- Node 18+ ESM, no build step.
- ExtendScript payloads are ES3 — no modern syntax inside JSX strings/files.
- Error messages should tell the user what to DO (see the hint patterns in `core/bridge.mjs`).
