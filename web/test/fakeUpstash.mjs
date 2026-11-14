// Minimal in-memory Upstash REST emulator for local tests (GET/SET/LRANGE/LPUSH/LTRIM/INCR/EXPIRE).
import http from "node:http";
export function startFakeUpstash() {
  const kv = new Map();
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      let parsed = [];
      try { parsed = JSON.parse(body); } catch {}
      const run = (cmd) => {
        const [op, k, ...a] = cmd; const O = String(op).toUpperCase();
        let result = null;
        if (O === "GET") result = kv.get(k) ?? null;
        else if (O === "SET") { kv.set(k, a[0]); result = "OK"; }
        else if (O === "LPUSH") { const l = kv.get(k) || []; l.unshift(...a); kv.set(k, l); result = l.length; }
        else if (O === "LRANGE") { const l = kv.get(k) || []; result = l.slice(Number(a[0]), Number(a[1]) + 1); }
        else if (O === "LTRIM") { const l = kv.get(k) || []; kv.set(k, l.slice(Number(a[0]), Number(a[1]) + 1)); result = "OK"; }
        else if (O === "INCR") { const n = Number(kv.get(k) || 0) + 1; kv.set(k, String(n)); result = n; }
        else if (O === "EXPIRE") result = 1;
        return { result };
      };
      const out = Array.isArray(parsed[0]) ? parsed.map(run) : run(parsed);
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(out));
    });
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve({ kv, close: () => { srv.closeAllConnections?.(); srv.close(); }, url: `http://127.0.0.1:${srv.address().port}` })));
}
