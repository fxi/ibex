/**
 * The app and its data are version-locked, so a page left on an old bundle after its
 * worker updated is broken, not merely stale. These pin the two halves of that: a page
 * that was already controlled reloads, and a first visit does not.
 */
import { afterEach, expect, it, vi } from "vitest";
import { reloadOnNewWorker } from "../src/serviceWorker";

type Listener = () => void;

function fakeBrowser(controller: object | null) {
  const listeners: Listener[] = [];
  const reload = vi.fn();
  vi.stubGlobal("navigator", {
    serviceWorker: {
      controller,
      addEventListener: (type: string, fn: Listener) => {
        if (type === "controllerchange") listeners.push(fn);
      },
    },
  });
  vi.stubGlobal("window", { location: { reload } });
  return { fire: () => listeners.forEach((fn) => fn()), reload, listeners };
}

afterEach(() => vi.unstubAllGlobals());

it("reloads a controlled page once when a new worker takes over", () => {
  const { fire, reload } = fakeBrowser({});
  reloadOnNewWorker();
  fire();
  expect(reload).toHaveBeenCalledTimes(1);
  // A second event must not reload again: that is a refresh loop.
  fire();
  expect(reload).toHaveBeenCalledTimes(1);
});

it("does not reload on a first visit, where the first worker claims the page", () => {
  const { fire, reload, listeners } = fakeBrowser(null);
  reloadOnNewWorker();
  expect(listeners).toHaveLength(0);
  fire();
  expect(reload).not.toHaveBeenCalled();
});

it("does nothing where the browser has no service worker at all", () => {
  vi.stubGlobal("navigator", {});
  expect(() => reloadOnNewWorker()).not.toThrow();
});
