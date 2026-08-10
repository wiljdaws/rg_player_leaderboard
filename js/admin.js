import { setWriteStatus } from "./render.js";

export class AdminWriteService {
  constructor({ gateway, isAdmin, refreshIcons }) {
    this.gateway = gateway;
    this.isAdmin = isAdmin;
    this.refreshIcons = refreshIcons;
  }

  async run(label, operation) {
    if (!this.isAdmin()) {
      setWriteStatus({ kind: "error", message: "Admin access is required for that change." });
      return false;
    }
    clearTimeout(this._clearTimer);
    setWriteStatus({ kind: "writing", message: `${label}…` });
    try {
      await operation();
      setWriteStatus({ kind: "success", message: `${label} complete.` });
      this._clearTimer = setTimeout(() => setWriteStatus({ kind: "idle", message: "" }), 5000);
      return true;
    } catch (error) {
      setWriteStatus({ kind: "error", message: error?.message || `${label} failed.`, error });
      this._clearTimer = setTimeout(() => setWriteStatus({ kind: "idle", message: "" }), 5000);
      return false;
    }
  }

  addPlayer(payload) {
    return this.run("Adding player", () => this.gateway.addPlayer(payload));
  }

  updatePlayer(id, payload) {
    return this.run("Saving player", () => this.gateway.updatePlayer(id, payload));
  }

  deletePlayer(id, playlist) {
    return this.run("Removing player", () => this.gateway.deletePlayer(id, playlist));
  }

  clearTournament() {
    return this.run("Clearing tournament", () => this.gateway.clearTournament());
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
  // Tournament rows don't own their flag or icon URLs — those come from the
  // roster autocomplete when a player is added. Hide the whole Appearance
  // section on tournament so the edit dialog only shows Score / Matches.
  for (const section of form.querySelectorAll("[data-appearance-section]")) {
    const hidden = playlist === "tournament";
    section.hidden = hidden;
    for (const input of section.querySelectorAll("input, select")) {
      input.disabled = hidden;
    }
  }
}

export function setFormValue(form, name, value) {
  const field = form.elements.namedItem(name);
  if (!field) return;
  // The edit form has two inputs named "matches" on purpose (wins group +
  // tournament group). namedItem returns a RadioNodeList in that case and
  // setting .value on it is a no-op for non-radio inputs, so the target
  // field never gets populated. Iterate through all matches instead.
  if (field instanceof Element) {
    field.value = value ?? "";
  } else {
    for (const el of field) el.value = value ?? "";
  }
}

export function readFormValues(form) {
  return Object.fromEntries(new FormData(form).entries());
}
