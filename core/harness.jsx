// ae-mcp ExtendScript harness.
// Wraps user code in a try/catch + undo group, serializes the return value
// to JSON (ExtendScript is ES3 — no native JSON), writes it to __RESULT_PATH__.
(function () {
  function __q(s) {
    s = String(s);
    var out = '"';
    for (var i = 0; i < s.length; i++) {
      var c = s.charAt(i);
      if (c === '"') out += '\\"';
      else if (c === '\\') out += '\\\\';
      else if (c === '\n') out += '\\n';
      else if (c === '\r') out += '\\r';
      else if (c === '\t') out += '\\t';
      else if (s.charCodeAt(i) < 32) out += ' ';
      else out += c;
    }
    return out + '"';
  }
  function __json(v, d) {
    d = d || 0;
    if (d > 8) return '"[max depth reached]"';
    if (v === null || v === undefined) return 'null';
    var t = typeof v;
    if (t === 'number') return (v === v && v !== Infinity && v !== -Infinity) ? String(v) : 'null';
    if (t === 'boolean') return String(v);
    if (t === 'string') return __q(v);
    if (t === 'function') return '"[function]"';
    if (v instanceof Array) {
      var a = [];
      for (var i = 0; i < v.length; i++) a.push(__json(v[i], d + 1));
      return '[' + a.join(',') + ']';
    }
    if (t === 'object') {
      var p = [];
      for (var k in v) {
        try {
          p.push(__q(k) + ':' + __json(v[k], d + 1));
        } catch (e) {
          p.push(__q(k) + ':"[unserializable]"');
        }
      }
      return '{' + p.join(',') + '}';
    }
    return __q(String(v));
  }
  var __payload;
  try {
    __UNDO_OPEN__
    var __result;
    try {
      __result = (function () {
__USER_CODE__
      })();
    } finally {
      __UNDO_CLOSE__
    }
    __payload = '{"ok":true,"result":' + __json(__result) + '}';
  } catch (__e) {
    __payload = '{"ok":false,"error":' + __q(__e.toString()) + ',"line":' + (Number(__e.line) || 0) + '}';
  }
  var __f = new File(__RESULT_PATH__);
  __f.encoding = 'UTF-8';
  __f.open('w');
  __f.write(__payload);
  __f.close();
})();
