import { test } from "node:test";
import assert from "node:assert/strict";

import {
  READ_SOURCE_DEFAULT,
  publicPlaylistAllowsFirestoreFallback,
  publicPlaylistUsesLiveFirestore,
  resolveReadSource,
} from "../js/config.js";

function makeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: (key) => { map.delete(key); },
    _map: map,
  };
}

const KEY = "rgPlayerLb:readSource";

test("resolveReadSource returns default when nothing else is set", () => {
  const storage = makeStorage();
  const result = resolveReadSource({ url: "https://example.com/", storage });
  assert.equal(result, READ_SOURCE_DEFAULT);
});

test("URL param wins over localStorage", () => {
  const storage = makeStorage({ [KEY]: "firestore" });
  const result = resolveReadSource({
    url: "https://example.com/?readSource=static",
    storage,
  });
  assert.equal(result, "static");
});

test("localStorage is honored when no URL param is present", () => {
  const storage = makeStorage({ [KEY]: "static" });
  const result = resolveReadSource({ url: "https://example.com/", storage });
  assert.equal(result, "static");
});

test("invalid URL param values are ignored and fall through to storage", () => {
  const storage = makeStorage({ [KEY]: "static" });
  const result = resolveReadSource({
    url: "https://example.com/?readSource=totallybogus",
    storage,
  });
  assert.equal(result, "static");
});

test("invalid localStorage values are ignored and fall through to default", () => {
  const storage = makeStorage({ [KEY]: "garbage" });
  const result = resolveReadSource({ url: "https://example.com/", storage });
  assert.equal(result, READ_SOURCE_DEFAULT);
});

test("persist=1 with a valid URL param writes to localStorage", () => {
  const storage = makeStorage();
  const result = resolveReadSource({
    url: "https://example.com/?readSource=static&persist=1",
    storage,
  });
  assert.equal(result, "static");
  assert.equal(storage.getItem(KEY), "static");
});

test("persist=1 with an invalid readSource clears localStorage", () => {
  const storage = makeStorage({ [KEY]: "static" });
  const result = resolveReadSource({
    url: "https://example.com/?readSource=nope&persist=1",
    storage,
  });
  // Cleared, so we're back to the default.
  assert.equal(result, READ_SOURCE_DEFAULT);
  assert.equal(storage.getItem(KEY), null);
});

test("persist without =1 does not touch localStorage", () => {
  const storage = makeStorage();
  const result = resolveReadSource({
    url: "https://example.com/?readSource=static",
    storage,
  });
  assert.equal(result, "static");
  assert.equal(storage.getItem(KEY), null);
});

test("resolveReadSource is safe when storage is missing", () => {
  const result = resolveReadSource({
    url: "https://example.com/?readSource=static",
    storage: null,
  });
  assert.equal(result, "static");
});

test("resolveReadSource is safe when both URL and storage are missing", () => {
  const result = resolveReadSource({ url: null, storage: null });
  assert.equal(result, READ_SOURCE_DEFAULT);
});

test("visitors stay on published JSON even if readSource=firestore", () => {
  assert.equal(
    publicPlaylistUsesLiveFirestore({ playlist: "1v1", source: "firestore", isAdmin: false }),
    false,
  );
  assert.equal(publicPlaylistAllowsFirestoreFallback(false), false);
});

test("admins can still use live Firestore", () => {
  assert.equal(
    publicPlaylistUsesLiveFirestore({ playlist: "1v1", source: "firestore", isAdmin: true }),
    true,
  );
  assert.equal(publicPlaylistAllowsFirestoreFallback(true), true);
});

test("tournament tab stays on Firestore for everyone", () => {
  assert.equal(
    publicPlaylistUsesLiveFirestore({ playlist: "tournament", source: "static", isAdmin: false }),
    true,
  );
});
