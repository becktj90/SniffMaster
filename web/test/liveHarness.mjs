// Local preview: fake Redis seeded from a history dump (newest-first JSON array),
// then the real dev server (server.js). Usage: node test/liveHarness.mjs <hist.json> [port]
import { readFileSync } from "node:fs";
import { startFakeUpstash } from "./fakeUpstash.mjs";
import { compactClimatePoint, shouldSampleCoarse } from "../lib/store.js";
const [file, port = "5077"] = process.argv.slice(2);
const hist = JSON.parse(readFileSync(file, "utf8"));
const up = await startFakeUpstash();
Object.assign(process.env, { UPSTASH_REDIS_REST_URL: up.url, UPSTASH_REDIS_REST_TOKEN: "t", SNIFFMASTER_API_KEY: "dev", PORT: port });
up.kv.set("sniffmaster:history", hist.map((h) => JSON.stringify(h)));
up.kv.set("sniffmaster:latest", JSON.stringify(hist[0]));
const fine = hist.map(compactClimatePoint).filter(Boolean);
const coarse = [];
for (const p of [...fine].reverse()) if (shouldSampleCoarse(coarse[0]?.t, p.t)) coarse.unshift(p);
up.kv.set("sniffmaster:home_fine", fine.map((p) => JSON.stringify(p)));
up.kv.set("sniffmaster:home_coarse", coarse.map((p) => JSON.stringify(p)));
await import("../server.js");
