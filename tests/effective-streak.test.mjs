import { test } from "node:test";
import assert from "node:assert/strict";

import { effectiveStreak } from "../js/render.js";

test("effectiveStreak prefers a non-zero published streak", () => {
  const player = { id: "a", currentStreak: 7 };
  const historyStore = { streakFor: () => ({ streak: 2, confident: true }) };
  const result = effectiveStreak(player, historyStore);
  assert.equal(result.streak, 7);
  assert.equal(result.source, "published");
});

test("effectiveStreak falls back to observed when published is missing", () => {
  const player = { id: "a" };
  const historyStore = { streakFor: () => ({ streak: 4, confident: true }) };
  const result = effectiveStreak(player, historyStore);
  assert.equal(result.streak, 4);
  assert.equal(result.source, "observed");
});

test("effectiveStreak falls back to observed when published is 0", () => {
  const player = { id: "a", currentStreak: 0 };
  const historyStore = { streakFor: () => ({ streak: 5, confident: true }) };
  const result = effectiveStreak(player, historyStore);
  assert.equal(result.streak, 5);
  assert.equal(result.source, "observed");
});

test("effectiveStreak returns 0/none when nothing usable is available", () => {
  const player = { id: "a" };
  const historyStore = { streakFor: () => ({ streak: 0, confident: false }) };
  const result = effectiveStreak(player, historyStore);
  assert.equal(result.streak, 0);
  assert.equal(result.source, "none");
});

test("effectiveStreak ignores an unconfident observed streak", () => {
  const player = { id: "a" };
  const historyStore = { streakFor: () => ({ streak: 3, confident: false }) };
  const result = effectiveStreak(player, historyStore);
  assert.equal(result.source, "none");
});
