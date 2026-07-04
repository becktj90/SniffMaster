/**
 * GET /api/version
 *
 * Exposes build/version info for the deployed dashboard so the UI can show
 * which deployment is currently live. On Vercel this is populated at request
 * time from the platform's built-in system environment variables (available
 * automatically to serverless functions, no dashboard config needed):
 *   VERCEL_GIT_COMMIT_SHA  — full commit hash of the deployed build
 *   VERCEL_GIT_COMMIT_REF  — branch/tag name that was deployed
 *   VERCEL_ENV             — "production" | "preview" | "development"
 *
 * In local/dev (`node server.js`) none of those are set, so this falls back
 * to the `version` field in package.json.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function readPackageVersion() {
  try {
    const pkgPath = path.join(__dirname, "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    return pkg.version || "0.0.0";
  } catch (_) {
    return "0.0.0";
  }
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") {
    return res.status(405).json({ error: "GET only" });
  }

  const commitSha = (process.env.VERCEL_GIT_COMMIT_SHA || "").trim();
  const commitRef = (process.env.VERCEL_GIT_COMMIT_REF || "").trim();
  const vercelEnv = (process.env.VERCEL_ENV || "").trim();
  const packageVersion = readPackageVersion();

  const shortSha = commitSha ? commitSha.slice(0, 7) : "";
  const label = shortSha
    ? `v${packageVersion} (${shortSha}${commitRef ? `@${commitRef}` : ""})`
    : `v${packageVersion} (local)`;

  return res.status(200).json({
    version: packageVersion,
    commitSha: commitSha || null,
    commitRef: commitRef || null,
    environment: vercelEnv || (process.env.VERCEL ? "vercel" : "local"),
    label,
  });
}
