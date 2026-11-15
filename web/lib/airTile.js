/**
 * GET /api/air-tile?z=&x=&y= — a local Google air-quality heatmap tile.
 * GET /api/air-tile?probe=1 — whether the overlay can be shown.
 *
 * The Maps key never leaves the server. Tiles are only fetched near the
 * sensor, cached for 6 hours, and stopped by a monthly cap.
 */

import { getLatest, getJsonCache, setJsonCache, incrCounter } from "./store.js";
import { monthKey } from "./pollen.js";
import { tileNearHome } from "./googleAir.js";

const TILE_TTL_SEC = 6 * 3600;
const TILE_CAP = Number(process.env.AIR_TILE_MONTHLY_CAP);
const MONTHLY_CAP = Number.isFinite(TILE_CAP) && TILE_CAP >= 0 ? Math.floor(TILE_CAP) : 1800;

const TRANSPARENT = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function png(res, buf) {
  res.statusCode = 200;
  res.setHeader("Content-Type", "image/png");
  res.setHeader("Cache-Control", "public, max-age=600");
  res.end(buf);
}

export async function airTile(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });
  const key = (process.env.GOOGLE_POLLEN_API_KEY || "").trim();

  if (req.query?.probe) {
    let located = false;
    try {
      const latest = await getLatest();
      located = Number.isFinite(Number(latest?.lat)) && Number.isFinite(Number(latest?.lon));
    } catch { /* no location yet */ }
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ ok: Boolean(key && located) });
  }

  const z = Number(req.query?.z);
  const x = Number(req.query?.x);
  const y = Number(req.query?.y);
  if (!key || !Number.isInteger(z) || !Number.isInteger(x) || !Number.isInteger(y)) {
    return png(res, TRANSPARENT);
  }

  let lat = NaN;
  let lon = NaN;
  try {
    const latest = await getLatest();
    lat = Number(latest?.lat);
    lon = Number(latest?.lon);
  } catch { /* fall through */ }
  if (!tileNearHome(z, x, y, lat, lon)) return png(res, TRANSPARENT);

  const cacheKey = `airtile:${z}:${x}:${y}`;
  const denyKey = `airtile:deny:${monthKey()}`;
  try {
    const denied = await getJsonCache(denyKey);
    if (denied) return png(res, TRANSPARENT);
    const hit = await getJsonCache(cacheKey);
    if (hit?.fail) return png(res, TRANSPARENT);
    if (hit?.b64) {
      res.statusCode = 200;
      res.setHeader("Content-Type", hit.mime || "image/png");
      res.setHeader("Cache-Control", "public, max-age=3600");
      return res.end(Buffer.from(hit.b64, "base64"));
    }
  } catch { /* fetch fresh */ }

  let used;
  try {
    used = await incrCounter(`air_tiles:${monthKey()}`, 40 * 24 * 3600);
  } catch {
    return png(res, TRANSPARENT);
  }
  if (used > MONTHLY_CAP) return png(res, TRANSPARENT);

  const url = "https://airquality.googleapis.com/v1/mapTypes/UAQI_RED_GREEN/heatmapTiles/" +
    `${z}/${x}/${y}?key=${encodeURIComponent(key)}`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 7000);
  try {
    const upstream = await fetch(url, { signal: ctl.signal });
    if (!upstream.ok) {
      if (upstream.status === 401 || upstream.status === 403) {
        await setJsonCache(denyKey, { status: upstream.status }, 30 * 60).catch(() => {});
      } else {
        await setJsonCache(cacheKey, { fail: true }, 30 * 60).catch(() => {});
      }
      return png(res, TRANSPARENT);
    }
    const mime = upstream.headers.get("content-type") || "image/png";
    const buf = Buffer.from(await upstream.arrayBuffer());
    if (buf.length < 32 || buf.length > 400000) return png(res, TRANSPARENT);
    await setJsonCache(cacheKey, { mime, b64: buf.toString("base64") }, TILE_TTL_SEC).catch(() => {});
    res.statusCode = 200;
    res.setHeader("Content-Type", mime);
    res.setHeader("Cache-Control", "public, max-age=3600");
    return res.end(buf);
  } catch {
    return png(res, TRANSPARENT);
  } finally {
    clearTimeout(timer);
  }
}
