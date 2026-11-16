import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  nextLickDelayMs,
  scheduleLicks,
  LICK_MIN_MS,
  LICK_MAX_MS,
  LICK_MS,
} from "../public/brand-cat.js";

const root = dirname(fileURLToPath(import.meta.url));
const indexHtml = readFileSync(join(root, "..", "public", "index.html"), "utf8");
const styleCss = readFileSync(join(root, "..", "public", "style.css"), "utf8");

test("lick delays stay in the 15–30s window", () => {
  assert.equal(nextLickDelayMs(() => 0), LICK_MIN_MS);
  assert.equal(nextLickDelayMs(() => 1), LICK_MAX_MS);
  assert.equal(nextLickDelayMs(() => 0.5), (LICK_MIN_MS + LICK_MAX_MS) / 2);
  assert.equal(LICK_MS, 900);
  for (let i = 0; i < 200; i++) {
    const d = nextLickDelayMs();
    assert.ok(d >= LICK_MIN_MS && d <= LICK_MAX_MS, `delay ${d} out of range`);
  }
});

test("lick schedule toggles the class, re-arms, and stops cleanly", () => {
  const classes = new Set();
  const el = {
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
    },
  };
  const queue = [];
  const fakeTimeout = (fn) => {
    queue.push(fn);
    return queue.length;
  };
  const stop = scheduleLicks(el, { setTimeoutFn: fakeTimeout, random: () => 0 });
  assert.equal(queue.length, 1, "first lick armed");
  queue.shift()(); // fire the lick
  assert.ok(classes.has("licking"), "tongue out while licking");
  assert.equal(queue.length, 2, "remove + next lick armed");
  queue.shift()(); // fire the tongue retract
  assert.ok(!classes.has("licking"), "tongue back after the lick");
  stop();
  queue.shift()(); // the next armed lick must not fire after stop
  assert.ok(!classes.has("licking"), "no lick after stop");
});

test("header brand is an inline animated SVG kitten, not the static image", () => {
  assert.ok(indexHtml.includes('class="brand-mark brand-cat"'), "svg brand mark");
  assert.ok(indexHtml.includes('src="/brand-cat.js"'), "lick scheduler wired in");
  assert.ok(!indexHtml.includes("kitten-logo.webp"), "no static logo left in the header");
  for (const part of ["bc-head", "bc-eyes", "bc-pupils", "bc-tongue", "bc-ear-r", "bc-nose", "bc-paw"]) {
    assert.ok(indexHtml.includes(part), `svg has ${part}`);
  }
});

test("kitten keyframes and reduced-motion parking are in the stylesheet", () => {
  for (const name of [
    "bc-bob",
    "bc-breathe",
    "bc-blink",
    "bc-glance",
    "bc-ear-twitch",
    "bc-sniff",
    "bc-lick",
    "bc-paw-lift",
  ]) {
    assert.ok(styleCss.includes(`@keyframes ${name}`), `missing @keyframes ${name}`);
  }
  assert.ok(styleCss.includes(".brand-cat.licking .bc-tongue"), "lick is class-driven");
  assert.ok(styleCss.includes("prefers-reduced-motion"), "reduced-motion rule present");
});
