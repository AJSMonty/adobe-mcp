# Security

## Threat model — read this before installing

adobe-mcp executes **arbitrary ExtendScript inside your Adobe apps** on behalf of an AI
agent. That is the product, not a vulnerability: ExtendScript can read/write files, access
the network (if the app preference is enabled), and control the host applications. Treat
any MCP client you connect as having **code execution on your machine**, and only connect
clients/models you trust. Review what your agent is doing when it runs scripts — the tools
echo every script body in the conversation.

Additional notes:

- The server binds to **stdio only** — it opens no network ports and has no remote surface.
- The workspace (`~/AdobeMCP` by default) collects rendered assets, an error log
  (`error-log.jsonl`, includes failed script snippets) and learned lessons. Nothing is
  transmitted anywhere by this server.
- Library scripts under `scripts/` run with the same privileges; only add scripts you trust.

## Reporting a vulnerability

If you find something that breaks the model above (e.g. a way for a *non-connected* process
to drive the bridge, or command injection through tool parameters), please use GitHub's
**private vulnerability reporting** on this repo rather than a public issue.
