import { useEffect, useMemo, useRef, useState } from "react";
import {
  isCellManifest,
  listPacks,
  removePack,
  type Installed,
} from "../offline/store";
import { storageEstimate } from "../offline/capabilities";
import {
  cachedCatalogue,
  readCatalogue,
  resolveCellManifest,
  type Catalogue,
} from "../offline/catalogue";
import {
  installedCells,
  mapCells,
  nextIntent,
  type CellIntent,
} from "../offline/cells";
import DataWorker from "../workers/data.worker.ts?worker&inline";

export type CatalogueState = ReturnType<typeof useCatalogue>;

/**
 * Owns the offline data catalogue, what is installed, and the download queue.
 *
 * Downloads run one at a time: sequential queueing keeps the storage headroom check
 * meaningful and lets a single cancel stop the run without orphaning staged files.
 */
export function useCatalogue({
  pointerURL,
  onError,
  onStatus,
  onDataChange,
}: {
  /** `v<DATA_VERSION>/latest.json` of the data tree this build reads. */
  pointerURL: string;
  onError: (message: string) => void;
  onStatus: (message: string) => void;
  /** Installed data changed, so any in-flight route is invalid. */
  onDataChange: () => void;
}) {
  const [catalogue, setCatalogue] = useState<Catalogue>();
  const [installed, setInstalled] = useState<Installed[]>([]);
  const [catalogueError, setCatalogueError] = useState("");
  const [notice, setNotice] = useState("");
  const [intents, setIntents] = useState<ReadonlyMap<string, CellIntent>>(
    () => new Map(),
  );
  const [queuedCells, setQueuedCells] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [downloadingCell, setDownloadingCell] = useState<string>();
  const [failedCells, setFailedCells] = useState<ReadonlyMap<string, string>>(
    () => new Map(),
  );
  const [missingCells, setMissingCells] = useState<string[]>([]);
  const [progress, setProgress] = useState<number>();
  const [storage, setStorage] = useState("");

  const dataWorker = useRef<Worker | undefined>(undefined);
  const installing = useRef<string | undefined>(undefined);
  const pending = useRef<string[]>([]);
  const catalogueRef = useRef<Catalogue | undefined>(undefined);
  catalogueRef.current = catalogue;
  /** Where the current catalogue came from; cell manifests resolve against it. */
  const catalogueURL = useRef("");
  const changed = useRef(onDataChange);
  changed.current = onDataChange;

  function nextInstall() {
    const next = pending.current.shift();
    installing.current = next;
    if (!next) {
      setDownloadingCell(undefined);
      setProgress(undefined);
      return;
    }
    const cell = catalogueRef.current?.cells.find((c) => c.id === next);
    if (!cell) return nextInstall();
    setDownloadingCell(next);
    setProgress(0);
    dataWorker.current?.postMessage({
      id: 1,
      type: "install",
      url: resolveCellManifest(catalogueURL.current, cell),
    });
  }

  useEffect(() => {
    let disposed = false;
    const w = new DataWorker();
    dataWorker.current = w;
    w.onmessage = ({ data }) => {
      if (data.type === "progress") setProgress(data.fraction);
      if (data.type === "installed") {
        changed.current();
        setProgress(undefined);
        onError("");
        const cell = data.pack?.manifest?.id as string | undefined;
        // Keep the whole installed set, drop it from the queue, take the next.
        setInstalled((previous) => [
          ...previous.filter((p) => p.manifest.id !== cell),
          data.pack,
        ]);
        onStatus(`Saved ${data.pack.manifest.name}`);
        if (cell) {
          setQueuedCells((previous) => {
            const next = new Set(previous);
            next.delete(cell);
            return next;
          });
          setIntents((previous) => {
            const next = new Map(previous);
            next.delete(cell);
            return next;
          });
          setMissingCells((previous) => previous.filter((id) => id !== cell));
        }
        nextInstall();
      }
      if (data.type === "error") {
        // A cancelled download is not a failure to report: the user asked for it, and
        // cancelDownloads has already cleared the queue and the progress bar.
        if (data.aborted) return;
        const cell = installing.current;
        if (cell) {
          setFailedCells((previous) => new Map(previous).set(cell, data.error));
          setQueuedCells((previous) => {
            const next = new Set(previous);
            next.delete(cell);
            return next;
          });
          setProgress(undefined);
          nextInstall();
        } else {
          onError(data.error);
          setProgress(undefined);
        }
      }
      if (data.type === "removed") {
        changed.current();
        // The worker names the pack it removed. A single "which one is going" ref could
        // only ever hold the last of a bulk removal, so the rest stayed listed as ready —
        // and stayed routable — with their files already gone.
        const removed = data.cell as string | undefined;
        if (removed)
          setInstalled((previous) =>
            previous.filter((p) => p.manifest.id !== removed),
          );
        onStatus(removed ? `Removed ${removed}` : "Removed");
      }
    };

    listPacks()
      .then(async (packs) => {
        if (disposed) return;
        // Cells installed under another DATA_VERSION cannot be read by this build, so
        // they are storage the user cannot use. Reclaim it rather than listing it.
        const usable = packs.filter((p) => isCellManifest(p.manifest));
        const obsolete = packs.filter((p) => !usable.includes(p));
        setInstalled(usable);
        if (obsolete.length) {
          await Promise.all(
            obsolete.map((p) => removePack(p).catch(() => undefined)),
          );
          if (!disposed)
            setNotice(
              "The previous download used an older data format and was removed. Select the areas you need.",
            );
        }
      })
      .catch(() => onError("Browser storage unavailable"));

    readCatalogue(pointerURL)
      .then((v) => {
        if (disposed) return;
        catalogueURL.current = v.url;
        setCatalogue(v.catalogue);
      })
      .catch(async () => {
        // A catalogue failure must never block using or removing installed packs.
        const cached = await cachedCatalogue(pointerURL).catch(
          () => undefined,
        );
        if (disposed) return;
        // No catalogue at all simply means no data is published at this URL yet, so
        // stay silent. Only say something when we are deliberately showing stale data.
        if (!cached) return;
        catalogueURL.current = cached.url;
        setCatalogue(cached.catalogue);
        setCatalogueError(
          "Showing the last saved catalogue. Reconnect for updates.",
        );
      });

    storageEstimate()
      .then((e) => {
        if (!disposed && e.quota)
          setStorage(
            `${((e.quota - (e.usage ?? 0)) / 1e9).toFixed(1)} GB available`,
          );
      })
      .catch(() => {});

    return () => {
      disposed = true;
      w.terminate();
    };
  }, []);

  const cells = useMemo(
    () =>
      catalogue
        ? mapCells(catalogue, installed, {
            intents,
            queued: queuedCells,
            downloading: downloadingCell,
            failed: failedCells,
          })
        : undefined,
    [
      catalogue,
      installed,
      intents,
      queuedCells,
      downloadingCell,
      failedCells,
    ],
  );
  const savedCells = useMemo(
    () => installedCells(installed, catalogue),
    [installed, catalogue],
  );
  const routableCells = useMemo(
    () =>
      catalogue
        ? installed.filter((p) => p.manifest.release === catalogue.release)
        : [],
    [installed, catalogue],
  );

  function download(ids: string[]) {
    if (!ids.length) return;
    setFailedCells(new Map());
    onError("");
    setQueuedCells(new Set(ids));
    pending.current = [...ids];
    if (!installing.current) nextInstall();
  }

  /**
   * Apply every pending intent in one run. Removals happen first so that reclaimed
   * storage is available to the downloads that follow, which is what makes "swap this
   * area for that one" work on a nearly full device.
   */
  function process() {
    const removals: Installed[] = [];
    const downloads: string[] = [];
    for (const [id, intent] of intents) {
      if (intent === "remove") {
        const held = installed.find((p) => p.manifest.id === id);
        if (held) removals.push(held);
      } else downloads.push(id);
    }
    setIntents(new Map());
    for (const pack of removals) removeCell(pack);
    download(downloads);
  }

  function cancelDownloads() {
    pending.current = [];
    dataWorker.current?.postMessage({ id: 1, type: "cancel" });
    setQueuedCells(new Set());
    setDownloadingCell(undefined);
    installing.current = undefined;
    setProgress(undefined);
  }

  function removeCell(installedPack: Installed) {
    dataWorker.current?.postMessage({
      id: 2,
      type: "remove",
      pack: installedPack,
    });
  }

  /** One click advances a cell through its available actions. */
  function toggleCell(id: string) {
    const held = installed.some((p) => p.manifest.id === id);
    setIntents((previous) => {
      const next = new Map(previous);
      const wanted = nextIntent(held, previous.get(id));
      if (wanted) next.set(id, wanted);
      else next.delete(id);
      return next;
    });
  }

  function markAll(ids: string[], intent: CellIntent) {
    setIntents((previous) => {
      const next = new Map(previous);
      for (const id of ids) next.set(id, intent);
      return next;
    });
  }

  function clearIntents() {
    setIntents(new Map());
  }

  return {
    catalogue,
    catalogueError,
    notice,
    installed,
    cells,
    savedCells,
    routableCells,
    intents,
    setIntents,
    queuedCells,
    downloadingCell,
    failedCells,
    missingCells,
    setMissingCells,
    progress,
    storage,
    toggleCell,
    markAll,
    clearIntents,
    process,
    download,
    cancelDownloads,
    removeCell,
  };
}
