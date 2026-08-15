import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("sw.js exists at the site root", async () => {
  const info = await stat(join(root, "sw.js"));
  assert.ok(info.isFile(), "sw.js should be a file");
});

test("index.html loads the external service-worker registrar", async () => {
  const html = await readFile(join(root, "index.html"), "utf8");
  assert.match(html, /src="js\/register-sw\.js\?v=[a-z0-9]+"/);
  assert.doesNotMatch(html, /<script>\s*\/\/ Register the read-stats/);
});

test("register-sw.js registers /sw.js on load", async () => {
  const source = await readFile(join(root, "js/register-sw.js"), "utf8");
  assert.match(source, /navigator\.serviceWorker\.register\(["']\/sw\.js["']\)/);
});
