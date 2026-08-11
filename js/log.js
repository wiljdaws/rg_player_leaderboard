// Site logger. Every line comes out as `[RG SITE] category: message` so
// DevTools filtering on "RG " catches everything we write.

const PREFIX = "[RG SITE]";
const IS_DEV = typeof globalThis !== "undefined"
  && (globalThis.location?.hostname === "localhost"
      || globalThis.location?.hostname === "127.0.0.1"
      || globalThis.location?.search?.includes("rgDebug=1"));

function fmt(category, message) {
  return `${PREFIX} ${category}: ${message}`;
}

function info(category, message, data) {
  if (data !== undefined) console.info(fmt(category, message), data);
  else console.info(fmt(category, message));
}

function debug(category, message, data) {
  if (!IS_DEV) return;
  if (data !== undefined) console.debug(fmt(category, message), data);
  else console.debug(fmt(category, message));
}

function warn(category, message, data) {
  if (data !== undefined) console.warn(fmt(category, message), data);
  else console.warn(fmt(category, message));
}

function error(category, message, err) {
  // Log a compact summary alongside the raw error so you can scan a
  // wall of logs but still expand for the stack.
  const summary = {
    code: err?.code || null,
    name: err?.name || null,
    message: err?.message || String(err || ""),
  };
  console.error(fmt(category, message), summary, err);
}

export const log = { info, debug, warn, error, PREFIX };
