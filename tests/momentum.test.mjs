import { test } from "node:test";
import assert from "node:assert/strict";

import { formatWindow, momentumChip } from "../js/momentum.js";

test("formatWindow reports 'last hour' once we have ~55 minutes of samples", () => {
  assert.equal(formatWindow(55 * 60_000), "last hour");
  assert.equal(formatWindow(60 * 60_000), "last hour");
});

test("formatWindow uses minute count for shorter spans", () => {
  assert.equal(formatWindow(4 * 60_000), "last 4m");
  assert.equal(formatWindow(30_000), "last 1m");
});

test("momentumChip labels a positive gain as hot", () => {
  const chip = momentumChip({ gained: 42, spanMs: 60 * 60_000, samples: 3 });
  assert.equal(chip.className, "momentum hot");
  assert.match(chip.label, /\+42/);
  assert.match(chip.label, /last hour/);
});

test("momentumChip labels a negative gain as cold", () => {
  const chip = momentumChip({ gained: -15, spanMs: 30 * 60_000, samples: 4 });
  assert.equal(chip.className, "momentum cold");
  assert.match(chip.label, /-15/);
});

test("momentumChip labels a flat window", () => {
  const chip = momentumChip({ gained: 0, spanMs: 60 * 60_000, samples: 5 });
  assert.equal(chip.className, "momentum flat");
});

test("momentumChip shows 'no data yet' when we have <2 samples", () => {
  const chip = momentumChip({ gained: null, spanMs: 0, samples: 1 });
  assert.equal(chip.className, "momentum none");
  assert.equal(chip.label, "no data yet");
});
