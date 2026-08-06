export const FIREBASE_CONFIG = Object.freeze({
  apiKey: "AIzaSyD29s2Jku_DZ42keIQAETgKg7HWt__QEwY",
  authDomain: "rgleaderboard.firebaseapp.com",
  projectId: "rgleaderboard",
  storageBucket: "rgleaderboard.firebasestorage.app",
  messagingSenderId: "247848634543",
  appId: "1:247848634543:web:6a7e506d60544d46cc6c5a",
  measurementId: "G-JW3Q972P9T",
});

export const PLAYLISTS = Object.freeze(["1v1", "2v2", "3v3", "wins"]);

export const PLAYLIST_LABELS = Object.freeze({
  "1v1": "1v1 Ranked",
  "2v2": "2v2 Ranked",
  "3v3": "3v3 Ranked",
  wins: "Wins",
});

export const MAX_PLAYLIST_ROWS = 100;

export const ADMIN_EMAILS = Object.freeze([
  "underflagfg@gmail.com",
  "therootedengineer@gmail.com",
]);

// Pinned so an upstream SDK change can't quietly break the site.
export const SDK = "10.12.2";

export function isPlaylist(value) {
  return PLAYLISTS.includes(value);
}

export function isAdminUser(user) {
  return Boolean(user?.email && ADMIN_EMAILS.includes(user.email));
}

export function isRankedPlaylist(playlist) {
  return playlist === "1v1" || playlist === "2v2" || playlist === "3v3";
}
