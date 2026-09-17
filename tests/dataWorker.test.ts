import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Installed } from "../src/offline/store";

/**
 * The data worker's message contract, which the Data tab depends on and no browser test
 * reaches: the fixture release has a single cell, so bulk removal cannot be exercised
 * end to end. Regression: removals were acknowledged without saying which pack they were
 * for, so a bulk remove left every pack but the last listed as ready — and routable —
 * with its files already deleted.
 */
const removed: Installed[] = [];
let installs: ((signal: AbortSignal) => Promise<Installed>)[] = [];

vi.mock("../src/offline/store", () => ({
  installPack: (
    _url: string,
    _progress: (fraction: number) => void,
    signal: AbortSignal,
  ) => installs.shift()!(signal),
  listPacks: async () => [],
  removePack: async (pack: Installed) => {
    removed.push(pack);
  },
}));

const pack = (id: string) =>
  ({ manifest: { id }, directory: id }) as unknown as Installed;

type Posted = { type: string; cell?: string; aborted?: boolean; id: number };

const started = () => {
  const posted: Posted[] = [];
  const worker = globalThis as unknown as {
    self?: unknown;
    onmessage?: (event: { data: unknown }) => void;
    postMessage: (message: Posted) => void;
  };
  // The module is written against the worker global; in Node that is this realm.
  worker.self = globalThis;
  worker.onmessage = undefined;
  worker.postMessage = (message) => posted.push(message);
  return { posted, send: (data: unknown) => worker.onmessage!({ data }) };
};

beforeEach(() => {
  removed.length = 0;
  installs = [];
  vi.resetModules();
});

describe("data worker", () => {
  it("names the pack in every removal it acknowledges", async () => {
    const { posted, send } = started();
    await import("../src/workers/data.worker");
    for (const id of ["9-264-181", "9-265-181", "9-266-181"])
      send({ id: 2, type: "remove", pack: pack(id) });
    await vi.waitFor(() => expect(posted).toHaveLength(3));

    expect(removed.map((p) => p.manifest.id)).toEqual([
      "9-264-181",
      "9-265-181",
      "9-266-181",
    ]);
    expect(posted.map((m) => m.cell)).toEqual([
      "9-264-181",
      "9-265-181",
      "9-266-181",
    ]);
  });

  it("runs one job at a time, so removals finish before an install measures storage", async () => {
    const { posted, send } = started();
    await import("../src/workers/data.worker");
    let release!: () => void;
    const slow = new Promise<void>((resolve) => (release = resolve));
    let installedWhileRemoving = false;
    installs = [
      async () => {
        installedWhileRemoving = removed.length === 0;
        return pack("installed");
      },
    ];

    send({ id: 2, type: "remove", pack: pack("9-264-181") });
    send({ id: 1, type: "install", url: "https://example.test/manifest.json" });
    release();
    await slow;
    await vi.waitFor(() => expect(posted).toHaveLength(2));

    expect(installedWhileRemoving).toBe(false);
    expect(posted.map((m) => m.type)).toEqual(["removed", "installed"]);
  });

  it("drops an install still queued behind another job when it is cancelled", async () => {
    const { posted, send } = started();
    await import("../src/workers/data.worker");
    let ran = false;
    installs = [
      async () => {
        ran = true;
        return pack("installed");
      },
    ];

    send({ id: 2, type: "remove", pack: pack("9-264-181") });
    send({ id: 1, type: "install", url: "https://example.test/manifest.json" });
    send({ id: 1, type: "cancel" });
    await vi.waitFor(() => expect(posted).toHaveLength(1));

    expect(posted[0].type).toBe("removed");
    expect(ran).toBe(false);
  });

  it("marks a cancelled install as aborted rather than a plain failure", async () => {
    const { posted, send } = started();
    await import("../src/workers/data.worker");
    installs = [
      (signal) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener("abort", () =>
            reject(new Error("signal is aborted without reason")),
          ),
        ),
    ];

    send({ id: 1, type: "install", url: "https://example.test/manifest.json" });
    send({ id: 1, type: "cancel" });
    await vi.waitFor(() => expect(posted).toHaveLength(1));

    expect(posted[0].type).toBe("error");
    expect(posted[0].aborted).toBe(true);
  });
});
