// Workspace resolution — shared by the bridge and the knowledge system.
//
// Hardened against host quirks: some MCP hosts pass manifest placeholders through
// unexpanded (e.g. Claude Desktop delivered ADOBE_MCP_WORKSPACE='${HOME}/AdobeMCP'
// literally, with cwd=/ — which crashed mkdir at module load). Rules:
//   - expand a leading ${HOME} or ~
//   - reject any value still containing ${...} or that is not absolute
//   - if the directory cannot be created, fall back to ~/AdobeMCP rather than dying
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function resolveWorkspace() {
  const fallback = path.join(os.homedir(), "AdobeMCP");
  let w = process.env.ADOBE_MCP_WORKSPACE;
  if (w && w.trim()) {
    w = w.trim().replace(/^\$\{HOME\}/, os.homedir()).replace(/^~(?=\/|$)/, os.homedir());
    if (!w.includes("${") && path.isAbsolute(w)) {
      try {
        fs.mkdirSync(w, { recursive: true });
        return w;
      } catch {
        console.error(`adobe-mcp: cannot create workspace "${w}", falling back to ${fallback}`);
      }
    } else {
      console.error(
        `adobe-mcp: ignoring invalid ADOBE_MCP_WORKSPACE "${process.env.ADOBE_MCP_WORKSPACE}" (unexpanded placeholder or relative path), using ${fallback}`
      );
    }
  }
  fs.mkdirSync(fallback, { recursive: true });
  return fallback;
}

export const WORKSPACE = resolveWorkspace();
