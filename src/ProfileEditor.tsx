import { useEffect, useState } from "react";
import { download } from "./gpx";
import { loadModels, saveModels } from "./models";
import {
  profileSchema,
  resolveProfile,
  type ProfileInput,
  type UserProfile,
} from "./routing/profiles";

function editable(input: ProfileInput): UserProfile {
  return typeof input === "string"
    ? { version: 1, name: `My ${input}`, bike: input }
    : structuredClone(input);
}
export function ProfileEditor({
  value,
  onChange,
}: {
  value: ProfileInput;
  onChange: (profile: ProfileInput) => void;
}) {
  const [draft, setDraft] = useState(() =>
    JSON.stringify(editable(value), null, 2),
  );
  const [saved, setSaved] = useState<UserProfile[]>([]);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => {
    setDraft(JSON.stringify(editable(value), null, 2));
    setError("");
  }, [value]);
  useEffect(() => {
    loadModels()
      .then((models) => {
        setSaved(models);
        setReady(true);
      })
      .catch((e) => setError(String(e)));
  }, []);
  function parse() {
    return profileSchema.parse(JSON.parse(draft));
  }
  async function save() {
    setError("");
    setNotice("");
    setBusy(true);
    try {
      const p = parse();
      resolveProfile(p);
      const next = [...saved.filter((old) => old.name !== p.name), p];
      await saveModels(next);
      setSaved(next);
      onChange(p);
      setNotice(`Saved ${p.name}.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  let parsed: UserProfile | undefined;
  try {
    parsed = JSON.parse(draft);
  } catch {
    /* Keep incomplete JSON editable. */
  }
  let resolved: ReturnType<typeof resolveProfile> | undefined;
  try {
    resolved = resolveProfile({ ...parsed!, name: parsed?.name || "Draft" });
  } catch {
    /* Validation is shown on save. */
  }
  function change(
    group: "attraction" | "capabilities" | "access",
    key: string,
    raw: string,
  ) {
    if (!parsed) return;
    const next = structuredClone(parsed);
    const fields = { ...next[group] } as Record<string, unknown>;
    if (raw === "") delete fields[key];
    else
      fields[key] =
        raw === "true"
          ? true
          : raw === "false"
            ? false
            : raw === "null"
              ? null
              : Number(raw);
    Object.assign(next, { [group]: fields });
    setDraft(JSON.stringify(next, null, 2));
  }
  return (
    <details className="profile-editor">
      <summary>
        Custom profile{typeof value === "string" ? "" : ` · ${value.name}`}
      </summary>
      <label>
        Saved profiles
        <select
          aria-label="Saved profiles"
          value={typeof value === "string" ? "" : value.name}
          onChange={(e) => {
            const p = saved.find((p) => p.name === e.target.value);
            if (p) onChange(p);
          }}
        >
          <option value="">Choose a saved profile</option>
          {saved.map((p) => (
            <option key={p.name} value={p.name}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <p>
        Attraction: 0 = neutral, 100 = strong. Grades are percentages; null
        means no limit. Omitted fields inherit bike defaults. Saving an existing
        name replaces it.
      </p>
      {parsed && resolved && (
        <div className="model-form">
          <label>
            Model name
            <input
              value={parsed.name}
              onChange={(e) =>
                setDraft(
                  JSON.stringify({ ...parsed, name: e.target.value }, null, 2),
                )
              }
            />
          </label>
          <label>
            Bike type
            <select
              value={parsed.bike}
              onChange={(e) =>
                setDraft(
                  JSON.stringify({ ...parsed, bike: e.target.value }, null, 2),
                )
              }
            >
              {["gravel", "road", "touring", "scenic"].map((b) => (
                <option key={b}>{b}</option>
              ))}
            </select>
          </label>
          {(["attraction", "capabilities", "access"] as const).map((group) => (
            <fieldset key={group}>
              <legend>{group}</legend>
              {Object.entries(resolved![group]).map(([key, fallback]) => {
                const own = (
                  parsed![group] as Record<string, unknown> | undefined
                )?.[key];
                const val = own === undefined ? "" : String(own);
                const label = key.replaceAll("_", " ");
                return (
                  <label key={key}>
                    {label}
                    {typeof fallback === "boolean" ? (
                      <select
                        aria-label={label}
                        value={val}
                        onChange={(e) => change(group, key, e.target.value)}
                      >
                        <option value="">Default ({String(fallback)})</option>
                        <option value="true">Allow</option>
                        <option value="false">Exclude</option>
                      </select>
                    ) : (
                      <input
                        aria-label={label}
                        value={val}
                        placeholder={`Default: ${fallback === null ? "no limit" : fallback}`}
                        onChange={(e) => change(group, key, e.target.value)}
                      />
                    )}
                    {key.startsWith("max_grade_") && (
                      <button
                        type="button"
                        onClick={() => change(group, key, "null")}
                      >
                        No limit
                      </button>
                    )}
                  </label>
                );
              })}
            </fieldset>
          ))}
        </div>
      )}
      <label htmlFor="profile-json">Profile JSON</label>
      <textarea
        id="profile-json"
        spellCheck={false}
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          setNotice("");
        }}
      />
      <div className="profile-actions">
        <button disabled={!ready || busy} onClick={save}>
          Save and use
        </button>
        <button
          onClick={() => {
            try {
              const p = parse();
              download(
                `${p.name.replace(/[^a-z0-9_-]/gi, "-")}.json`,
                JSON.stringify(p, null, 2) + "\n",
                "application/json",
              );
              setError("");
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
            }
          }}
        >
          Export JSON
        </button>
        <button
          onClick={() =>
            setDraft(JSON.stringify(resolveProfile(parse()), null, 2))
          }
          disabled={(() => {
            try {
              parse();
              return false;
            } catch {
              return true;
            }
          })()}
        >
          Show inherited fields
        </button>
      </div>
      <label>
        Import JSON
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
              const p = profileSchema.parse(JSON.parse(await file.text()));
              setDraft(JSON.stringify(p, null, 2));
              setError("");
              setNotice("Imported. Save and use to apply.");
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
            }
          }}
        />
      </label>
      <p>
        Countryside prefers roads outside built-up areas. Cycling network
        prefers mapped cycle routes. Steps require hike-a-bike permission. Ferry
        routes use mapped services; check their operating times before
        travelling.
      </p>
      {error && (
        <p role="alert" className="profile-error">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
    </details>
  );
}
