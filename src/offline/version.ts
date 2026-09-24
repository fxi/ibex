/**
 * The one compatibility number for published routing data. See docs/data-format.md.
 *
 * Bump it for any change an existing reader cannot read correctly: the catalogue or
 * manifest schema, the `.ibx` binary layout, or what a stored value means to the cost
 * model. Additive optional fields do not bump it. Each value publishes under its own
 * `v<DATA_VERSION>/` prefix, so a deployed app keeps reading the data it was built for,
 * and cells installed under another value are removed on start-up.
 */
export const DATA_VERSION = 1;

/**
 * The generation a built cell belongs to.
 *
 * Cells are built one at a time, from whatever OpenStreetMap said that day, and they have
 * to route together anyway — so the thing that decides whether two packs can be joined is
 * not when they were made but what made them. Raise this whenever a cell built by the old
 * builder would disagree with one built by the new: the cost model, the tag rules, the
 * split rule, the block layout. Cells carrying different generations are never mixed.
 *
 * It replaces the release id, which pinned a cell to one publishing run and made a cell
 * downloaded on Tuesday refuse to route beside one downloaded on Wednesday.
 */
export const BUILD_VERSION = 3;

/** The generation as it is written into a pack header and a catalogue. */
export const GENERATION = `b${BUILD_VERSION}`;
