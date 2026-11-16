import test from "node:test";
import assert from "node:assert/strict";
import { catCountForPetIndex, catsBandHtml, catsInnerHtml } from "../public/cats.js";

test("cat count scales with the pet dander index", () => {
  assert.equal(catCountForPetIndex(null), 2);
  assert.equal(catCountForPetIndex(undefined), 2);
  assert.equal(catCountForPetIndex("nope"), 2);
  assert.equal(catCountForPetIndex(0), 2);
  assert.equal(catCountForPetIndex(25), 2);
  assert.equal(catCountForPetIndex(26), 3);
  assert.equal(catCountForPetIndex(50), 3);
  assert.equal(catCountForPetIndex(51), 4);
  assert.equal(catCountForPetIndex(75), 4);
  assert.equal(catCountForPetIndex(76), 5);
  assert.equal(catCountForPetIndex(100), 5);
});

test("band renders one roaming cat per cat, clamped to 2–5", () => {
  const countCats = (html) => (html.match(/class="roam-cat(?: |")/g) || []).length;
  assert.equal(countCats(catsBandHtml(2)), 2);
  assert.equal(countCats(catsBandHtml(4)), 4);
  assert.equal(countCats(catsBandHtml(9)), 5);
  assert.equal(countCats(catsBandHtml(0)), 2);
  assert.match(catsBandHtml(3), /id="cats-band"/);
  assert.match(catsBandHtml(3), /class="cats-band"/);
  assert.match(catsBandHtml(3), /aria-hidden="true"/);
  // No trace of the old Pets-page strip.
  assert.doesNotMatch(catsBandHtml(3), /cats-strip|cats-caption|on patrol/);
});

test("cats are cute inline SVGs, not plain silhouettes", () => {
  const html = catsBandHtml(2);
  assert.match(html, /<svg viewBox="0 0 72 48"/);
  assert.match(html, /class="cat-eyes"/); // blinking eyes
  assert.match(html, /class="cat-ear-r"/); // ear that twitches
  assert.match(html, /class="cat-tail"/); // swaying tail
  assert.match(html, /#f4a7b9/); // pink inner ears and nose
  assert.match(html, /#ffd166/); // amber eyes
});

test("cats roam in both directions, at their own pace and lane", () => {
  const html = catsBandHtml(4);
  assert.match(html, /roam-cat--rev/); // odd cats stroll the other way
  assert.match(html, /roam-cat--pause-[abc]/); // each cat pauses somewhere
  assert.match(html, /--dur:\d+s/);
  assert.match(html, /--delay:-\d+s/); // already mid-stroll on load
  assert.match(html, /--lane:\d+px/);
  assert.match(html, /--w:\d+px/); // cats vary in size
  assert.match(html, /--blink:[\d.]+s/); // blinks desynced
  assert.match(html, /--spot:\d+/); // resting spot for reduced motion
});

test("inner html rebuilds just the cats, for count syncs", () => {
  assert.equal((catsInnerHtml(3).match(/class="roam-cat(?: |")/g) || []).length, 3);
  assert.doesNotMatch(catsInnerHtml(3), /cats-band/);
});
