import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function cspFrom(html) {
  const match = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/);
  assert.ok(match, "index.html should declare a CSP");
  return match[1];
}

test("CSP allows Google sign-in without unsafe-inline scripts", async () => {
  const html = await readFile(join(root, "index.html"), "utf8");
  const csp = cspFrom(html);
  assert.match(csp, /script-src[^;]*https:\/\/apis\.google\.com/);
  assert.match(csp, /script-src[^;]*https:\/\/www\.gstatic\.com/);
  assert.doesNotMatch(csp, /script-src[^;]*'unsafe-inline'/);
  assert.match(csp, /connect-src[^;]*https:\/\/apis\.google\.com/);
  assert.match(csp, /connect-src[^;]*https:\/\/www\.gstatic\.com/);
  assert.match(csp, /frame-src[^;]*https:\/\/accounts\.google\.com/);
  assert.match(csp, /frame-src[^;]*https:\/\/rgleaderboard\.firebaseapp\.com/);
});

test("CSP hash matches the importmap body", async () => {
  const html = await readFile(join(root, "index.html"), "utf8");
  const csp = cspFrom(html);
  const map = html.match(/<script type="importmap">(.*?)<\/script>/s);
  assert.ok(map, "importmap should exist");
  const digest = createHash("sha256").update(map[1]).digest("base64");
  assert.match(csp, new RegExp(`'sha256-${digest.replace(/[+/=]/g, "\\$&")}'`));
});
