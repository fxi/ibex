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
