import { useEffect, useState } from "react";
import { Settings, Bike, Mountain, Plus, Trash2 } from "lucide-react";
import { download } from "../gpx";
import { loadModels, saveModels, shippedProfiles } from "../models";
import { freshResult, modelSnapshot } from "../tracks";
import {
  newProfileId,
  parseProfile,
  serializeProfile,
  type Profile,
} from "../routing/profiles";
import { ProfileForm } from "./ProfileForm";
import { HEATMAP_URL } from "../config";
import { APP_VERSION } from "../version";
import type { PanelContext } from "./context";
import { Modal } from "./Modal";
import { SectionHeading } from "./SectionHeading";

/** A file name for an exported profile. The id is a UUID, so it comes from the name. */
const fileName = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "profile";

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
  const applyModel = (p: Profile) => edit({ profile: modelSnapshot(p) });

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
            id: newProfileId(),
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
      applyModel(parsed);
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
      <SectionHeading
        title="Choose your way"
        info={`Model for ${active?.name ?? "your active track"}`}
      />

      {/* An open draft holds the list: picking, editing or deleting another model would
          leave the editor showing one model while the track uses another, or drop the
          draft's changes. Save or Cancel releases it. */}
      {editing && (
        <p className="hint">Save or cancel the edit to choose another model.</p>
      )}
      <div className="model-list">
        {[
          ...shipped.filter((p) => !models.some((q) => q.id === p.id)),
          ...models,
        ].map((p) => (
          <div key={p.id} className="model-row-wrap">
            <button
              className="model-row"
              aria-pressed={sameModel(p)}
              disabled={!!editing}
              onClick={() => applyModel(p)}
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
                disabled={!!editing}
                onClick={() => startEdit(p, true)}
              >
                <Plus size={16} />
              </button>
            ) : (
              <>
                <button
                  className="icon-button"
                  aria-label={`Edit ${p.name}`}
                  disabled={!!editing}
                  onClick={() => startEdit(p)}
                >
                  <Settings size={16} />
                </button>
                <button
                  className="icon-button"
                  aria-label={`Delete ${p.name}`}
                  disabled={!!editing}
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
        <Modal
          alert
          title={`Delete “${models.find((p) => p.id === confirming)?.name ?? confirming}”?`}
          onClose={() => setConfirming(undefined)}
        >
          <p>Tracks planned with it keep their own copy.</p>
          <div className="modal-actions">
            <button onClick={() => setConfirming(undefined)}>Cancel</button>
            <button
              className="danger"
              disabled={busy}
              onClick={() => remove(confirming)}
            >
              <Trash2 size={16} /> Delete
            </button>
          </div>
        </Modal>
      )}

      {notice && <p role="status">{notice}</p>}
      {/* Changing the model does not route again, and the map keeps drawing the old line:
          without this it passes for the new one. */}
      {active?.result && !freshResult(active) && (
        <p className="hint">
          The route on the map is out of date: it was computed before the last
          change of profile or waypoints. Compute it again from Edit.
        </p>
      )}

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
                  `${fileName(editing.name)}.profile.json`,
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
        {HEATMAP_URL && (
          <label>
            <input
              type="checkbox"
              checked={ctx.history}
              onChange={(e) => ctx.setHistory(e.target.checked)}
            />
            Your rides · online reference layer
          </label>
        )}
        {ctx.debug &&
          (shownComparison ? (
            <>
              {shownComparison.relativeCost !== null && (
                <p>
                  Corridor cost difference:{" "}
                  {`${(shownComparison.relativeCost * 100).toFixed(1)}%`}
                </p>
              )}
              <p>
                Search: {shownComparison.reference.metrics.explored} states
                explored
                {" · "}
                {Math.round(shownComparison.reference.metrics.durationMs)} ms
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
      <p className="hint">Ibex {APP_VERSION}</p>
    </>
  );
}
