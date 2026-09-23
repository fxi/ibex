/**
 * Take up a new service worker the moment it takes control.
 *
 * `autoUpdate` (vite.config.ts) makes a new worker activate and claim open pages by itself,
 * but the page keeps running the JavaScript it already parsed. That is the difference
 * between an app that is merely out of date and one that is broken: packs carry a
 * `GENERATION` the reader has to match and cell files are addressed by the hash of their
 * bytes, so a stale bundle cannot read anything the bucket holds. It shows up as an old
 * interface that downloads no data at all.
 *
 * Only a page that was already controlled reloads. The first registration claims the page
 * too, and reloading there would be a flash on a first visit for no reason.
 */
export function reloadOnNewWorker(): void {
  if (!("serviceWorker" in navigator)) return;
  if (!navigator.serviceWorker.controller) return;
  let reloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    // `controllerchange` can fire more than once; reloading twice would be a loop.
    if (reloading) return;
    reloading = true;
    window.location.reload();
  });
}
