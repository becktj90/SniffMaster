// Share card (Open Graph): when sniff.beckify.com is shared, the link card
// must show the big-kitten image and the SniffMaster name. Static assertions
// on index.html + the image file — no network or renderer in node.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const pub = path.join(root, "../public");
const html = readFileSync(path.join(pub, "index.html"), "utf8");

test("Open Graph tags are present and point at the share image", () => {
  for (const tag of [
    '<meta property="og:title" content="SniffMaster">',
    '<meta property="og:description" content="Your home\'s air, smells, allergens and pollen — beautifully measured.">',
    '<meta property="og:image" content="https://sniff.beckify.com/og-image.png">',
    '<meta property="og:image:width" content="1200">',
    '<meta property="og:image:height" content="630">',
    '<meta property="og:type" content="website">',
    '<meta property="og:url" content="https://sniff.beckify.com/">',
    '<meta name="twitter:card" content="summary_large_image">',
    '<meta name="twitter:title" content="SniffMaster">',
    '<meta name="twitter:description" content="Your home\'s air, smells, allergens and pollen — beautifully measured.">',
    '<meta name="twitter:image" content="https://sniff.beckify.com/og-image.png">',
  ]) {
    assert.ok(html.includes(tag), "missing tag: " + tag);
  }
});

test("og-image.png exists at the 1200x630 share size", () => {
  const file = path.join(pub, "og-image.png");
  assert.ok(existsSync(file), "og-image.png missing from web/public");
  const buf = readFileSync(file);
  // PNG signature + IHDR: width at bytes 16-19, height at 20-23, big-endian.
  assert.equal(buf.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.equal(buf.readUInt32BE(16), 1200);
  assert.equal(buf.readUInt32BE(20), 630);
});
