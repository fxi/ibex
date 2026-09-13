import { useEffect, useState } from "react";
import { Settings, Bike, Mountain, Plus, Trash2 } from "lucide-react";
import { download } from "../gpx";
import { loadModels, saveModels, shippedProfiles } from "../models";
import { modelSnapshot } from "../tracks";
import {
  parseProfile,
  serializeProfile,
  type Profile,
} from "../routing/profiles";
import { ProfileForm } from "./ProfileForm";
import type { PanelContext } from "./context";

/** Keep a duplicated profile from colliding with one that already exists. */
function uniqueId(base: string, existing: { id: string }[]): string {
  let id = base;
  for (let n = 2; existing.some((p) => p.id === id); n++) id = `${base}_${n}`;
  return id;
}

export function ConfigurePanel({ ctx }: { ctx: PanelContext }) {
  const { tracks, routing, models, reloadModels, setError } = ctx;
  const { active, edit } = tracks;
  const [editing, setEditing] = useState<Profile>();
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

  // Compared through the canonical serializer rather than raw `JSON.stringify`, so two
  // identical profiles built in a different field order still count as the same model.
  const sameModel = (p: Profile) =>
    !!active && serializeProfile(p) === serializeProfile(active.profile);
  const useModel = (p: Profile) => edit({ profile: modelSnapshot(p) });

  const shipped = shippedProfiles();
  const isShipped = (p: Profile) => shipped.some((q) => q.id === p.id);

  function startEdit(source: Profile, duplicate = false) {
    setNotice("");
    setError("");
    setJson(undefined);
    setEditing(
      duplicate
        ? {
            ...structuredClone(source),
            id: uniqueId(`${source.id}_copy`, [...shipped, ...models]),
            name: `${source.name} copy`,
          }
        : structuredClone(source),
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
      const parsed = parseProfile(
        json === undefined ? editing : JSON.parse(json),
      );
      const saved = await loadModels();
      // Saving over an existing id replaces it; that is how a profile is renamed too.
      const next = [
        ...saved.filter((p) => p.id !== parsed.id && !isShipped(p)),
        parsed,
      ];
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

  async function remove(id: string) {
    setBusy(true);
    try {
      const saved = await loadModels();
      await saveModels(saved.filter((p) => p.id !== id && !isShipped(p)));
      reloadModels();
      setNotice("Deleted.");
      if (editing?.id === id) setEditing(undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setConfirming(undefined);
    }
  }

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
        {[
          ...shipped.filter((p) => !models.some((q) => q.id === p.id)),
          ...models,
        ].map((p) => (
          <div key={p.id} className="model-row-wrap">
            <button
              className="model-row"
              aria-pressed={sameModel(p)}
              onClick={() => useModel(p)}
              title={p.description}
            >
              {isShipped(p) ? <Bike /> : <Mountain />}
              <span>{p.name}</span>
              <i />
            </button>
            {/* A shipped profile is read-only, so editing one means copying it first. */}
            {isShipped(p) ? (
              <button
                className="icon-button"
                aria-label={`Duplicate ${p.name}`}
                onClick={() => startEdit(p, true)}
              >
                <Plus size={16} />
              </button>
            ) : (
              <>
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
                  onClick={() => setConfirming(p.id)}
                >
                  <Trash2 size={16} />
                </button>
              </>
            )}
          </div>
        ))}
      </div>

      {confirming && (
        <div className="confirm" role="alertdialog">
          <span>{`Delete “${models.find((p) => p.id === confirming)?.name ?? confirming}”?`}</span>
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

      {editing ? (
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
              Profile id
              <input
                value={editing.id}
                aria-label="Profile id"
                onChange={(e) =>
                  setEditing({ ...editing, id: e.target.value.trim() })
                }
              />
            </label>
          </div>

          <ProfileForm draft={editing} onChange={setEditing} />

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
                  `${editing.id}.profile.json`,
                  serializeProfile(editing) + "\n",
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
              value={json ?? serializeProfile(editing)}
              onChange={(e) => {
                setJson(e.target.value);
                try {
                  setEditing(parseProfile(JSON.parse(e.target.value)));
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
                setEditing(parseProfile(JSON.parse(await file.text())));
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
                Corridor cost difference:{" "}
                {shownComparison.relativeCost === null
                  ? "unavailable"
                  : `${(shownComparison.relativeCost * 100).toFixed(1)}%`}
              </p>
              {shownComparison.exploration?.experience && (
                <p>
                  Scenic detours:{" "}
                  {shownComparison.exploration.experience.candidates} checked
                  {shownComparison.exploration.experience.scenicBonus > 0
                    ? " · scenic destination included"
                    : " · original route retained"}
                </p>
              )}
              <p>
                Full graph: {shownComparison.reference.metrics.explored}{" "}
                explored · Corridor: {shownComparison.corridor.metrics.explored}{" "}
                explored
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
