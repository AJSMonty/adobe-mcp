# adobe-mcp Python harness (Blender + Substance 3D Painter).
# Runs the user's code as a module body in a fresh namespace, captures stdout, and writes
# {ok, result, stdout} or {ok: false, error, line, traceback} as JSON to __RESULT_PATH__.
# Set `result = <value>` in user code to return data (non-JSON values are str()-ed).
def __adobe_mcp_run():
    import base64, contextlib, io, json, traceback

    code = base64.b64decode("__USER_CODE_B64__").decode("utf-8")
    ns = {"__name__": "__adobe_mcp__"}
    out = io.StringIO()
    try:
        with contextlib.redirect_stdout(out):
            exec(compile(code, "<adobe-mcp>", "exec"), ns)
        res = {"ok": True, "result": ns.get("result"), "stdout": out.getvalue()[-8000:]}
    except BaseException as e:  # SystemExit from user code must still report back
        line = None
        if isinstance(e, SyntaxError) and e.filename == "<adobe-mcp>":
            line = e.lineno
        for fr in traceback.extract_tb(e.__traceback__):
            if fr.filename == "<adobe-mcp>":
                line = fr.lineno
        res = {
            "ok": False,
            "error": "%s: %s" % (type(e).__name__, e),
            "line": line,
            "traceback": traceback.format_exc()[-4000:],
            "stdout": out.getvalue()[-4000:],
        }
    with open(__RESULT_PATH__, "w", encoding="utf-8") as f:
        f.write(json.dumps(res, default=str))
    return res


__adobe_mcp_run()
