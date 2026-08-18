import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  decorateAccessLists,
  fillMissingAccessNames,
  filterAccessEntries,
  nameForAccessUid,
  isBindableDeviceId,
  MISSING_NAME_LOOKUP_CAP,
  nameFromSubmission,
  newAccessUids,
  normalizeAccessUid,
  parseAllowCredentials,
  pickAccessNameLookups,
  readAllowedDevicePins,
  readCachedAccessNames,
  shortUid,
  uniqueAccessUids,
  unpinnedAccessCount,
  writeCachedAccessNames,
  ZERO_DEVICE_ID,
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

test("nameForAccessUid returns the published display name for a uid", () => {
  const rows = [
    { uid: "uid-a", name: "[KING] JesusDied4U" },
    { uid: "uid-b", name: "Croxy" },
  ];
  assert.equal(nameForAccessUid(rows, " uid-a "), "[KING] JesusDied4U");
  assert.equal(nameForAccessUid(rows, "missing"), "");
  assert.equal(nameForAccessUid(rows, ""), "");
});

test("filterAccessEntries matches name, uid, or device pin", () => {
  const rows = [
    { uid: "aaa111", name: "Croxy", deviceId: "device-alpha-1234" },
    { uid: "bbb222", name: "Pal", deviceId: "device-bravo-5678" },
  ];
  assert.equal(filterAccessEntries(rows, "crox").length, 1);
  assert.equal(filterAccessEntries(rows, "BBB").length, 1);
  assert.equal(filterAccessEntries(rows, "bravo-5678").length, 1);
  assert.equal(filterAccessEntries(rows, "").length, 2);
});

test("parseAllowCredentials requires a uid and a real device pin", () => {
  assert.equal(parseAllowCredentials("  uid-a  ", "device-12345678").uid, "uid-a");
  assert.equal(parseAllowCredentials("uid-a", "device-12345678").deviceId, "device-12345678");
  assert.match(parseAllowCredentials("", "device-12345678").error, /Firebase/i);
  assert.match(parseAllowCredentials("uid-a", "").error, /Device/i);
  assert.match(parseAllowCredentials("uid-a", ZERO_DEVICE_ID).error, /zero/i);
  assert.match(parseAllowCredentials("uid-a", "short").error, /short/i);
  assert.match(parseAllowCredentials("test123", "device-12345678").error, /banned/i);
  assert.match(parseAllowCredentials("SECURITYTESTXSSEND2END9", "device-12345678").error, /banned/i);
  assert.match(parseAllowCredentials("LeoGamingCKI0PX2KQXLB0EYPP3", "device-12345678").error, /banned/i);
});

test("isBindableDeviceId rejects blanks, short ids, and the all-zero UUID", () => {
  assert.equal(isBindableDeviceId("device-12345678"), true);
  assert.equal(isBindableDeviceId("  "), false);
  assert.equal(isBindableDeviceId("short"), false);
  assert.equal(isBindableDeviceId(ZERO_DEVICE_ID), false);
});

test("readAllowedDevicePins keeps bindable pins and drops the zero UUID", () => {
  const pins = readAllowedDevicePins({
    " uid-a ": " device-12345678 ",
    "uid-zero": ZERO_DEVICE_ID,
    "uid-blank": "",
  });
  assert.equal(pins["uid-a"], "device-12345678");
  assert.equal(pins["uid-zero"], undefined);
  assert.equal(pins["uid-blank"], undefined);
});

test("nameFromSubmission prefers displayName and strips nickname markup", () => {
  assert.equal(nameFromSubmission({ displayName: "Croxy", nickname: "<b>nope</b>" }), "Croxy");
  assert.equal(nameFromSubmission({ nickname: "<#00FFFF>J<b>esus</b>" }), "Jesus");
  assert.equal(nameFromSubmission({}), "");
});

test("fillMissingAccessNames looks up only nameless uids and caches hits", async () => {
  const calls = [];
  const names = await fillMissingAccessNames({
    uids: ["uid-known", "uid-new", "uid-known"],
    names: new Map([["uid-known", "Pal"]]),
    lookup: async (uid) => {
      calls.push(uid);
      return { displayName: "Croxy" };
    },
  });
  assert.deepEqual(calls, ["uid-new"]);
  assert.equal(names.get("uid-known"), "Pal");
  assert.equal(names.get("uid-new"), "Croxy");
});

test("newAccessUids skips the first load and then only returns added uids", () => {
  const first = ["uid-a", "uid-b", "uid-a"];
  assert.deepEqual(newAccessUids(first, null), []);
  assert.deepEqual(newAccessUids(["uid-a", "uid-b", "uid-c"], first), ["uid-c"]);
  assert.deepEqual(newAccessUids(["uid-a"], first), []);
});

test("pickAccessNameLookups skips named and already-tried uids and caps the rest", () => {
  assert.ok(MISSING_NAME_LOOKUP_CAP <= 4);
  const picked = pickAccessNameLookups({
    uids: ["named", "miss", "fresh-1", "fresh-2", "fresh-3", "fresh-4", "fresh-5"],
    names: new Map([["named", "Pal"]]),
    skip: new Set(["miss"]),
    limit: MISSING_NAME_LOOKUP_CAP,
  });
  assert.deepEqual(picked, ["fresh-1", "fresh-2", "fresh-3", "fresh-4"]);
});

