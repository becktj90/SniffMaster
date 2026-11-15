// Minimal in-memory Upstash REST emulator for local tests (GET/SET/LRANGE/LPUSH/LTRIM/INCR/EXPIRE).
import http from "node:http";
export function startFakeUpstash() {
  const kv = new Map();
  const expires = new Map();
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
        else if (O === "DEL") { result = kv.delete(k) ? 1 : 0; expires.delete(k); }
        else if (O === "SET") {
          const live = kv.has(k) && !(expires.has(k) && expires.get(k) < Date.now());
          if (a.some((x) => String(x).toUpperCase() === "NX") && live) return { result: null };
          const px = a.findIndex((x) => String(x).toUpperCase() === "PX");
          if (px >= 0) expires.set(k, Date.now() + Number(a[px + 1]));
          kv.set(k, a[0]);
          const ex = a.findIndex((x) => String(x).toUpperCase() === "EX");
          if (ex >= 0 && Number.isFinite(Number(a[ex + 1]))) expires.set(k, Date.now() + Number(a[ex + 1]) * 1000);
          result = "OK";
        }
        else if (O === "LPUSH") { const l = kv.get(k) || []; l.unshift(...a); kv.set(k, l); result = l.length; }
        else if (O === "LRANGE") { const l = kv.get(k) || []; result = l.slice(Number(a[0]), Number(a[1]) + 1); }
        else if (O === "LINDEX") { const l = kv.get(k) || []; const i = Number(a[0]); result = l[i] ?? null; }
        else if (O === "LTRIM") { const l = kv.get(k) || []; kv.set(k, l.slice(Number(a[0]), Number(a[1]) + 1)); result = "OK"; }
        else if (O === "INCR") { const n = Number(kv.get(k) || 0) + 1; kv.set(k, String(n)); result = n; }
        else if (O === "TTL") {
          if (!kv.has(k)) result = -2;
          else if (!expires.has(k)) result = -1;
          else result = Math.max(0, Math.ceil((expires.get(k) - Date.now()) / 1000));
        }
        else if (O === "EXPIRE") { expires.set(k, Date.now() + Number(a[0]) * 1000); result = 1; }
        return { result };
      };
      const out = Array.isArray(parsed[0]) ? parsed.map(run) : run(parsed);
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(out));
    });
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve({ kv, expires, close: () => { srv.closeAllConnections?.(); srv.close(); }, url: `http://127.0.0.1:${srv.address().port}` })));
}
