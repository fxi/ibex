import { test as base, expect } from "@playwright/test";
export { expect };
// Empty vector tiles and a transparent sprite retain the production style schema.
export const test = base.extend<{ mapResources: void }>({
  mapResources: [
    async ({ context }, use) => {
      await context.route("https://api.maptiler.com/**", async (route) => {
        const url = new URL(route.request().url());
        expect(url.pathname).not.toMatch(/\/style\.json$/);
        expect(url.searchParams.get("key")).toBe(
          "cyclatractor-browser-test-key",
        );
        if (url.pathname.endsWith("tiles.json")) {
          await route.fulfill({
            json: {
              tilejson: "3.0.0",
              tiles: ["https://api.maptiler.com/test/{z}/{x}/{y}.pbf"],
              minzoom: url.pathname.includes("terrain-rgb") ? 24 : 0,
              maxzoom: 24,
              bounds: [-180, -85, 180, 85],
            },
          });
        } else if (url.pathname.endsWith(".json")) {
          await route.fulfill({ json: {} });
        } else if (url.pathname.endsWith(".png")) {
          await route.fulfill({
            contentType: "image/png",
            body: Buffer.from(
              "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
              "base64",
            ),
          });
        } else {
          await route.fulfill({
            contentType: "application/x-protobuf",
            body: Buffer.alloc(0),
          });
        }
      });
      await use();
    },
    { auto: true },
  ],
});
