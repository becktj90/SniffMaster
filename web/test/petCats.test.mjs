import test from "node:test";
import assert from "node:assert/strict";
import { catCountForPetIndex, catsStripHtml } from "../public/cats.js";

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

test("strip renders one cat element per cat, clamped to 2–5", () => {
  const countCats = (html) => (html.match(/class="cat(?: |")/g) || []).length;
  assert.equal(countCats(catsStripHtml(2)), 2);
  assert.equal(countCats(catsStripHtml(4)), 4);
  assert.equal(countCats(catsStripHtml(9)), 5);
  assert.equal(countCats(catsStripHtml(0)), 2);
  assert.match(catsStripHtml(3), /3 black cats on patrol/);
  assert.match(catsStripHtml(3), /more appear as pet dander rises/);
  assert.match(catsStripHtml(3), /aria-hidden="true"/);
});
