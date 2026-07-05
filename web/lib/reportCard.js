/**
 * reportCard.js — renders the daily/alert summary as a small "report card"
 * image, so the morning text and push notification carry a visual instead
 * of being pure ASCII.
 *
 * The card is authored once as an SVG string (buildReportCardSvg) — cheap,
 * no headless-browser/canvas dependency, and every text/web consumer (ntfy
 * Attach on a browser/desktop client, an <img> tag, a link opened directly)
 * renders SVG natively. MMS is the one consumer that needs a raster image
 * (carriers don't accept SVG attachments), so renderReportCardPng rasterizes
 * that same SVG via @resvg/resvg-js — a WASM/native rasterizer with no
 * headless-browser overhead, safe to run inside a Vercel serverless function.
 */

import { Resvg } from "@resvg/resvg-js";

const WIDTH = 600;
const HEIGHT = 338;

function esc(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function fmt(n, digits = 0) {
  return Number.isFinite(n) ? n.toFixed(digits) : "—";
}

const cToF = (c) => (c * 9) / 5 + 32;

// One stat row: label, value, and a 0-100 fill fraction for the mini bar
// (how "loaded" that metric is toward its alert threshold — purely visual,
// not a precise gauge).
function statRow(y, label, value, fillPct, color) {
  const barX = 260;
  const barW = 300;
  const pct = Math.max(0, Math.min(100, Number.isFinite(fillPct) ? fillPct : 0));
  return `
    <text x="40" y="${y}" font-size="16" fill="#9fb3c8" font-family="Segoe UI, Arial, sans-serif">${esc(label)}</text>
    <text x="240" y="${y}" font-size="16" fill="#eef4fb" font-family="Segoe UI, Arial, sans-serif" text-anchor="end">${esc(value)}</text>
    <rect x="${barX}" y="${y - 14}" width="${barW}" height="10" rx="5" fill="#22303f"/>
    <rect x="${barX}" y="${y - 14}" width="${(barW * pct) / 100}" height="10" rx="5" fill="${color}"/>`;
}

/**
 * @param {object} summary — a stored daily-summary object (see api/daily-summary.js buildSummary())
 * @param {{dateLabel?:string, siteLabel?:string}} [opts]
 * @returns {string} SVG markup
 */
export function buildReportCardSvg(summary, opts = {}) {
  const s = summary && typeof summary === "object" ? summary : {};
  const ok = Boolean(s.controlsStabilizing);
  const statusColor = ok ? "#3ddc84" : "#ff5d5d";
  const statusLabel = ok ? "ALL CLEAR" : "NEEDS ATTENTION";
  const dateLabel = opts.dateLabel || new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
  }).format(new Date(s.generatedAt || Date.now()));
  const siteLabel = opts.siteLabel || (s.environmentType === "office" ? "Office" : "Work Area");

  const rows = [];
  let y = 118;
  if (s.temp) {
    const tempF = cToF(s.temp.avg);
    rows.push(statRow(y, "Temperature", `${fmt(tempF, 1)}°F`, ((tempF - 60) / (100 - 60)) * 100, "#f5a623"));
    y += 40;
  }
  if (s.humidity) {
    rows.push(statRow(y, "Humidity", `${fmt(s.humidity.avg)}%`, s.humidity.avg, "#3ba7ff"));
    y += 40;
  }
  if (s.co2) {
    rows.push(statRow(y, "CO2", `${fmt(s.co2.avg)} ppm`, (s.co2.avg / 2000) * 100, "#c084fc"));
    y += 40;
  }
  if (s.iaq) {
    rows.push(statRow(y, "Air quality (IAQ)", fmt(s.iaq.avg), (s.iaq.avg / 300) * 100, "#3ddc84"));
    y += 40;
  }

  const footerBits = [];
  if (s.forecast?.highF != null && s.forecast?.lowF != null) {
    footerBits.push(`${s.forecast.site || "Site"}: ${Math.round(s.forecast.highF)}°/${Math.round(s.forecast.lowF)}°F, ${esc(s.forecast.condition || "")}`);
  }
  if (s.forecast?.thunder) footerBits.push("⚡ Thunderstorm risk");
  const footer = footerBits.join("  ·  ");
  const launchLine = s.launchLine ? esc(s.launchLine) : "";

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <rect width="${WIDTH}" height="${HEIGHT}" rx="18" fill="#0b1420"/>
  <text x="40" y="46" font-size="22" font-weight="700" fill="#eef4fb" font-family="Segoe UI, Arial, sans-serif">SniffMaster</text>
  <text x="40" y="70" font-size="14" fill="#7c93ab" font-family="Segoe UI, Arial, sans-serif">${esc(siteLabel)} report · ${esc(dateLabel)}</text>
  <rect x="${WIDTH - 220}" y="28" width="180" height="34" rx="17" fill="${statusColor}22" stroke="${statusColor}" stroke-width="1.5"/>
  <text x="${WIDTH - 130}" y="50" font-size="14" font-weight="700" fill="${statusColor}" font-family="Segoe UI, Arial, sans-serif" text-anchor="middle">${esc(statusLabel)}</text>
  <line x1="40" y1="86" x2="${WIDTH - 40}" y2="86" stroke="#22303f" stroke-width="1"/>
  ${rows.join("")}
  ${footer ? `<text x="40" y="${HEIGHT - 44}" font-size="13" fill="#7c93ab" font-family="Segoe UI, Arial, sans-serif">${footer}</text>` : ""}
  ${launchLine ? `<text x="40" y="${HEIGHT - 24}" font-size="13" fill="#7c93ab" font-family="Segoe UI, Arial, sans-serif">${launchLine}</text>` : ""}
</svg>`;
}

/**
 * Rasterize buildReportCardSvg's output to PNG — for MMS, where carriers
 * expect a raster image rather than SVG.
 * @param {object} summary
 * @param {object} [opts] — see buildReportCardSvg
 * @returns {Buffer} PNG bytes
 */
export function renderReportCardPng(summary, opts = {}) {
  const svg = buildReportCardSvg(summary, opts);
  const resvg = new Resvg(svg, { background: "#0b1420" });
  return resvg.render().asPng();
}
