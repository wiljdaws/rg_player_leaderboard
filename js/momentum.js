// Below this we don't have enough samples to draw a meaningful trend, so
// callers should show a "warming up" state instead of a misleading tiny
// window like "last 1m".
export const MIN_SPAN_MS = 10 * 60_000;

export function formatWindow(spanMs) {
  const spanMin = Math.max(1, Math.round(spanMs / 60_000));
  return spanMin >= 55 ? "last hour" : `last ${spanMin} min`;
}

export function hasMinSpan(spanMs) {
  return spanMs >= MIN_SPAN_MS;
}

export function momentumChip({ gained, spanMs, samples }) {
  if (gained == null || samples < 2 || !hasMinSpan(spanMs)) {
    return { className: "momentum warming", label: "warming up", title: "Building a longer window" };
  }
  const window = formatWindow(spanMs);
  const rounded = Math.round(gained);
  const magnitude = Math.abs(rounded).toLocaleString();
  if (rounded > 0) {
    return {
      className: "momentum hot",
      label: `🔥 +${magnitude} ${window}`,
      title: `Gained ${magnitude} in the ${window}`,
    };
  }
  if (rounded < 0) {
    return {
      className: "momentum cold",
      label: `❄ -${magnitude} ${window}`,
      title: `Lost ${magnitude} in the ${window}`,
    };
  }
  return {
    className: "momentum flat",
    label: `— flat ${window}`,
    title: `No change ${window}`,
  };
}
