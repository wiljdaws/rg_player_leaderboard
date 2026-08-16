import { setWriteStatus } from "./render.js";

// Firestore writes land instantly; the public site polls a cached JSON
// blob that a cron job rebuilds every ~15 min. Admin edits patch the
// local row list optimistically, so admins see their own change right
// away — the hint just calls out the public-site lag.
const PUBLISH_LAG_HINT = "Public site refreshes within ~15 min.";

export class AdminWriteService {
  constructor({ gateway, isAdmin, isAdminAccount = isAdmin, refreshIcons }) {
    this.gateway = gateway;
    this.isAdmin = isAdmin;
    this.isAdminAccount = isAdminAccount;
    this.refreshIcons = refreshIcons;
  }

  async run(label, operation, { hint = "", allowWhenPaused = false } = {}) {
    const allowed = allowWhenPaused ? this.isAdminAccount() : this.isAdmin();
    if (!allowed) {
      setWriteStatus({
        kind: "error",
        message: this.isAdminAccount() && !allowWhenPaused
          ? "Writes are paused. Turn pauseWrites off on admin/blacklist, then try Save again."
          : "Admin access is required for that change.",
      });
      return false;
    }
    clearTimeout(this._clearTimer);
    setWriteStatus({ kind: "writing", message: `${label}…` });
    try {
      const result = await operation();
      setWriteStatus({ kind: "success", message: `${label} complete.`, hint });
      // Give the hint enough time to actually be read.
      const clearMs = hint ? 12000 : 5000;
      this._clearTimer = setTimeout(() => setWriteStatus({ kind: "idle", message: "" }), clearMs);
      // Pass the operation's return (e.g. addDoc's ref) back through so
      // callers can grab the id. Default to true for the void case.
      return result === undefined ? true : result;
    } catch (error) {
      const raw = error?.message || `${label} failed.`;
      const message = /quota exceeded|resource-exhausted|RESOURCE_EXHAUSTED/i.test(`${error?.code || ""} ${raw}`)
        ? "Firestore daily quota is used up. The save did not land — try again after it resets."
        : raw;
      setWriteStatus({ kind: "error", message, error });
      this._clearTimer = setTimeout(() => setWriteStatus({ kind: "idle", message: "" }), 12000);
      return false;
    }
  }

  addPlayer(payload) {
    return this.run(
      "Adding player",
      () => this.gateway.addPlayer(payload),
      { hint: PUBLISH_LAG_HINT },
    );
  }

  updatePlayer(id, payload) {
    return this.run(
      "Saving player",
      () => this.gateway.updatePlayer(id, payload),
      { hint: PUBLISH_LAG_HINT },
    );
  }

  deletePlayer(id, playlist) {
    return this.run(
      "Removing player",
      () => this.gateway.deletePlayer(id, playlist),
      { hint: PUBLISH_LAG_HINT },
    );
  }

  deletePlayerAllPlaylists(sourceUserId) {
    return this.run(
      "Removing player from all playlists",
      () => this.gateway.deletePlayerAllPlaylists(sourceUserId),
      { hint: PUBLISH_LAG_HINT },
    );
  }

  clearTournament() {
    return this.run(
      "Clearing tournament",
      () => this.gateway.clearTournament(),
      { hint: PUBLISH_LAG_HINT },
    );
  }

  addAllowedUserId(uid) {
    return this.run("Allowing HUD uid", () => this.gateway.addAllowedUserId(uid), { allowWhenPaused: true });
  }

  removeAllowedUserId(uid) {
    return this.run("Removing HUD uid", () => this.gateway.removeAllowedUserId(uid), { allowWhenPaused: true });
  }

  addBannedUserId(uid) {
    return this.run("Banning HUD uid", () => this.gateway.addBannedUserId(uid), { allowWhenPaused: true });
  }

  removeBannedUserId(uid) {
    return this.run("Unbanning HUD uid", () => this.gateway.removeBannedUserId(uid), { allowWhenPaused: true });
  }

  addBannedDeviceId(id) {
    return this.run("Banning device", () => this.gateway.addBannedDeviceId(id), { allowWhenPaused: true });
  }

  removeBannedDeviceId(id) {
    return this.run("Unbanning device", () => this.gateway.removeBannedDeviceId(id), { allowWhenPaused: true });
  }

  addIcon(payload) {
    return this.run("Adding icon", async () => {
      await this.gateway.addIcon(payload);
      await this.refreshIcons(true);
    });
  }

  deleteIcon(id) {
    return this.run("Removing icon", async () => {
      await this.gateway.deleteIcon(id);
      await this.refreshIcons(true);
    });
  }
}

export function togglePlaylistFields(form, playlist) {
  if (!form) return;
  for (const group of form.querySelectorAll("[data-score-fields]")) {
    let hidden;
    if (group.dataset.scoreFields === "wins") hidden = playlist !== "wins";
    else if (group.dataset.scoreFields === "tournament") hidden = playlist !== "tournament";
    else if (group.dataset.scoreFields === "ranked") hidden = playlist === "wins" || playlist === "tournament";
    else continue;
    group.hidden = hidden;
    // Disable inputs in hidden groups so FormData doesn't pick up stale values
    // from a shape that doesn't apply — the wins and tournament score-groups
    // both use name="matches" so leaving them enabled would collide.
    for (const input of group.querySelectorAll("input, select")) {
      input.disabled = hidden;
    }
  }
  // Tournament rows pick up flag + icons from the roster autocomplete
  // at add-time, so hide the Appearance section on that playlist.
  for (const section of form.querySelectorAll("[data-appearance-section]")) {
    const hidden = playlist === "tournament";
    section.hidden = hidden;
    for (const input of section.querySelectorAll("input, select")) {
      const inPicker = input.closest("[data-flag-picker], .flag-picker");
      if (inPicker && input.name !== "flag") {
        // Never re-enable picker chrome (search / add-URL / country) when
        // showing Appearance. Enabling a hidden type=url (or leftover
        // add-row value) blocks native submit with no error in the dialog.
        // hydrateFlagPicker owns those disabled flags.
        if (hidden) input.disabled = true;
        continue;
      }
      input.disabled = hidden;
    }
  }
}

export function setFormValue(form, name, value) {
  const field = form.elements.namedItem(name);
  if (!field) return;
  // Two inputs share name="matches" (wins + tournament groups), so
  // namedItem returns a RadioNodeList and setting .value on it is a
  // no-op for non-radios. Iterate so both inputs get the value.
  if (field instanceof Element) {
    field.value = value ?? "";
  } else {
    for (const el of field) el.value = value ?? "";
  }
}

export function readFormValues(form) {
  return Object.fromEntries(new FormData(form).entries());
}
