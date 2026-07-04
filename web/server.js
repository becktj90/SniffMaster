/**
 * server.js — local/Replit dev server that adapts Vercel-style serverless
 * function handlers (api/*.js, exporting `default async function handler(req,res)`)
 * into Express routes, mirroring the rewrites in vercel.json.
 *
 * This is dev tooling only — production still deploys via Vercel using
 * vercel.json + the api/ directory unchanged.
 */

import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const updateHandler = (await import("./api/update.js")).default;
const latestHandler = (await import("./api/latest.js")).default;
const historyHandler = (await import("./api/history.js")).default;
const sniffHandler = (await import("./api/sniff.js")).default;
const sniffHistoryHandler = (await import("./api/sniff-history.js")).default;
const healthHandler = (await import("./api/health.js")).default;
const testSmsHandler = (await import("./api/test-sms.js")).default;
const dailySummaryHandler = (await import("./api/daily-summary.js")).default;
const extrasHandler = (await import("./api/extras.js")).default;

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

function wrap(handler) {
  return (req, res) => {
    Promise.resolve(handler(req, res)).catch((err) => {
      console.error("handler error:", err);
      if (!res.headersSent) {
        res.status(500).json({ error: "internal error" });
      }
    });
  };
}

app.all("/api/apod", (req, res, next) => {
  req.query = { ...req.query, fn: "apod" };
  next();
}, wrap(extrasHandler));
app.all("/api/command", (req, res, next) => {
  req.query = { ...req.query, fn: "command" };
  next();
}, wrap(extrasHandler));
app.all("/api/launches", (req, res, next) => {
  req.query = { ...req.query, fn: "launches" };
  next();
}, wrap(extrasHandler));
app.all("/api/occupancy-briefing", (req, res, next) => {
  req.query = { ...req.query, fn: "occupancy-briefing" };
  next();
}, wrap(extrasHandler));
app.all("/api/office-stats", (req, res, next) => {
  req.query = { ...req.query, fn: "office-stats" };
  next();
}, wrap(extrasHandler));
app.all("/api/sniff-stream", (req, res, next) => {
  req.query = { ...req.query, fn: "sniff-stream" };
  next();
}, wrap(extrasHandler));
app.all("/api/weather-briefing", (req, res, next) => {
  req.query = { ...req.query, fn: "weather-briefing" };
  next();
}, wrap(extrasHandler));
app.all("/api/settings", (req, res, next) => {
  req.query = { ...req.query, fn: "settings" };
  next();
}, wrap(extrasHandler));

app.all("/api/update", wrap(updateHandler));
app.all("/api/latest", wrap(latestHandler));
app.all("/api/history", wrap(historyHandler));
app.all("/api/sniff", wrap(sniffHandler));
app.all("/api/sniff-history", wrap(sniffHistoryHandler));
app.all("/api/health", wrap(healthHandler));
app.all("/api/test-sms", wrap(testSmsHandler));
app.all("/api/daily-summary", wrap(dailySummaryHandler));
app.all("/api/extras", wrap(extrasHandler));

app.use(
  express.static(path.join(__dirname, "public"), {
    setHeaders(res) {
      res.setHeader("Cache-Control", "no-store");
    },
  })
);

const PORT = process.env.PORT || 5000;
const HOST = "0.0.0.0";
app.listen(PORT, HOST, () => {
  console.log(`SniffMaster dev server listening on http://${HOST}:${PORT}`);
});
