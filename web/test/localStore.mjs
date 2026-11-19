// Local libSQL test database — the Turso replacement for fakeUpstash.mjs.
//
// Each test file gets a fresh temp file DB. Set the env vars BEFORE importing
// the store (the store module caches one client per process, and node --test
// runs each file in its own process, so the singleton is per-file).
//
// Usage (top of a test file, before any store import):
//   import { startLocalStore, sql, wipeSourceData } from "./localStore.mjs";
//   const local = startLocalStore();
//   test.after(() => local.close());

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";

export function startLocalStore() {
  const dir = mkdtempSync(join(tmpdir(), "sniffmaster-test-"));
  const file = join(dir, "test.db");
  process.env.TURSO_DATABASE_URL = `file:${file}`;
  delete process.env.TURSO_AUTH_TOKEN;
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  return {
    file,
    close() {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // temp dir cleanup is best-effort
      }
    },
  };
}

/** Run one SQL statement against the test DB with a throwaway client. */
export async function sql(file, text, args = []) {
  const client = createClient({ url: `file:${file}` });
  try {
    return await client.execute({ sql: text, args });
  } finally {
    client.close();
  }
}

/**
 * Delete the source rows a home-payload rebuild reads (latest snapshot plus
 * the 24h / fine / coarse rings), leaving the payload cache in place. Used
 * to prove a rebuild fails open from cache instead of returning stale data
 * as fresh.
 */
export async function wipeSourceData(file) {
  const client = createClient({ url: `file:${file}` });
  try {
    await client.batch([
      { sql: "DELETE FROM kv WHERE key = ?", args: ["sniffmaster:latest"] },
      {
        sql: "DELETE FROM rings WHERE ring IN (?, ?, ?)",
        args: ["sniffmaster:history", "sniffmaster:home_fine", "sniffmaster:home_coarse"],
      },
    ]);
  } finally {
    client.close();
  }
}
