import {
  BIKE_FIELDS,
  BIKE_OPTIONS,
  PERMISSION_FIELDS,
  PREFERENCE_FIELDS,
  RIDER_FIELDS,
  RIDER_OPTIONS,
  SUSPENSION_OPTIONS,
  type NumberField,
} from "../routing/profileFields";
import {
  BIKE_PRESETS,
  CUSTOM,
  matchBike,
  matchRider,
  RIDER_PRESETS,
} from "../routing/presets";
import type { Bike, Profile } from "../routing/profiles";
import { compileProfile, describeCapability } from "../routing/compile";
import { LEVELS, type Level } from "../routing/vocabulary";

/**
 * The whole of a profile, in one form.
 *
 * The previous form had 45 controls across four groups, most of them raw cost
 * coefficients, and every value a rider had not touched showed as a greyed-out
 * "Inherited" with a number they could not see the origin of. There is nothing inherited
 * here: a profile is complete, so every control shows its own value. The capability
 * readout at the top is the other half of that — the bike and rider fields feed a model,
 * and the model says out loud what it concluded.
 */
export function ProfileForm({
  draft,
  onChange,
}: {
  draft: Profile;
  onChange: (next: Profile) => void;
}) {
  const bikePreset = matchBike(draft.setup.bike);
  const riderPreset = matchRider(draft.setup.rider);

  const setSetup = (setup: Partial<Profile["setup"]>) => {
    const next = { ...draft.setup, ...setup };
    onChange({
      ...draft,
      setup: {
        ...next,
        // The label follows the numbers. Change a tire width and the profile stops
        // claiming to be a preset it no longer matches.
        preset: describePreset(matchBike(next.bike), matchRider(next.rider)),
      },
    });
  };

  return (
    <div className="profile-form">
      <Capability draft={draft} />

      <details className="profile-group" open>
        <summary>Bike and rider</summary>
        <p className="group-note">
          These are not routing weights. They feed a model that works out what
          you can climb, descend and ride over, so you never have to name a
          maximum gradient.
        </p>
        <label className="field">
          <span className="field-label">Bike</span>
          <select
            aria-label="Bike"
            value={bikePreset}
            onChange={(e) =>
              e.target.value !== CUSTOM &&
              setSetup({ bike: { ...BIKE_PRESETS[e.target.value] } })
            }
          >
            {bikePreset === CUSTOM && <option value={CUSTOM}>Custom</option>}
            {BIKE_OPTIONS.map((id) => (
              <option key={id} value={id}>
                {id.replace(/_/g, " ")}
              </option>
            ))}
          </select>
        </label>
        {BIKE_FIELDS.map((f) => (
          <NumberRow
            key={f.key}
            field={f}
            value={draft.setup.bike[f.key] as number}
            onChange={(v) =>
              setSetup({ bike: { ...draft.setup.bike, [f.key]: v } })
            }
          />
        ))}
        <label className="field">
          <span className="field-label">Suspension</span>
          <select
            aria-label="Suspension"
            value={draft.setup.bike.suspension}
            onChange={(e) =>
              setSetup({
                bike: {
                  ...draft.setup.bike,
                  suspension: e.target.value as Bike["suspension"],
                },
              })
            }
          >
            {SUSPENSION_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span className="field-label">Rider</span>
          <select
            aria-label="Rider"
            value={riderPreset}
            onChange={(e) =>
              e.target.value !== CUSTOM &&
              setSetup({ rider: { ...RIDER_PRESETS[e.target.value] } })
            }
          >
            {riderPreset === CUSTOM && <option value={CUSTOM}>Custom</option>}
            {RIDER_OPTIONS.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </label>
        {RIDER_FIELDS.map((f) => (
          <NumberRow
            key={f.key}
            field={f}
            value={draft.setup.rider[f.key] as number}
            onChange={(v) =>
              setSetup({ rider: { ...draft.setup.rider, [f.key]: v } })
            }
          />
        ))}
      </details>

      <details className="profile-group" open>
        <summary>What you want from a route</summary>
        {PREFERENCE_FIELDS.map((f) => (
          <div className="field" key={f.key}>
            <span className="field-label">{f.label}</span>
            <LevelPicker
              name={f.key}
              value={draft.preferences[f.key]}
              onChange={(level) =>
                onChange({
                  ...draft,
                  preferences: { ...draft.preferences, [f.key]: level },
                })
              }
            />
            <span className="field-hint">{f.hint}</span>
          </div>
        ))}
      </details>

      <details className="profile-group" open>
        <summary>What you allow</summary>
        {PERMISSION_FIELDS.map((f) => (
          <label className="field field-check" key={f.key}>
            <input
              type="checkbox"
              aria-label={f.label}
              checked={draft.permissions[f.key]}
              onChange={(e) =>
                onChange({
                  ...draft,
                  permissions: {
                    ...draft.permissions,
                    [f.key]: e.target.checked,
                  },
                })
              }
            />
            <span className="field-label">{f.label}</span>
            <span className="field-hint">{f.hint}</span>
          </label>
        ))}
      </details>
    </div>
  );
}

const describePreset = (bike: string, rider: string) =>
  bike === CUSTOM || rider === CUSTOM ? CUSTOM : `${bike} / ${rider}`;

function Capability({ draft }: { draft: Profile }) {
  let lines: string[];
  try {
    lines = describeCapability(compileProfile(draft));
  } catch {
    return null;
  }
  return (
    <div className="capability-readout">
      {lines.map((line) => (
        <p key={line}>{line}</p>
      ))}
    </div>
  );
}

const LEVEL_LABELS: Record<Level, string> = {
  strongly_avoid: "Avoid ++",
  avoid: "Avoid",
  neutral: "Neutral",
  prefer: "Prefer",
  strongly_prefer: "Prefer ++",
};

function LevelPicker({
  name,
  value,
  onChange,
}: {
  name: string;
  value: Level;
  onChange: (level: Level) => void;
}) {
  return (
    <div className="level-picker" role="radiogroup" aria-label={name}>
      {LEVELS.map((level) => (
        <button
          key={level}
          type="button"
          role="radio"
          aria-checked={value === level}
          aria-label={LEVEL_LABELS[level]}
          className={value === level ? "level on" : "level"}
          onClick={() => onChange(level)}
        >
          {LEVEL_LABELS[level]}
        </button>
      ))}
    </div>
  );
}

function NumberRow<T>({
  field,
  value,
  onChange,
}: {
  field: NumberField<T>;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="field">
      <span className="field-label">{field.label}</span>
      <span className="field-control">
        <input
          type="range"
          aria-label={field.label}
          min={field.min}
          max={field.max}
          step={field.step}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
        />
        <output>
          {value}
          {field.unit ? ` ${field.unit}` : ""}
        </output>
      </span>
      <span className="field-hint">{field.hint}</span>
    </label>
  );
}
