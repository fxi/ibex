import { SURFACE_STYLE } from "../map/rideStyle";
import { ProfileSample, SurfaceSample } from "./SurfaceSample";
import type { PanelContext } from "./context";
import { SectionHeading } from "./SectionHeading";

/**
 * What the map is saying, in one place.
 *
 * The panel exists because the symbology is deliberately two-channel and that is not
 * self-evident: colour answers "which track is this", pattern answers "what is it made
 * of". Stating it once, with live samples, is cheaper than making every stripe guessable.
 */
export function SymbologyPanel({ ctx }: { ctx: PanelContext }) {
  const tracks = ctx.tracks.collection?.tracks ?? [];
  const activeId = ctx.tracks.active?.id;
  const sample = ctx.tracks.active?.color ?? "#2f7df6";

  return (
    <>
      <SectionHeading
        title="Symbology"
        info={
          <>
            Colour is <b>which track</b>. Pattern is <b>what it is made of</b>.
            A clean line is sealed road; the centre line breaks up as the surface
            does.
          </>
        }
      />

      <h3 className="symbology-title">Track colours</h3>
      {tracks.length ? (
        <ul className="symbology-tracks">
          {tracks.map((t) => (
            <li key={t.id}>
              <i style={{ background: t.color }} />
              <span>{t.name}</span>
              <small>
                {t.visible ? "" : "hidden · "}
                {t.id === activeId ? "active — drawn heaviest" : ""}
              </small>
            </li>
          ))}
        </ul>
      ) : (
        <p className="hint">
          No visible tracks yet. Each new track takes the next colour in the
          palette, and any track's colour can be changed on its card.
        </p>
      )}
      <p className="hint">
        The palette holds no yellow, orange or red: those are kept for how hard
        or how busy a stretch is, so a warning is never mistaken for a name.
      </p>

      <h3 className="symbology-title">Surface — the centre line</h3>
      <ul className="symbology-list">
        {SURFACE_STYLE.map((s) => (
          <li key={s.ride}>
            <SurfaceSample ride={s.ride} color={sample} />
            <div>
              <strong>{s.label}</strong>
              <p>{s.note}</p>
            </div>
          </li>
        ))}
      </ul>

      <h3 className="symbology-title">Surface — under the elevation curve</h3>
      <p className="hint">
        The profile is filled with the same classes, hatched denser as the going
        worsens, so a carry shows up as a block of orange on the climb it
        belongs to.
      </p>
      <ul className="symbology-list compact">
        {SURFACE_STYLE.map((s) => (
          <li key={s.ride}>
            <ProfileSample ride={s.ride} color={sample} />
            <div>
              <strong>{s.label}</strong>
            </div>
          </li>
        ))}
      </ul>

      <details>
        <summary>Where the classes come from</summary>
        <p>
          Every class is read off OSM tags on the way the router chose:{" "}
          <code>surface</code>, <code>tracktype</code> and the road hierarchy,
          plus this profile's own limits for what counts as rideable. Roughly
          three quarters of ways carry no <code>surface</code> tag at all, so the
          hierarchy fills the gap — a residential street is taken as sealed, a
          forest track as gravel — and only a path with nothing at all to go on is
          left as unknown.
        </p>
      </details>
    </>
  );
}
