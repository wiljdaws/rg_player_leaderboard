// Purge hud_read_stats docs stamped by inject-verify-denies.mjs.
// Uses the firebase-tools stored refresh token (same auth as
// `firebase deploy`) and hits Firestore REST directly.

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const project = "rgleaderboard";
const configPath = path.join(homedir(), ".config/configstore/firebase-tools.json");
const cfg = JSON.parse(await readFile(configPath, "utf8"));

// Firebase CLI's OAuth client. Public and documented; used by every
// `firebase` invocation to refresh access tokens.
const CLIENT_ID = "563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com";
const CLIENT_SECRET = "j9iVZfS8kkCEFUPaAeJV0sAi";

async function accessToken() {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: cfg.tokens.refresh_token,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
  });
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) throw new Error("token refresh failed: " + await res.text());
  const j = await res.json();
  return j.access_token;
}

const token = await accessToken();
const base = `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents`;

async function firestore(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${method} ${url} -> ${res.status} ${text}`);
  }
  return res.status === 204 ? null : await res.json();
}

const query = {
  structuredQuery: {
    from: [{ collectionId: "hud_read_stats" }],
    where: {
      fieldFilter: {
        field: { fieldPath: "scriptVersion" },
        op: "EQUAL",
        value: { stringValue: "verify-inject" },
      },
    },
  },
};

const results = await firestore("POST", `${base}:runQuery`, query);
const paths = (results || [])
  .filter(row => row?.document?.name)
  .map(row => row.document.name);

if (paths.length === 0) {
  console.log("No verify-inject docs found — nothing to clean up.");
  process.exit(0);
}

console.log(`Found ${paths.length} verify-inject doc(s):`);
for (const p of paths) console.log("  " + p.split("/documents/")[1]);

for (const p of paths) {
  await firestore("DELETE", `https://firestore.googleapis.com/v1/${p}`);
}
console.log(`Deleted ${paths.length} doc(s).`);
