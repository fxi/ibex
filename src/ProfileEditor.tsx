import { useEffect, useState } from "react";
import { download } from "./gpx";
import { preference, savePreference } from "./offline/store";
import {
  profileSchema,
  resolveProfile,
  type ProfileInput,
  type UserProfile,
} from "./routing/profiles";

const profileFiles = import.meta.glob("../profiles/*.json", {
  eager: true,
  import: "default",
});
function shippedProfiles() {
  return Object.entries(profileFiles)
    .filter(
      ([path]) => !/\/(master|gravel|road|touring|scenic)\.json$/.test(path),
    )
    .map(([, value]) => profileSchema.parse(value));
}
function editable(input: ProfileInput) {
  if (typeof input !== "string") return input;
  const p = resolveProfile(input);
  return {
    version: 1,
    name: `My ${input}`,
    bike: input,
    attraction: p.attraction,
    capabilities: {
      max_grade_up: p.capabilities.max_grade_up,
      max_grade_down: p.capabilities.max_grade_down,
      max_mtb_scale_up: p.capabilities.max_mtb_scale_up,
      max_mtb_scale_down: p.capabilities.max_mtb_scale_down,
      max_hike_sac_up: p.capabilities.max_hike_sac_up,
      max_hike_sac_down: p.capabilities.max_hike_sac_down,
    },
    access: p.access,
  };
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
    preference<unknown>("routing-profiles")
      .then((data) => {
        if (data !== undefined && !Array.isArray(data))
          throw new Error("Saved profile collection is invalid.");
        const local = ((data ?? []) as unknown[]).map((p) =>
          profileSchema.parse(p),
        );
        setSaved([
          ...shippedProfiles().filter(
            (p) => !local.some((q) => q.name === p.name),
          ),
          ...local,
        ]);
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
      await savePreference("routing-profiles", next);
      setSaved(next);
      onChange(p);
      setNotice(`Saved ${p.name}.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
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
