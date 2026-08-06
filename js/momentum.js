export function formatWindow(spanMs) {
  const spanMin = Math.max(1, Math.round(spanMs / 60_000));
  // Round up to "last hour" only once we've been sampling that long — with
  // 4 minutes of data, a chip that says "last hour" would be a lie.
  return spanMin >= 55 ? "last hour" : `last ${spanMin}m`;
}

export function momentumChip({ gained, spanMs, samples }) {
  if (gained == null || samples < 2) {
    return { className: "momentum none", label: "no data yet", title: "Not enough samples yet" };
  }
  const window = formatWindow(spanMs);
  const rounded = Math.round(gained);
  const magnitude = Math.abs(rounded).toLocaleString();

  if (rounded > 0) {
    return {
      className: "momentum hot",
      label: `🔥 +${magnitude} ${window}`,
      title: `Gained ${magnitude} MMR in the ${window}`,
    };
  }
  if (rounded < 0) {
    return {
      className: "momentum cold",
      label: `❄ -${magnitude} ${window}`,
      title: `Lost ${magnitude} MMR in the ${window}`,
    };
  }
  return {
    className: "momentum flat",
    label: `— flat ${window}`,
    title: `No change ${window}`,
  };
}
