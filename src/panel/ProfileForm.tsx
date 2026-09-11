import {
  PROFILE_FIELDS,
  type Field,
  type FieldGroup,
} from "../routing/profileFields";
import type { ResolvedProfile, UserProfile } from "../routing/profiles";

const GROUP_LABELS: Record<FieldGroup, string> = {
  attraction: "What draws you",
  capabilities: "What you can ride",
  access: "What you allow",
  costs: "Cost model (advanced)",
};

type Group = Record<string, unknown>;

/**
 * Every field is three-state: unset (inherit the bike default), an explicit value, or —
 * for a couple of limits — an explicit "no limit". Unset is not the same as the default
 * value: it tracks the preset if the preset later changes.
 */
export function ProfileForm({
  draft,
  resolved,
  onChange,
}: {
  draft: UserProfile;
  resolved: ResolvedProfile;
  onChange: (next: UserProfile) => void;
}) {
  function set(group: FieldGroup, key: string, value: unknown) {
    const next = structuredClone(draft) as UserProfile & Record<string, Group>;
    const fields = { ...((next[group] as Group) ?? {}) };
    if (value === undefined) delete fields[key];
    else fields[key] = value;
    if (Object.keys(fields).length) next[group] = fields;
    else delete next[group];
    onChange(next);
  }

  return (
    <div className="profile-form">
      {(Object.keys(PROFILE_FIELDS) as FieldGroup[]).map((group) => (
        <details key={group} open={group !== "costs"}>
          <summary>{GROUP_LABELS[group]}</summary>
          {PROFILE_FIELDS[group].map((field) => (
            <FieldRow
              key={field.key}
              field={field}
              group={group}
              own={(draft[group] as Group | undefined)?.[field.key]}
              fallback={(resolved[group] as Group)[field.key]}
              onSet={(value) => set(group, field.key, value)}
            />
          ))}
        </details>
      ))}
    </div>
  );
}

function FieldRow({
  field,
  group,
  own,
  fallback,
  onSet,
}: {
  field: Field;
  group: FieldGroup;
  own: unknown;
  fallback: unknown;
  onSet: (value: unknown) => void;
}) {
  const id = `${group}-${field.key}`;
  const inherited = own === undefined;
  const effective = inherited ? fallback : own;
  const describedBy = field.hint ? `${id}-hint` : undefined;

  return (
    <div className={`field ${inherited ? "inherited" : ""}`}>
      <div className="field-head">
        <label htmlFor={id}>{field.label}</label>
        {!inherited && (
          <button
            type="button"
            className="link"
            onClick={() => onSet(undefined)}
          >
            Reset
          </button>
        )}
      </div>

      {field.control.kind === "checkbox" ? (
        <input
          id={id}
          type="checkbox"
          aria-describedby={describedBy}
          checked={effective === true}
          onChange={(e) => onSet(e.target.checked)}
        />
      ) : field.control.kind === "radio" || field.control.kind === "select" ? (
        <select
          id={id}
          aria-describedby={describedBy}
          value={String(effective ?? "")}
          onChange={(e) => onSet(Number(e.target.value))}
        >
          {field.control.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      ) : (
        (() => {
          const slider = field.control;
          return (
            <div className="slider-row">
              <input
                id={id}
                type="range"
                aria-describedby={describedBy}
                min={slider.min}
                max={slider.max}
                step={slider.step}
                // A null limit has no position on the scale; park it at the maximum.
                value={Number(effective ?? slider.max)}
                disabled={effective === null}
                onChange={(e) => onSet(Number(e.target.value))}
              />
              <output htmlFor={id}>
                {effective === null ? "no limit" : String(effective)}
              </output>
              {field.nullable && (
                <button
                  type="button"
                  className="link"
                  onClick={() =>
                    onSet(
                      effective === null
                        ? typeof fallback === "number"
                          ? fallback
                          : slider.max
                        : null,
                    )
                  }
                  aria-pressed={effective === null}
                >
                  {effective === null ? "Set a limit" : "No limit"}
                </button>
              )}
            </div>
          );
        })()
      )}

      {field.hint && (
        <small id={describedBy} className="field-hint">
          {field.hint}
        </small>
      )}
      {inherited && <small className="field-inherited">Inherited</small>}
    </div>
  );
}
