/// <reference lib="webworker" />
import { installPack, listPacks, readFile, removePack } from "../offline/store";
const controllers = new Map<number, AbortController>();
self.onmessage = async (event) => {
  const { id, type, url, pack } = event.data;
  if (type === "cancel") {
    controllers.get(id)?.abort();
    return;
  }
  try {
    if (type === "install") {
      const controller = new AbortController();
      controllers.set(id, controller);
      const installed = await installPack(
        url,
        (fraction) => self.postMessage({ id, type: "progress", fraction }),
        controller.signal,
      );
      self.postMessage({ id, type: "installed", pack: installed });
    }
    if (type === "list")
      self.postMessage({ id, type: "packs", packs: await listPacks() });
    if (type === "remove") {
      await removePack(pack);
      self.postMessage({ id, type: "removed" });
    }
    if (type === "map") {
      const bytes = await readFile(pack, "basemap.json");
      self.postMessage({ id, type: "map", bytes }, [bytes]);
    }
  } catch (e) {
    self.postMessage({
      id,
      type: "error",
      error: e instanceof Error ? e.message : String(e),
    });
  } finally {
    controllers.delete(id);
  }
};
