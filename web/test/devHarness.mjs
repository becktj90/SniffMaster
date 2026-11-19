// Local dev harness: local Turso DB + seeded readings + the real server on :5057.
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { compactClimatePoint, shouldSampleCoarse, ensureStoreSchema, getLatest, getStorageHealth } from "../lib/store.js";
const dbFile = join(tmpdir(), "sniffmaster-dev.db");
rmSync(dbFile, { force: true });
process.env.TURSO_DATABASE_URL = `file:${dbFile}`;
process.env.SNIFFMASTER_API_KEY = "dev"; process.env.PORT = "5057";
delete process.env.GOOGLE_POLLEN_API_KEY;
const withPm = process.argv.includes("--pm");
const now = Date.now();
// newest-first list, as the store keeps it (rings read back newest-first)
const list = [];
for (let i = 0; i < 432; i++) {
  const odors = Array(20).fill(2); odors[16] = i < 30 ? 55 : 10;
  list.push(JSON.stringify({ receivedAt: now - i * 600000, voc: 0.5 + Math.sin(i / 20) * 0.2, iaq: 55 + Math.sin(i / 15) * 20, co2: 700 + Math.sin(i / 10) * 250,
    tempF: 72 + Math.sin(i / 30) * 2, humidity: i < 140 ? 68 : 49, pressHpa: 1013, gasR: 180000, lat: 34.05, lon: -118.24, city: "Los Angeles", odors,
    // Calibration + device fields, mirroring a real snapshot, so the
    // Sensor Health page renders fully in the harness.
    iaqAcc: 2, calibration: "Learning room baseline", bsecRestored: true, runIn: 1, stab: 1, gasValid: true, gasPctValid: true, compGas: 6, dVoc: -0.01,
    bsecCfg: "bme680_iaq_33v_3s_4d", bsecBundle: "full", wifiRssi: -53, uptime: 21435, tempRawC: 22.5, humRaw: 49,
    ...(withPm ? { pm25: 6 + Math.sin(i / 12) * 4 + (i < 20 ? 14 : 0), pm10: 14 + Math.sin(i / 12) * 6 + (i < 20 ? 22 : 0), hcho: 18 } : {}) }));
}
await ensureStoreSchema();
const client = createClient({ url: `file:${dbFile}` });
// Direct SQL, not putSnapshot — putSnapshot would overwrite receivedAt with
// Date.now() and flatten the 3-day spread into one instant.
const stmts = [{ sql: "INSERT INTO kv (key, value) VALUES ('sniffmaster:latest', ?)", args: [list[0]] }];
for (const raw of [...list].reverse()) {
  const h = JSON.parse(raw);
  stmts.push({ sql: "INSERT INTO rings (ring, ts, payload) VALUES ('sniffmaster:history', ?, ?)", args: [Number(h.receivedAt) || now, raw] });
}
const fine = list.map((raw) => compactClimatePoint(JSON.parse(raw))).filter(Boolean);
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
const express = (await import("express")).default;
const extras = (await import("../api/extras.js")).default;
const app = express();
app.use(express.json());
app.get("/api/latest", async (_req, res) => {
  res.json(await getLatest());
});
app.get("/api/version", (_req, res) => res.json({ version: "1.1.0", commitSha: null, commitRef: null, environment: "local", label: "v1.1.0 (local)" }));
app.get("/api/health", async (_req, res) => res.json(await getStorageHealth()));
app.all("/api/home-stats", (req, res) => { req.query = { ...req.query, fn: "home-stats" }; extras(req, res); });
app.all("/api/ai-insight", (req, res) => { req.query = { ...req.query, fn: "ai-insight" }; extras(req, res); });
app.all("/api/guest", (req, res) => { req.query = { ...req.query, fn: "guest" }; extras(req, res); });
app.get("/guest", (_req, res) => res.sendFile(new URL("../public/guest.html", import.meta.url).pathname));
app.all("/api/oled", (req, res) => { req.query = { ...req.query, fn: "oled" }; extras(req, res); });
app.all("/api/settings", (req, res) => { req.query = { fn: "settings" }; extras(req, res); });
app.use((req, res, next) => { if (req.path.startsWith("/api/")) return res.status(204).end(); next(); });
app.use(express.static(new URL("../public", import.meta.url).pathname, { setHeaders: (r) => r.setHeader("Cache-Control", "no-store") }));
app.listen(5057, "127.0.0.1", () => console.log("harness on 5057"));
