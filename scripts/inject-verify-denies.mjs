// One-shot injector: writes a hud_read_stats doc with a mixed batch of
// fabricated deny events so the admin dashboard's "Recent HUD denies"
// table and per-bucket rule breakdown can be visually verified.
//
// Usage:
//   node scripts/inject-verify-denies.mjs
//
// After it runs, open the site at /?playlist=reads (signed in as admin)
// and look for events whose subject starts with "verify=" — those are
// the injected ones. They roll off the 30-day window naturally, or you
// can delete the doc listed at the end via the Firestore console.

const FIREBASE_CONFIG = {
  apiKey: "AIzaSyD29s2Jku_DZ42keIQAETgKg7HWt__QEwY",
  authDomain: "rgleaderboard.firebaseapp.com",
  projectId: "rgleaderboard",
  storageBucket: "rgleaderboard.firebasestorage.app",
  messagingSenderId: "247848634543",
  appId: "1:247848634543:web:6a7e506d60544d46cc6c5a",
};

const { initializeApp } = await import("firebase/app");
const { getFirestore, doc, setDoc, serverTimestamp } = await import("firebase/firestore");

const app = initializeApp(FIREBASE_CONFIG);
const db = getFirestore(app);

const runId = new Date().toISOString().replace(/[:.]/g, "-");
const sourceUserId = `atlas-deny-verify-${runId}`;
const today = new Date().toISOString().slice(0, 10);
const docId = `${today}_${sourceUserId}`;

// Fabricated events — 1-3 per rule guess type, varied ops and buckets.
// Each subject starts with "verify=" so injected events are trivial to
// find in the dashboard table.
const now = Date.now();
const at = (offsetSeconds) => new Date(now - offsetSeconds * 1000).toISOString();

const deniesRecent = [
  // version-gate (writes rejected because scriptVersion is stale)
  { at: at(10), bucket: "leaderboard", path: "leaderboard/verify-a_1v1",
    op: "write", code: "permission-denied",
    msg: "Missing or insufficient permissions. version below minVersion",
    subject: "verify=version-gate playlist=1v1", rule: "version-gate" },
  { at: at(20), bucket: "leaderboard", path: "leaderboard/verify-b_3v3",
    op: "write", code: "permission-denied",
    msg: "Missing or insufficient permissions.",
    subject: "verify=version-gate playlist=3v3", rule: "version-gate" },

  // blacklisted uid
  { at: at(30), bucket: "leaderboard", path: "leaderboard/verify-c_2v2",
    op: "write", code: "permission-denied",
    msg: "blacklist match", subject: "verify=blacklist uid=verify-c",
    rule: "blacklisted" },

  // device-id missing
  { at: at(40), bucket: "hud_read_stats", path: "hud_read_stats/2026-08-12_verify-d",
    op: "write", code: "permission-denied",
    msg: "hasValidDeviceId denied", subject: "verify=device-id",
    rule: "device-id" },
  { at: at(50), bucket: "script_submissions", path: "script_submissions/verify-e",
    op: "write", code: "permission-denied",
    msg: "no valid deviceId in payload", subject: "verify=device-id Nickname=\"tester\"",
    rule: "device-id" },

  // stale write stamp
  { at: at(60), bucket: "leaderboard", path: "leaderboard/verify-f_1v1",
    op: "write", code: "permission-denied",
    msg: "lastWriteAt does not equal request.time",
    subject: "verify=write-stamp playlist=1v1", rule: "write-stamp" },

  // clan-membership
  { at: at(70), bucket: "clans", path: "clans/verify-clan",
    op: "write", code: "permission-denied",
    msg: "not a clan member", subject: "verify=clan clanId=verify-clan role=member",
    rule: "clan-membership" },
  { at: at(80), bucket: "clans/members", path: "clans/verify-clan/members/verify-g",
    op: "write", code: "permission-denied",
    msg: "member is not on the clan roster",
    subject: "verify=clan clanId=verify-clan", rule: "clan-membership" },

  // name-blocklist (profanity / emoji regex)
  { at: at(90), bucket: "script_submissions", path: "script_submissions/verify-h",
    op: "write", code: "permission-denied",
    msg: "name failed profanity check",
    subject: "verify=name-blocklist Nickname=\"redacted\"",
    rule: "name-blocklist" },
  { at: at(100), bucket: "script_submissions", path: "script_submissions/verify-i",
    op: "write", code: "permission-denied",
    msg: "name contains emoji not allowed",
    subject: "verify=name-blocklist Nickname=\"redacted\"",
    rule: "name-blocklist" },

  // read-side denies (rule guess blank -> "unknown")
  { at: at(110), bucket: "leaderboard", path: "leaderboard/verify-j_wins",
    op: "read", code: "permission-denied",
    msg: "read denied", subject: "verify=unknown-read uid=verify-j",
    rule: "" },
  { at: at(120), bucket: "clans_directory", path: "clans_directory/index",
    op: "listener", code: "permission-denied",
    msg: "listener denied", subject: "verify=unknown-listener",
    rule: "" },
];

// Sanity check: 12 events, at least one per rule bucket.
const ruleCounts = deniesRecent.reduce((acc, e) => {
  const key = e.rule || "unknown";
  acc[key] = (acc[key] || 0) + 1;
  return acc;
}, {});

const perLabelDenies = deniesRecent.reduce((acc, e) => {
  acc[e.bucket] = (acc[e.bucket] || 0) + 1;
  return acc;
}, {});

const payload = {
  date: today,
  sourceUserId,
  deviceId: `verify-device-${runId}`,
  scriptVersion: "verify-inject",
  versionNum: 18.6,
  startedAt: new Date(now - 300_000).toISOString(),
  updatedAt: new Date(now).toISOString(),
  readTotal: 0,
  writeTotal: 0,
  perLabelReads: {},
  perLabelWrites: {},
  perLabelDenies,
  deniesRecent,
  lastWriteAt: serverTimestamp(),
};

const ref = doc(db, "hud_read_stats", docId);
await setDoc(ref, payload);

console.log("");
console.log("Injected verify batch:");
console.log("  doc path:", `hud_read_stats/${docId}`);
console.log("  events:", deniesRecent.length);
console.log("  rule counts:", ruleCounts);
console.log("  bucket counts:", perLabelDenies);
console.log("");
console.log("Open the dashboard: <site>/?playlist=reads (sign in as admin)");
console.log("Look for rows whose Subject starts with \"verify=\".");
console.log("");
console.log("To remove: delete the doc above from the Firestore console,");
console.log("or wait 30 days for it to roll off the snapshot window.");
process.exit(0);
