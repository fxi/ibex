import { SectionHeading } from "./SectionHeading";

/**
 * Notes along a track: the rider's own, and places found along the way — drinking water,
 * shops, bakeries. Import and export moved to the Tracks list menu to make room for it.
 */
export function NotesPanel() {
  return (
    <>
      <SectionHeading
        title="Notes"
        info="Notes along your tracks, and places to stop found along the way."
      />
      <div className="empty-state">
        <img src={`${import.meta.env.BASE_URL}icon.svg`} alt="" />
        Coming soon… Write notes along a track, and find drinking water,
        supermarkets and bakeries on the way.
      </div>
    </>
  );
}
