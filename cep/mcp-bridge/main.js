// adobe-mcp Premiere bridge panel.
// Polls <workspace>/ppro-bridge for cmd_*.json files ({jsx: "/path/to/script.jsx"}),
// evalFiles them in Premiere's ExtendScript engine (the harnessed JSX writes its own
// result file), and maintains a heartbeat so the MCP server knows the panel is alive.
(function () {
  var nodeRequire = (typeof cep_node !== "undefined" && cep_node.require) ? cep_node.require : (typeof require !== "undefined" ? require : null);
  var statusEl = document.getElementById("status");
  var countEl = document.getElementById("count");
  var lastEl = document.getElementById("last");
  if (!nodeRequire) { statusEl.textContent = "Node disabled — check --enable-nodejs"; return; }

  var fs = nodeRequire("fs");
  var pathMod = nodeRequire("path");
  var os = nodeRequire("os");
  var BRIDGE = pathMod.join(os.homedir(), "AdobeMCP", "ppro-bridge");
  try { fs.mkdirSync(BRIDGE, { recursive: true }); } catch (e) {}

  var count = 0;
  statusEl.textContent = "listening: " + BRIDGE;
  statusEl.className = "ok";

  setInterval(function heartbeat() {
    try { fs.writeFileSync(pathMod.join(BRIDGE, "heartbeat"), String(Date.now())); } catch (e) {}
  }, 1000);

  setInterval(function poll() {
    var entries;
    try { entries = fs.readdirSync(BRIDGE); } catch (e) { return; }
    for (var i = 0; i < entries.length; i++) {
      var name = entries[i];
      if (name.indexOf("cmd_") !== 0 || !/\.json$/.test(name)) continue;
      var full = pathMod.join(BRIDGE, name);
      var cmd = null;
      try { cmd = JSON.parse(fs.readFileSync(full, "utf8")); } catch (e) { continue; } // may still be writing
      try { fs.unlinkSync(full); } catch (e) {}
      if (!cmd || !cmd.jsx) continue;
      count++;
      countEl.textContent = String(count);
      lastEl.textContent = "last: " + cmd.jsx.split("/").pop();
      var esc = cmd.jsx.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
      window.__adobe_cep__.evalScript("$.evalFile(new File('" + esc + "'))", function (r) {
        if (r === "EvalScript error.") {
          lastEl.textContent = "last: evalScript ERROR";
          lastEl.className = "err";
        }
      });
    }
  }, 250);
})();
