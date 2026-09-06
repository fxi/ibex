/** Isolate WebKit's offline-emulation blob-worker failure, independent of Cyclatractor. */
import { webkit } from "playwright";
const browser = await webkit.launch();
const context = await browser.newContext();
const page = await context.newPage();
await page.goto("http://127.0.0.1:4173/cyclatractor/");
async function probe() {
  return page.evaluate(
    () =>
      new Promise((resolve) => {
        const url = URL.createObjectURL(
          new Blob(['self.postMessage("ready")'], { type: "text/javascript" }),
        );
        const worker = new Worker(url);
        const timer = setTimeout(() => {
          worker.terminate();
          resolve("timeout");
        }, 5000);
        worker.onmessage = (e) => {
          clearTimeout(timer);
          worker.terminate();
          URL.revokeObjectURL(url);
          resolve(e.data);
        };
        worker.onerror = (e) => {
          clearTimeout(timer);
          worker.terminate();
          resolve(e.message || "worker error");
        };
      }),
  );
}
console.log({ online: await probe() });
await context.setOffline(true);
console.log({ offline: await probe() });
await browser.close();
