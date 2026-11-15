// Service worker fetch strategy: app assets must be network-first so a fresh
// deploy shows up on the next load. Cache-first with background refresh
// served stale files on the first load after every deploy (Nov 15: Trevor
// repeatedly did not see new deploys, and a tab could run new HTML against
// old CSS). These are static assertions on the worker source — there is no
// ServiceWorker runtime in node.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const sw = readFileSync(path.join(root, "../public/sw.js"), "utf8");

test("app assets are network-first, never cache-first", () => {
  // No cache-first read of a static asset: the old handler started with
  // caches.match(...).then((cached) => ...) and returned the cached copy.
  assert.ok(!/caches\.match\(e\.request\)\.then\(\(cached\)/.test(sw));
  // The asset handler fetches from the network first and only falls back
  // to the cache when the network fails (offline).
  assert.ok(/fetch\(e\.request\)[\s\S]*?\.catch\(\(\) => caches\.match\(e\.request\)\)/.test(sw));
});

test("cache name is bumped so old caches are purged on activate", () => {
  assert.ok(/CACHE_NAME = "sniffmaster-v57"/.test(sw));
  assert.ok(!/sniffmaster-v56/.test(sw));
  assert.ok(/keys\.filter\(\(k\) => k !== CACHE_NAME\)/.test(sw));
});

test("API calls stay network-only and navigations stay network-first", () => {
  assert.ok(/startsWith\("\/api\/"\)/.test(sw));
  assert.ok(/mode === "navigate"/.test(sw));
  // The shell still gets cached on install for the offline fallback.
  assert.ok(/caches\.open\(CACHE_NAME\)\.then\(\(c\) => c\.addAll\(SHELL\)\)/.test(sw));
});
