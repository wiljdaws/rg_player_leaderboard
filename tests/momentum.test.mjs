import { test } from "node:test";
import assert from "node:assert/strict";

import { formatWindow, momentumChip } from "../js/momentum.js";

test("formatWindow reports 'last hour' once we have ~55 minutes of samples", () => {
  assert.equal(formatWindow(55 * 60_000), "last hour");
  assert.equal(formatWindow(60 * 60_000), "last hour");
});

test("formatWindow uses a spelled-out minute count for shorter spans", () => {
  assert.equal(formatWindow(32 * 60_000), "last 32 min");
  assert.equal(formatWindow(10 * 60_000), "last 10 min");
});

test("momentumChip labels a positive gain as hot with the actual span", () => {
  const chip = momentumChip({ gained: 42, spanMs: 32 * 60_000, samples: 5 });
  assert.equal(chip.className, "momentum hot");
  assert.match(chip.label, /\+42/);
  assert.match(chip.label, /last 32 min/);
});

test("momentumChip snaps to 'last hour' once span is a full hour", () => {
  const chip = momentumChip({ gained: 100, spanMs: 60 * 60_000, samples: 8 });
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

test("momentumChip reports 'warming up' when the span is under 10 min", () => {
  const chip = momentumChip({ gained: 55, spanMs: 60_000, samples: 2 });
  assert.equal(chip.className, "momentum warming");
  assert.equal(chip.label, "warming up");
});

test("momentumChip reports 'warming up' when we have <2 samples", () => {
  const chip = momentumChip({ gained: null, spanMs: 0, samples: 1 });
  assert.equal(chip.className, "momentum warming");
  assert.equal(chip.label, "warming up");
});
