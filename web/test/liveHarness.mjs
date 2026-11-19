// Local preview: local Turso DB seeded from a history dump (newest-first JSON array),
// then the real dev server (server.js). Usage: node test/liveHarness.mjs <hist.json> [port]
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { compactClimatePoint, shouldSampleCoarse, ensureStoreSchema } from "../lib/store.js";
const [file, port = "5077"] = process.argv.slice(2);
const hist = JSON.parse(readFileSync(file, "utf8"));
const dbFile = join(tmpdir(), "sniffmaster-live.db");
rmSync(dbFile, { force: true });
process.env.TURSO_DATABASE_URL = `file:${dbFile}`;
process.env.SNIFFMASTER_API_KEY = "dev";
process.env.PORT = port;
await ensureStoreSchema();
const client = createClient({ url: `file:${dbFile}` });
// Rings keep rows oldest-first (id order); the dump is newest-first, so reverse
// on insert. Direct SQL, not putSnapshot — putSnapshot would overwrite
// receivedAt with Date.now() and lose the historical timestamps.
const stmts = [{ sql: "INSERT INTO kv (key, value) VALUES ('sniffmaster:latest', ?)", args: [JSON.stringify(hist[0])] }];
for (const h of [...hist].reverse()) {
  stmts.push({ sql: "INSERT INTO rings (ring, ts, payload) VALUES ('sniffmaster:history', ?, ?)", args: [Number(h.receivedAt) || Date.now(), JSON.stringify(h)] });
}
const fine = hist.map(compactClimatePoint).filter(Boolean);
const coarse = [];
for (const p of [...fine].reverse()) if (shouldSampleCoarse(coarse[0]?.t, p.t)) coarse.unshift(p);
for (const p of [...fine].reverse()) {
  stmts.push({ sql: "INSERT INTO rings (ring, ts, payload) VALUES ('sniffmaster:home_fine', ?, ?)", args: [Number(p.t) || 0, JSON.stringify(p)] });
}
for (const p of [...coarse].reverse()) {
  stmts.push({ sql: "INSERT INTO rings (ring, ts, payload) VALUES ('sniffmaster:home_coarse', ?, ?)", args: [Number(p.t) || 0, JSON.stringify(p)] });
}
await client.batch(stmts);
client.close();
await import("../server.js");
