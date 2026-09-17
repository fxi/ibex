/** Local-only static server with a transport-outage switch for PWA tests. */
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
let offline = false;
let fault = null,
  graphReads = 0;
const root = path.resolve("dist");
const types = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};
http
  .createServer(async (req, res) => {
    if (req.url === "/__test/network" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      offline = JSON.parse(body).offline;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ offline }));
      return;
    }
    if (req.url === "/__test/fault") {
      if (req.method === "POST") {
        let body = "";
        for await (const chunk of req) body += chunk;
        fault = JSON.parse(body).fault;
        if (!JSON.parse(body).preserveReads) graphReads = 0;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ graphReads }));
      return;
    }
    if (offline) {
      req.socket.destroy();
      return;
    }
    try {
      const url = new URL(req.url, "http://127.0.0.1:4173");
      if (!url.pathname.startsWith("/ibex/")) {
        res.writeHead(404);
        res.end();
        return;
      }
      const relative =
        decodeURIComponent(url.pathname.slice("/ibex/".length)) ||
        "index.html";
      const file = path.resolve(root, relative);
      if (!file.startsWith(root + path.sep)) {
        res.writeHead(403);
        res.end();
        return;
      }
      if (path.basename(file) === "graph.ibx") graphReads++;
      if (fault === "disconnect" && path.basename(file) === "index.ibx") {
        req.socket.destroy();
        return;
      }
      const bytes = await fs.readFile(file);
      if (fault === "checksum" && path.basename(file) === "graph.ibx") {
        fault = null;
        bytes[0] ^= 1;
      }
      let start = 0,
        end = bytes.length - 1,
        status = 200;
      const headers = {
        "Content-Type": types[path.extname(file)] ?? "application/octet-stream",
        "Cache-Control": "no-cache",
        "Accept-Ranges": "bytes",
      };
      if (req.headers.range) {
        const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range);
        if (!match || +match[1] >= bytes.length) {
          res.writeHead(416);
          res.end();
          return;
        }
        start = +match[1];
        end = match[2] ? Math.min(+match[2], end) : end;
        status = 206;
        headers["Content-Range"] = `bytes ${start}-${end}/${bytes.length}`;
      }
      headers["Content-Length"] = end - start + 1;
      res.writeHead(status, headers);
      res.end(
        req.method === "HEAD" ? undefined : bytes.subarray(start, end + 1),
      );
    } catch {
      res.writeHead(404);
      res.end("Not found");
    }
  })
  .listen(4173, "0.0.0.0", () =>
    console.log("Test server ready on 127.0.0.1:4173"),
  );
