import { expect, it } from "vitest";
import { customStyleURL } from "../src/map/style";
it("uses the configured MapTiler key without corrupting URL query parameters", () => {
  expect(customStyleURL(undefined)).toBeUndefined();
  expect(customStyleURL("   ")).toBeUndefined();
  const url = new URL(customStyleURL(" test+key&value ")!);
  expect(url.pathname).toBe(
    "/maps/01984598-44d5-70a4-b028-6ce2d6f3027a/style.json",
  );
  expect(url.searchParams.get("key")).toBe("test+key&value");
  expect([...url.searchParams]).toHaveLength(1);
});
