/**
 * Serve a local cells tree at `<base>data/` from the Vite dev and preview servers.
 *
 * Builds live under the ignored `.cache/`, never in `public/`, so they cannot leak into a
 * production build. Byte ranges are honoured because the router reads graph blocks by
 * range, exactly as it does from S3.
 */
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";
import type { Plugin } from "vite";

type Next = (error?: unknown) => void;

export function localData(root: string, base: string): Plugin {
  const directory = resolve(root);
  const prefix = `${base.replace(/\/?$/, "/")}data/`;
  const middleware = async (
    req: IncomingMessage,
    res: ServerResponse,
    next: Next,
  ) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!url.pathname.startsWith(prefix)) return next();
    const file = resolve(
      directory,
      decodeURIComponent(url.pathname.slice(prefix.length)),
    );
    if (!file.startsWith(directory + sep)) {
      res.statusCode = 403;
      return res.end();
    }
    const info = await stat(file).catch(() => undefined);
    if (!info?.isFile()) {
      res.statusCode = 404;
      return res.end();
    }
    let start = 0,
      end = info.size - 1;
    res.setHeader(
      "Content-Type",
      extname(file) === ".json" ? "application/json" : "application/octet-stream",
    );
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Cache-Control", "no-cache");
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? "");
    if (range) {
      start = +range[1];
      end = range[2] ? Math.min(+range[2], end) : end;
      if (start > end) {
        res.statusCode = 416;
        return res.end();
      }
      res.statusCode = 206;
      res.setHeader("Content-Range", `bytes ${start}-${end}/${info.size}`);
    }
    res.setHeader("Content-Length", end - start + 1);
    if (req.method === "HEAD") return res.end();
    createReadStream(file, { start, end }).pipe(res);
  };
  return {
    name: "ibex-local-data",
    configureServer: (server) => void server.middlewares.use(middleware),
    configurePreviewServer: (server) => void server.middlewares.use(middleware),
  };
}
