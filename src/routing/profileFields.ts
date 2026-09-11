/**
 * Form controls for every editable profile field.
 *
 * The bounds here are the same constants the zod schemas in `./profiles.ts` validate
 * against, so a control can never offer a value the schema rejects. `tests/profileFields`
 * asserts the two stay in step: a new field with no descriptor fails the build's tests
 * rather than silently disappearing from the editor.
 */

export type Control =
  | { kind: "slider"; min: number; max: number; step: number }
  | { kind: "checkbox" }
  | { kind: "radio"; options: { value: string; label: string }[] }
  | { kind: "select"; options: { value: string; label: string }[] };

export type FieldGroup = "attraction" | "capabilities" | "access" | "costs";

export type Field = {
  key: string;
  label: string;
  control: Control;
  /** Why this field exists, in the language of riding rather than of cost models. */
  hint?: string;
  /** Fields that accept "no limit" as an explicit value, distinct from unset. */
  nullable?: boolean;
};

const attraction = (): Control => ({
  kind: "slider",
  min: 0,
  max: 100,
  step: 1,
});
const coefficient = (): Control => ({
  kind: "slider",
  min: 0,
  max: 1000,
  step: 1,
});
const discount = (): Control => ({
  kind: "slider",
  min: 0,
  max: 0.95,
  step: 0.05,
});
const grade = (): Control => ({ kind: "slider", min: 0, max: 100, step: 1 });

/** The 0-6 technical scales read better as a row of choices than as a slider. */
const scale = (labels: string[]): Control => ({
  kind: "radio",
  options: labels.map((label, value) => ({ value: String(value), label })),
});
const sacScale = () =>
  scale(["none", "T1", "T2", "T3", "T4", "T5", "T6"]);
const mtbScale = () => scale(["0", "1", "2", "3", "4", "5", "6"]);

const titleCase = (key: string) =>
  key.replaceAll("_", " ").replace(/^./, (c) => c.toUpperCase());

const sliders = (keys: string[], control: () => Control): Field[] =>
  keys.map((key) => ({ key, label: titleCase(key), control: control() }));

export const PROFILE_FIELDS: Record<FieldGroup, Field[]> = {
  attraction: [
    {
      key: "quiet",
      label: "Quiet roads",
      control: attraction(),
      hint: "Prefer roads away from traffic.",
    },
    {
      key: "countryside",
      label: "Countryside",
      control: attraction(),
      hint: "Prefer roads outside built-up areas.",
    },
    { key: "scenic", label: "Scenic", control: attraction() },
    { key: "climbing", label: "Climbing", control: attraction() },
    {
      key: "cycling_network",
      label: "Cycling network",
      control: attraction(),
      hint: "Prefer mapped cycle routes.",
    },
    { key: "offroad_up", label: "Offroad uphill", control: attraction() },
    { key: "offroad_down", label: "Offroad downhill", control: attraction() },
  ],
  capabilities: [
    {
      key: "max_grade_up",
      label: "Max grade up",
      control: grade(),
      nullable: true,
      hint: "Percent. No limit means any climb is acceptable.",
    },
    {
      key: "max_grade_down",
      label: "Max grade down",
      control: grade(),
      nullable: true,
      hint: "Percent. No limit means any descent is acceptable.",
    },
    { key: "max_mtb_scale_up", label: "Max MTB scale up", control: mtbScale() },
    {
      key: "max_mtb_scale_down",
      label: "Max MTB scale down",
      control: mtbScale(),
    },
    {
      key: "max_hike_sac_up",
      label: "Max hiking scale up",
      control: sacScale(),
      hint: "SAC hiking difficulty you will push a bike up.",
    },
    {
      key: "max_hike_sac_down",
      label: "Max hiking scale down",
      control: sacScale(),
    },
    { key: "paved_only", label: "Paved only", control: { kind: "checkbox" } },
    {
      key: "allow_unknown_paths",
      label: "Allow unknown paths",
      control: { kind: "checkbox" },
    },
    {
      key: "allow_rough_surfaces",
      label: "Allow rough surfaces",
      control: { kind: "checkbox" },
    },
    {
      key: "max_track_grade",
      label: "Max track grade",
      control: { kind: "slider", min: 1, max: 5, step: 1 },
      hint: "OSM tracktype: 1 is solid, 5 is soft ground.",
    },
    {
      key: "max_smoothness",
      label: "Max smoothness",
      control: { kind: "slider", min: 0, max: 6, step: 1 },
    },
  ],
  access: [
    {
      key: "hike_a_bike",
      label: "Hike-a-bike",
      control: { kind: "checkbox" },
      hint: "Allow pushing the bike where riding is not possible.",
    },
    {
      key: "steps",
      label: "Steps",
      control: { kind: "checkbox" },
      hint: "Steps require hike-a-bike permission.",
    },
    {
      key: "ferry",
      label: "Ferry",
      control: { kind: "checkbox" },
      hint: "Uses mapped services; check operating times before travelling.",
    },
  ],
  costs: [
    ...sliders(
      [
        "slope",
        "surface",
        "uncertainty",
        "graph_utility",
        "technical",
        "junction",
        "quiet_factor",
        "downhill_factor",
        "technical_up",
        "technical_down",
        "junction_meters",
        "countryside_factor",
        "cycling_network_factor",
        "ferry_factor",
        "ferry_second_meters",
        "ferry_boarding_meters",
      ],
      coefficient,
    ),
    {
      key: "slope_reference_grade",
      label: "Slope reference grade",
      control: { kind: "slider", min: 0.01, max: 1, step: 0.01 },
    },
    {
      key: "downhill_free_grade",
      label: "Downhill free grade",
      control: { kind: "slider", min: 0, max: 1, step: 0.01 },
    },
    ...sliders(
      ["scenic_discount", "climbing_discount", "offroad_discount"],
      discount,
    ),
    {
      key: "walking_factor",
      label: "Walking factor",
      control: { kind: "slider", min: 1, max: 1000, step: 1 },
    },
    {
      key: "steps_factor",
      label: "Steps factor",
      control: { kind: "slider", min: 1, max: 1000, step: 1 },
    },
  ],
};

export const BIKE_OPTIONS = [
  { value: "gravel", label: "Gravel" },
  { value: "road", label: "Road" },
  { value: "touring", label: "Touring" },
  { value: "scenic", label: "Scenic" },
];
