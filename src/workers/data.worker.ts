/// <reference lib="webworker" />
import {
  installPack,
  listPacks,
  removePack,
  type Installed,
  type Manifest,
} from "../offline/store";

type Job =
  | {
      id: number;
      type: "install";
      manifest: Manifest;
      /** Where each file is served from; the names it is stored under are in the manifest. */
      sources: Record<string, string>;
    }
  | { id: number; type: "list" }
  | { id: number; type: "remove"; pack: Installed }
  | { id: number; type: "cancel" };

const controllers = new Map<number, AbortController>();
// An async `onmessage` does not serialise: a job suspended on a download does not stop the
// next message from dispatching. Running one at a time is what makes "remove these, then
// install those" free the space before the install measures it, which is the whole point
// of processing removals first on a nearly full device.
const pending: Exclude<Job, { type: "cancel" }>[] = [];
let running = false;

self.onmessage = (event: MessageEvent<Job>) => {
  const message = event.data;
  // Cancelling must not wait behind the queue: it aborts the job in flight and drops the
  // ones not started, which would otherwise run on after the user cancelled them.
  if (message.type === "cancel") {
    controllers.get(message.id)?.abort();
    for (let i = pending.length - 1; i >= 0; i--)
      if (pending[i].id === message.id) pending.splice(i, 1);
    return;
  }
  pending.push(message);
  void pump();
};

async function pump() {
  if (running) return;
  running = true;
  try {
    let next;
    while ((next = pending.shift())) await run(next);
  } finally {
    running = false;
  }
}

async function run(message: Exclude<Job, { type: "cancel" }>) {
  const { id } = message;
  const controller = new AbortController();
  controllers.set(id, controller);
  try {
    if (message.type === "install") {
      const installed = await installPack(
        message.manifest,
        message.sources,
        (fraction: number) => self.postMessage({ id, type: "progress", fraction }),
        controller.signal,
      );
      self.postMessage({ id, type: "installed", pack: installed });
    }
    if (message.type === "list")
      self.postMessage({ id, type: "packs", packs: await listPacks() });
    if (message.type === "remove") {
      await removePack(message.pack);
      // The cell id rides back as it already does for an install: removals are queued in
      // bulk, and a bare acknowledgement cannot be matched to the pack it belongs to.
      self.postMessage({ id, type: "removed", cell: message.pack.manifest.id });
    }
  } catch (e) {
    self.postMessage({
      id,
      type: "error",
      error: e instanceof Error ? e.message : String(e),
      // A cancelled download rejects like any other failure. Saying so here is what keeps
      // "signal is aborted without reason" out of the page's error banner.
      aborted: controller.signal.aborted,
    });
  } finally {
    controllers.delete(id);
  }
}
