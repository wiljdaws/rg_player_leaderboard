import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  decorateAccessLists,
  filterAccessEntries,
  normalizeAccessUid,
  shortUid,
} from "../js/access-view.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("normalizeAccessUid trims pasted uids", () => {
  assert.equal(normalizeAccessUid("  abc  "), "abc");
  assert.equal(normalizeAccessUid(null), "");
});

test("shortUid keeps short ids and ellipsizes long ones", () => {
  assert.equal(shortUid("short"), "short");
  assert.equal(shortUid("YpbPvklM3pOWp2h7MJFZrAPYM4m2"), "YpbPvklM…PYM4m2");
});

test("filterAccessEntries matches name or uid", () => {
  const rows = [
    { uid: "aaa111", name: "Croxy" },
    { uid: "bbb222", name: "Pal" },
  ];
  assert.equal(filterAccessEntries(rows, "crox").length, 1);
  assert.equal(filterAccessEntries(rows, "BBB").length, 1);
  assert.equal(filterAccessEntries(rows, "").length, 2);
});

test("decorateAccessLists attaches published names and sorts by them", () => {
  const names = new Map([["uid-b", "Croxy"], ["uid-a", "Pal"]]);
  const { allowedRows, bannedRows } = decorateAccessLists({
    allowed: ["uid-b", "uid-a"],
    banned: ["uid-z"],
    names,
  });
  assert.equal(allowedRows[0].name, "Croxy");
  assert.equal(allowedRows[1].name, "Pal");
  assert.equal(bannedRows[0].uid, "uid-z");
  assert.equal(bannedRows[0].name, "");
});

test("index.html exposes the Access tab after Sync", async () => {
  const html = await readFile(join(root, "index.html"), "utf8");
  const publishAt = html.indexOf('id="publishTab"');
  const accessAt = html.indexOf('id="accessTab"');
  assert.ok(publishAt > 0 && accessAt > publishAt);
  assert.match(html, /id="accessView"/);
  assert.doesNotMatch(html, /id="whitelistForm"/);
});
