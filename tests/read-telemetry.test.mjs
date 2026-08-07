import { test } from "node:test";
import assert from "node:assert/strict";

import { createReadTelemetryUploader } from "../js/read-telemetry.js";

// Minimal gateway mock: records every setReadStat call so we can assert
// on the payload the uploader shipped.
function makeGateway() {
  const calls = [];
  return {
    calls,
    setReadStat: async (docKey, payload) => {
      calls.push({ docKey, payload });
    },
  };
}

function makeBudget({ total = 5, perLabel = { adminRoster: 5 }, tripped = false } = {}) {
  return { snapshot: () => ({ total, perLabel, tripped }) };
}

test("uploader stamps default source='player' on the payload", async () => {
  const gateway = makeGateway();
  const uploader = createReadTelemetryUploader({
    gateway,
    budget: makeBudget(),
    isAdmin: () => true,
  });
  uploader.start();
  // start() fires an initial upload synchronously via microtask; await it.
  await uploader.upload({ final: true });
  uploader.stop();

  assert.ok(gateway.calls.length >= 1, "expected at least one write");
  const last = gateway.calls[gateway.calls.length - 1];
  assert.equal(last.payload.source, "player");
});

test("uploader respects an explicit source option", async () => {
  const gateway = makeGateway();
  const uploader = createReadTelemetryUploader({
    gateway,
    budget: makeBudget(),
    isAdmin: () => true,
    source: "clan",
  });
  uploader.start();
  await uploader.upload({ final: true });
  uploader.stop();

  const last = gateway.calls[gateway.calls.length - 1];
  assert.equal(last.payload.source, "clan");
});

test("uploader clamps source to 16 chars and coerces bad values to default", async () => {
  const gateway = makeGateway();
  const uploader = createReadTelemetryUploader({
    gateway,
    budget: makeBudget(),
    isAdmin: () => true,
    source: "a".repeat(64),
  });
  uploader.start();
  await uploader.upload({ final: true });
  uploader.stop();
  const last1 = gateway.calls[gateway.calls.length - 1];
  assert.equal(last1.payload.source.length, 16);

  const gateway2 = makeGateway();
  const uploader2 = createReadTelemetryUploader({
    gateway: gateway2,
    budget: makeBudget(),
    isAdmin: () => true,
    source: null,
  });
  uploader2.start();
  await uploader2.upload({ final: true });
  uploader2.stop();
  const last2 = gateway2.calls[gateway2.calls.length - 1];
  assert.equal(last2.payload.source, "player");
});

test("uploader skips uploads when isAdmin returns false", async () => {
  const gateway = makeGateway();
  const uploader = createReadTelemetryUploader({
    gateway,
    budget: makeBudget(),
    isAdmin: () => false,
    source: "player",
  });
  uploader.start();
  await uploader.upload({ final: true });
  uploader.stop();
  assert.equal(gateway.calls.length, 0);
});
