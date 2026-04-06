/**
 * GET /api/sniff-stream
 *
 * Lightweight SSE stream for the latest sulfur/VSC priority event.
 * The handler polls Redis for up to 25 seconds, then the browser reconnects.
 */

import { getLatestSniff } from "../lib/store.js";

const STREAM_WINDOW_MS = 25000;
const POLL_MS = 1500;
const HEARTBEAT_MS = 10000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sendEvent(res, eventName, payload) {
  res.write(`event: ${eventName}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method !== "GET") {
    return res.status(405).json({ error: "GET only" });
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write("retry: 2500\n\n");
  res.flushHeaders?.();
  res.socket?.setTimeout(0);

  let closed = false;
  req.on("close", () => {
    closed = true;
  });

  let lastSeq = Number(req.query.after || 0);
  let lastHeartbeat = 0;
  const startedAt = Date.now();

  try {
    const initial = await getLatestSniff();
    const initialSeq = Number(initial?.seq || 0);
    if (initial && initialSeq > lastSeq) {
      lastSeq = initialSeq;
      sendEvent(res, "sniff", initial);
    }

    while (!closed && Date.now() - startedAt < STREAM_WINDOW_MS) {
      await sleep(POLL_MS);
      if (closed) break;

      const latest = await getLatestSniff();
      const latestSeq = Number(latest?.seq || 0);
      if (latest && latestSeq > lastSeq) {
        lastSeq = latestSeq;
        sendEvent(res, "sniff", latest);
        lastHeartbeat = Date.now();
        continue;
      }

      if (Date.now() - lastHeartbeat >= HEARTBEAT_MS) {
        res.write(`: heartbeat ${Date.now()}\n\n`);
        lastHeartbeat = Date.now();
      }
    }
  } catch (err) {
    console.error("sniff-stream error:", err);
    sendEvent(res, "error", { error: "stream error" });
  }

  res.end();
}
