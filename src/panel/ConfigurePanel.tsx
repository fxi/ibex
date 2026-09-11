import { useEffect, useState } from "react";
import { Settings, Bike, Mountain, Plus, Trash2 } from "lucide-react";
import { download } from "../gpx";
import { loadModels, saveModels } from "../models";
import { modelSnapshot } from "../tracks";
import {
  bundledProfiles,
  profileSchema,
  resolveProfile,
  type ProfileInput,
  type UserProfile,
} from "../routing/profiles";
import { BIKE_OPTIONS } from "../routing/profileFields";
import { ProfileForm } from "./ProfileForm";
import type { PanelContext } from "./context";

const PRESETS = ["gravel", "road", "touring", "scenic"] as const;
type Preset = (typeof PRESETS)[number];

export function ConfigurePanel({ ctx }: { ctx: PanelContext }) {
  const { tracks, routing, models, reloadModels, setError } = ctx;
  const { active, edit } = tracks;
  const [editing, setEditing] = useState<UserProfile>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [confirming, setConfirming] = useState<string>();
  // The raw JSON box keeps its own text so invalid input stays visible and is reported,
  // rather than being silently discarded while the form shows the last good value.
  const [json, setJson] = useState<string>();

  // Switching tracks changes which model is in use, so any half-finished edit is stale.
  useEffect(() => setEditing(undefined), [active?.id]);

  const shownComparison =
    routing.comparison &&
    routing.comparison.trackId === active?.id &&
    routing.comparison.revision === active?.revision
      ? routing.comparison.value
      : undefined;

  const sameModel = (p: ProfileInput) =>
    !!active &&
    JSON.stringify(modelSnapshot(p)) === JSON.stringify(active.profile);
  const useModel = (p: ProfileInput) => edit({ profile: modelSnapshot(p) });

  function startEdit(source: UserProfile | Preset, duplicate = false) {
    const base =
      typeof source === "string" ? bundledProfiles[source] : source;
    setNotice("");
    setError("");
    setJson(undefined);
    setEditing(
      duplicate || typeof source === "string"
        ? {
            ...structuredClone(base),
            name: `${base.name} copy`,
          }
        : structuredClone(base),
    );
  }

  async function save() {
    if (!editing) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      // Unparsed JSON text wins over the form: it is what the user is looking at, and
      // failing here reports the real reason rather than a generic "fix the JSON".
      const parsed = profileSchema.parse(
        json === undefined ? editing : JSON.parse(json),
      );
      resolveProfile(parsed);
      const saved = await loadModels();
      // Saving over an existing name replaces it; that is how a profile is renamed too.
      const next = [...saved.filter((p) => p.name !== parsed.name), parsed];
      await saveModels(next);
      reloadModels();
      useModel(parsed);
      setEditing(undefined);
      setJson(undefined);
      setNotice(`Saved ${parsed.name}.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove(name: string) {
    setBusy(true);
    try {
      const saved = await loadModels();
      await saveModels(saved.filter((p) => p.name !== name));
      reloadModels();
      setNotice(`Deleted ${name}.`);
      if (editing?.name === name) setEditing(undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setConfirming(undefined);
    }
  }

  const resolved = editing
    ? resolveProfile({ ...editing, name: editing.name || "Draft" })
    : undefined;

  return (
    <>
      <div className="section-heading">
        <div>
          <h1>Choose your way</h1>
          <p>Model for {active?.name ?? "your active track"}</p>
        </div>
        <Settings />
      </div>

      <div className="model-list">
        {PRESETS.map((p) => (
          <div key={p} className="model-row-wrap">
            <button
              className="model-row"
              aria-pressed={sameModel(p)}
              onClick={() => useModel(p)}
            >
              <Bike />
              <span>{p[0].toUpperCase() + p.slice(1)}</span>
              <i />
            </button>
            {/* Bundled presets are read-only, so editing one means copying it first. */}
            <button
              className="icon-button"
              aria-label={`Duplicate ${p}`}
              onClick={() => startEdit(p)}
            >
              <Plus size={16} />
            </button>
          </div>
        ))}
        {models.map((p) => (
          <div key={p.name} className="model-row-wrap">
            <button
              className="model-row"
              aria-pressed={sameModel(p)}
              onClick={() => useModel(p)}
            >
              <Mountain />
              <span>{p.name}</span>
              <i />
            </button>
            <button
              className="icon-button"
              aria-label={`Edit ${p.name}`}
              onClick={() => startEdit(p)}
            >
              <Settings size={16} />
            </button>
            <button
              className="icon-button"
              aria-label={`Delete ${p.name}`}
              onClick={() => setConfirming(p.name)}
            >
              <Trash2 size={16} />
            </button>
          </div>
        ))}
      </div>

      {confirming && (
        <div className="confirm" role="alertdialog">
          <span>{`Delete “${confirming}”?`}</span>
          <button onClick={() => setConfirming(undefined)}>Cancel</button>
          <button
            className="danger"
            disabled={busy}
            onClick={() => remove(confirming)}
          >
            Delete
          </button>
        </div>
      )}

      {notice && <p role="status">{notice}</p>}

      {editing && resolved ? (
        <section className="profile-editor-panel" aria-label="Edit profile">
          <div className="track-meta">
            <label>
              Model name
              <input
                value={editing.name}
                onChange={(e) =>
                  setEditing({ ...editing, name: e.target.value })
                }
              />
            </label>
            <label>
              Bike type
              <select
                value={editing.bike}
                onChange={(e) =>
                  setEditing({
                    ...editing,
                    bike: e.target.value as UserProfile["bike"],
                  })
                }
              >
                {BIKE_OPTIONS.map((b) => (
                  <option key={b.value} value={b.value}>
                    {b.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <ProfileForm
            draft={editing}
            resolved={resolved}
            onChange={setEditing}
          />

          <div className="profile-actions">
            <button
              className="primary"
              disabled={busy || !editing.name.trim()}
              onClick={save}
            >
              Save and use
            </button>
            <button onClick={() => setEditing(undefined)}>Cancel</button>
            <button
              onClick={() =>
                download(
                  `${editing.name.replace(/[^a-z0-9_-]/gi, "-")}.json`,
                  JSON.stringify(editing, null, 2) + "\n",
                  "application/json",
                )
              }
            >
              Export JSON
            </button>
          </div>

          <details>
            <summary>Profile JSON</summary>
            <textarea
              aria-label="Profile JSON"
              spellCheck={false}
              value={json ?? JSON.stringify(editing, null, 2)}
              onChange={(e) => {
                setJson(e.target.value);
                try {
                  setEditing(profileSchema.parse(JSON.parse(e.target.value)));
                  setError("");
                  setJson(undefined);
                } catch (err) {
                  // Half-typed JSON is normal; only a parsed-but-invalid profile is
                  // worth interrupting for.
                  setError(
                    err instanceof SyntaxError
                      ? ""
                      : err instanceof Error
                        ? err.message
                        : String(err),
                  );
                }
              }}
            />
          </details>
        </section>
      ) : (
        <label className="import-profile">
          Import profile JSON
          <input
            type="file"
            accept=".json,application/json"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (!file) return;
              try {
                if (file.size > 64_000)
                  throw new Error("Profile files must be smaller than 64 KB.");
                setEditing(profileSchema.parse(JSON.parse(await file.text())));
                setError("");
                setNotice("Imported. Save and use to apply.");
              } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
              }
            }}
          />
        </label>
      )}

      <p className="note">
        Each track keeps its own model settings. Editing a model leaves other
        tracks as they were.
      </p>

      {/* Diagnostics used to hang off the track editor, where opening a disclosure was
          what switched the debug layers on. They are settings, so they live here. */}
      <fieldset className="toggles">
        <legend>Inside the route</legend>
        <label>
          <input
            type="checkbox"
            checked={ctx.debug}
            onChange={(e) => ctx.setDebug(e.target.checked)}
          />
          Show routing diagnostics on the map
        </label>
        <label>
          <input
            type="checkbox"
            checked={ctx.history}
            onChange={(e) => ctx.setHistory(e.target.checked)}
          />
          Your rides · online reference layer
        </label>
        {ctx.debug &&
          (shownComparison ? (
            <>
              <p>
                Cost difference:{" "}
                {shownComparison.relativeCost === null
                  ? "unavailable"
                  : `${(shownComparison.relativeCost * 100).toFixed(1)}%`}
              </p>
              <p>
                Full graph: {shownComparison.reference.metrics.explored}{" "}
                explored · Corridor:{" "}
                {shownComparison.corridor.metrics.explored} explored
              </p>
              <button
                onClick={() =>
                  download(
                    "ibex-diagnostics.json",
                    JSON.stringify(shownComparison, null, 2),
                    "application/json",
                  )
                }
              >
                Export diagnostics
              </button>
            </>
          ) : (
            <p className="hint">
              Reprocess this track to inspect routing diagnostics.
            </p>
          ))}
      </fieldset>
    </>
  );
}
