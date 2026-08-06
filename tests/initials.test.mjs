import { test } from "node:test";
import assert from "node:assert/strict";

import { initials } from "../js/render.js";

test("initials returns the first letter of a plain name", () => {
  assert.equal(initials("Bob"), "B");
  assert.equal(initials("alice"), "A");
});

test("initials skips a [tag] prefix", () => {
  assert.equal(initials("[XYZ] Bob"), "B");
  assert.equal(initials("[!] Sky"), "S");
});

test("initials skips (), {}, and | tag delimiters", () => {
  assert.equal(initials("(CLAN) Rex"), "R");
  assert.equal(initials("{elite} Kai"), "K");
  assert.equal(initials("|team| Zed"), "Z");
});

test("initials skips leading symbols when no tag is present", () => {
  assert.equal(initials("★ Sky"), "S");
  assert.equal(initials("!!!Mira"), "M");
});

test("initials falls back to a digit when the name starts with a number", () => {
  assert.equal(initials("42Trev"), "4");
});

test("initials returns ? when nothing usable is present", () => {
  assert.equal(initials(""), "?");
  assert.equal(initials("!!!"), "?");
  assert.equal(initials(null), "?");
});

test("initials keeps the original name if the tag block never closes", () => {
  assert.equal(initials("[unclosed Bob"), "U");
});
