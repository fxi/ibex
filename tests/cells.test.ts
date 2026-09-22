import { describe, expect, it } from "vitest";
import {
  CELL_COLORS,
  cellState,
  nextIntent,
  type CellIntent,
  type CellState,
} from "../src/offline/cells";
import type { CatalogueCell } from "../src/offline/catalogue";
import type { Installed } from "../src/offline/store";

const ID = "9-264-181";
const cell = (overrides: Partial<CatalogueCell> = {}): CatalogueCell =>
  ({
    id: ID,
    x: 264,
    y: 181,
    bbox: [5.625, 46.07, 6.328, 46.56],
    hash: "abcdef0123456789",
    bytes: 4096,
    ...overrides,
  }) as CatalogueCell;

const pack = (hash = "abcdef0123456789"): Installed =>
  ({
    manifest: { id: ID, hash },
    installedAt: "1970-01-01T00:00:00.000Z",
    directory: "9-264-181",
    backend: "idb",
  }) as unknown as Installed;

/** Walk the cycle from "nothing pending" until it returns there. */
function cycle(held: boolean) {
  const seen: (CellIntent | undefined)[] = [];
  let current: CellIntent | undefined = undefined;
  for (let i = 0; i < 6; i++) {
    current = nextIntent(held, current);
    seen.push(current);
    if (current === undefined) break;
  }
  return seen;
}

describe("cell intent cycle", () => {
  it("offers only adding for a cell that is not installed", () => {
    expect(cycle(false)).toEqual(["add", undefined]);
  });

  it("offers refresh then remove for an installed cell, then clears", () => {
    expect(cycle(true)).toEqual(["refresh", "remove", undefined]);
  });

  it("returns to no pending change however many times it is clicked", () => {
    for (const held of [false, true]) {
      let current: CellIntent | undefined = undefined;
      const length = held ? 3 : 2;
      for (let i = 0; i < length * 3; i++) current = nextIntent(held, current);
      expect(current).toBeUndefined();
    }
  });
});

describe("cell state", () => {
  it("shows a pending intent over the installed state", () => {
    const intents = new Map<string, CellIntent>([["9-264-181", "remove"]]);
    expect(cellState(ID, cell(), pack(), { intents })).toBe(
      "marked-remove",
    );
    expect(
      cellState(ID, cell(), pack(), {
        intents: new Map([["9-264-181", "refresh"]]),
      }),
    ).toBe("marked-refresh");
  });

  it("shows an add intent only for a cell that is not installed", () => {
    const intents = new Map<string, CellIntent>([["9-264-181", "add"]]);
    expect(cellState(ID, cell(), undefined, { intents })).toBe("selected");
    // An installed cell can never read as merely "selected".
    expect(cellState(ID, cell(), pack(), { intents })).toBe("installed");
  });

  it("keeps in-flight activity ahead of intent", () => {
    const intents = new Map<string, CellIntent>([["9-264-181", "remove"]]);
    expect(
      cellState(ID, cell(), pack(), {
        intents,
        downloading: "9-264-181",
      }),
    ).toBe("downloading");
    expect(
      cellState(ID, cell(), pack(), {
        intents,
        failed: new Map([["9-264-181", "boom"]]),
      }),
    ).toBe("failed");
  });

  it("reports update-available when the catalogue offers different bytes", () => {
    expect(cellState(ID, cell(), pack("0000000000000000"))).toBe("update-available");
    // Nothing has built this cell yet: the grid still draws it, greyed.
    expect(cellState(ID, undefined, undefined)).toBe("unavailable");
    // Installed but no longer offered — still usable, never "unavailable".
    expect(cellState(ID, undefined, pack())).toBe("installed");
  });

  it("gives every state a paint colour", () => {
    const states: CellState[] = [
      "unavailable",
      "available",
      "selected",
      "queued",
      "downloading",
      "installed",
      "update-available",
      "marked-refresh",
      "marked-remove",
      "failed",
    ];
    for (const state of states) expect(CELL_COLORS[state]).toMatch(/^#[0-9a-f]{6}$/i);
    expect(Object.keys(CELL_COLORS).sort()).toEqual([...states].sort());
  });
});
