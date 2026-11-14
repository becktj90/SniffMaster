// Local dev harness: fake Redis + seeded readings + the real server on :5057.
import { startFakeUpstash } from "./fakeUpstash.mjs";
const up = await startFakeUpstash();
process.env.UPSTASH_REDIS_REST_URL = up.url; process.env.UPSTASH_REDIS_REST_TOKEN = "t";
process.env.SNIFFMASTER_API_KEY = "dev"; process.env.PORT = "5057";
delete process.env.GOOGLE_POLLEN_API_KEY;
const withPm = process.argv.includes("--pm");
const now = Date.now();
// newest-first list, as the store keeps it (lpush)
const list = [];
for (let i = 0; i < 432; i++) {
  const odors = Array(20).fill(2); odors[16] = i < 30 ? 55 : 10;
  list.push(JSON.stringify({ receivedAt: now - i * 600000, voc: 0.5 + Math.sin(i / 20) * 0.2, iaq: 55 + Math.sin(i / 15) * 20, co2: 700 + Math.sin(i / 10) * 250,
    tempF: 72 + Math.sin(i / 30) * 2, humidity: i < 140 ? 68 : 49, pressHpa: 1013, gasR: 180000, lat: 34.05, lon: -118.24, city: "Los Angeles", odors,
    ...(withPm ? { pm25: 6 + Math.sin(i / 12) * 4 + (i < 20 ? 14 : 0), pm10: 14 + Math.sin(i / 12) * 6 + (i < 20 ? 22 : 0), hcho: 18 } : {}) }));
}
up.kv.set("sniffmaster:history", list);
up.kv.set("sniffmaster:latest", list[0]);
const express = (await import("express")).default;
const extras = (await import("../api/extras.js")).default;
const app = express();
app.get("/api/home-stats", (req, res) => { req.query = { fn: "home-stats" }; extras(req, res); });
app.get("/api/settings", (req, res) => { req.query = { fn: "settings" }; extras(req, res); });
app.use((req, res, next) => { if (req.path.startsWith("/api/")) return res.status(204).end(); next(); });
app.use(express.static(new URL("../public", import.meta.url).pathname, { setHeaders: (r) => r.setHeader("Cache-Control", "no-store") }));
app.listen(5057, "127.0.0.1", () => console.log("harness on 5057"));
