/** Node's zlib as the builder's `Inflate`. The browser's counterpart is DecompressionStream. */
import { inflate as inflateCallback } from "node:zlib";
import type { Inflate } from "../osm/pbf";

export const inflate: Inflate = (data) =>
  new Promise((resolve, reject) =>
    inflateCallback(data, (error, result) =>
      error ? reject(error) : resolve(new Uint8Array(result.buffer, result.byteOffset, result.byteLength)),
    ),
  );