test("fillMissingAccessNames does not retry a miss or a failed lookup", async () => {
  const calls = [];
  const skip = new Set();
  const lookup = async (uid) => {
    calls.push(uid);
    if (uid === "uid-fail") throw new Error("quota");
    return {};
  };
  await fillMissingAccessNames({
    uids: ["uid-miss", "uid-fail"],
    names: new Map(),
    skip,
    lookup,
  });
  await fillMissingAccessNames({
    uids: ["uid-miss", "uid-fail", "uid-later"],
    names: new Map(),
    skip,
    lookup,
  });
  assert.deepEqual(calls, ["uid-miss", "uid-fail", "uid-later"]);
  assert.ok(skip.has("uid-miss"));
  assert.ok(skip.has("uid-fail"));
});

test("access refresh looks up only brand-new uids after JSON and cache", async () => {
  const src = await readFile(join(root, "js/access-view.js"), "utf8");
  assert.match(src, /const newcomers = newAccessUids\(current, knownUids\)/);
  assert.match(src, /uids: newcomers/);
  assert.match(src, /skip: nameMisses/);
  assert.doesNotMatch(src, /uids: \[\.\.\.allowed, \.\.\.banned\]/);
});

test("access name cache round-trips uid to display name", () => {
  const storage = {
    data: {},
    getItem(key) { return this.data[key] ?? null; },
    setItem(key, value) { this.data[key] = String(value); },
  };
  writeCachedAccessNames(new Map([["uid-a", "Croxy"]]), storage);
  const loaded = readCachedAccessNames(storage);
  assert.equal(loaded.get("uid-a"), "Croxy");
});

test("uniqueAccessUids drops repeats and blank entries", () => {
  assert.deepEqual(
    uniqueAccessUids([" uid-a ", "uid-b", "uid-a", "", "uid-b"]),
    ["uid-a", "uid-b"],
  );
});

test("uniqueAccessUids keeps a player who was seeded from every playlist", () => {
  const uid = "YpbPvklM3pOWp2h7MJFZrAPYM4m2";
  assert.deepEqual(uniqueAccessUids([uid, uid, uid, uid]), [uid]);
});

test("decorateAccessLists still shows a uid that is on both lists", () => {
  const { allowedRows, bannedRows } = decorateAccessLists({
    allowed: ["yama"],
    banned: ["yama"],
    names: new Map([["yama", "YamaJax"]]),
  });
  assert.equal(allowedRows.length, 1);
  assert.equal(bannedRows.length, 1);
});

test("Allow writes drop the uid from the ban list before adding it to allow", async () => {
  const src = await readFile(join(root, "js/firebase.js"), "utf8");
  assert.match(src, /userIds: arrayRemove\(uid\)[\s\S]*allowedUserIds: arrayUnion\(uid\)/);
  assert.match(src, /await setDoc\(ref, \{ userIds: arrayRemove\(uid\) \}/);
});

test("decorateAccessLists shows one row per uid when the seed listed them twice", () => {
  const { allowedRows, bannedRows } = decorateAccessLists({
    allowed: ["uid-a", "uid-a", "uid-b"],
    banned: ["uid-z", "uid-z"],
    names: new Map([["uid-a", "Croxy"]]),
  });
  assert.equal(allowedRows.length, 2);
  assert.equal(bannedRows.length, 1);
});

test("decorateAccessLists attaches published names and sorts unpinned first", () => {
  const names = new Map([["uid-b", "Croxy"], ["uid-a", "Pal"], ["uid-c", "Yama"]]);
  const { allowedRows, bannedRows } = decorateAccessLists({
    allowed: ["uid-b", "uid-a", "uid-c"],
    banned: ["uid-z"],
    names,
    pins: { "uid-a": "device-pal-1234", "uid-c": "device-yama-5678" },
  });
  assert.equal(allowedRows[0].name, "Croxy");
  assert.equal(allowedRows[0].pinned, false);
  assert.equal(allowedRows[1].name, "Pal");
  assert.equal(allowedRows[1].deviceId, "device-pal-1234");
  assert.equal(allowedRows[1].pinned, true);
  assert.equal(bannedRows[0].uid, "uid-z");
  assert.equal(bannedRows[0].name, "");
  assert.equal(unpinnedAccessCount(allowedRows), 1);
});

test("checkpoint meters label allowed ids, missing devices, banned ids, and banned devices", async () => {
  const src = await readFile(join(root, "js/access-view.js"), "utf8");
  assert.match(src, /Allowed IDs/);
  assert.match(src, /No device/);
  assert.match(src, /Banned IDs/);
  assert.match(src, /Banned devices/);
  assert.match(src, /text: "Allow"/);
  assert.match(src, /Set device/);
  assert.match(src, /access-draft-who/);
  assert.match(src, /Editing \$\{draftName\}/);
  assert.match(src, /writes\?\.addAllowedUserId\(parsed\.uid, parsed\.deviceId\)/);
  assert.match(src, /new FormData\(event\.currentTarget\)/);
});

test("Allow pins one uid with a dotted path so other pins stay put", async () => {
  const src = await readFile(join(root, "js/firebase.js"), "utf8");
  assert.match(src, /`allowedDevices\.\$\{uid\}`/);
  assert.doesNotMatch(src, /patch\.allowedDevices = \{ \[uid\]: bound \}/);
});

test("index.html exposes the Access tab after Sync", async () => {
  const html = await readFile(join(root, "index.html"), "utf8");
  const publishAt = html.indexOf('id="publishTab"');
  const accessAt = html.indexOf('id="accessTab"');
  assert.ok(publishAt > 0 && accessAt > publishAt);
  assert.match(html, /id="accessView"/);
  assert.doesNotMatch(html, /id="whitelistForm"/);
});
