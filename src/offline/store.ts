import { COST_MODEL_VERSION } from "../routing/types";
import { storageEstimate, sha256Hex } from "./capabilities";
import { openDB } from "idb";
import { z } from "zod";
const fileSchema = z.object({
  path: z.string().regex(/^[a-zA-Z0-9_.-]+$/),
  bytes: z.number().int().positive().max(300_000_000),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
const common = {
  name: z.string().max(100),
  version: z.string().regex(/^[a-zA-Z0-9-]+$/),
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  osmTimestamp: z.string(),
  costModelVersion: z.literal(COST_MODEL_VERSION),
  terrainCoverage: z.number().min(0).max(1),
  attribution: z.string(),
  files: z.array(fileSchema).min(2).max(1000),
  build: z.record(z.string(), z.unknown()).optional(),
};
/** One downloadable grid cell in the binary format — the only pack shape there is. */
export const cellManifestSchema = z.object({
  schemaVersion: z.literal(2),
  format: z.literal("ibex-1"),
  // Hyphenated cell id, which is also the `packs` object-store key.
  id: z.string().regex(/^\d{1,2}-\d{1,8}-\d{1,8}$/),
  release: z.string().regex(/^[a-z0-9._-]{1,64}$/),
  cell: z.object({
    zoom: z.number().int().min(0).max(14),
    x: z.number().int().nonnegative(),
    y: z.number().int().nonnegative(),
  }),
  blockZoom: z.number().int().min(0).max(20),
  blocks: z.number().int().nonnegative(),
  ...common,
});
export const manifestSchema = cellManifestSchema;
export type Manifest = z.infer<typeof manifestSchema>;
export type CellManifest = Manifest;
/** True for any pack this build can read. Pre-grid region packs fail `manifestSchema`. */
export const isCellManifest = (m: unknown): m is CellManifest =>
  cellManifestSchema.safeParse(m).success;
export type Installed = {
  manifest: Manifest;
  installedAt: string;
  directory: string;
  backend: "opfs" | "idb";
};
const db = () =>
  openDB("cyclatractor-v1", 1, {
    upgrade(database) {
      database.createObjectStore("packs");
      database.createObjectStore("files");
      database.createObjectStore("preferences");
    },
  });
export async function listPacks(): Promise<Installed[]> {
  return (await db()).getAll("packs");
}
export async function readManifest(url: string): Promise<Manifest> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Pack catalog unavailable (${r.status})`);
  const value = await r.json();
  if (value.costModelVersion !== COST_MODEL_VERSION)
    throw new Error(
      "This region uses outdated routing data. Install the updated region.",
    );
  return manifestSchema.parse(value);
}
const root = async () =>
  (await navigator.storage.getDirectory()).getDirectoryHandle("cyclatractor", {
    create: true,
  });
export async function readFile(
  pack: Installed,
  path: string,
): Promise<ArrayBuffer> {
  if (!pack.manifest.files.some((f) => f.path === path))
    throw new Error("File is not in installed manifest");
  if (pack.backend === "idb") {
    const bytes = await (await db()).get("files", `${pack.directory}/${path}`);
    if (!bytes) throw new Error("Offline data missing. Reinstall this region.");
    return bytes;
  }
  const directory = await (await root()).getDirectoryHandle(pack.directory);
  return (await (await directory.getFileHandle(path)).getFile()).arrayBuffer();
}
export async function readRange(
  pack: Installed,
  path: string,
  offset: number,
  length: number,
): Promise<ArrayBuffer> {
  const entry = pack.manifest.files.find((f) => f.path === path);
  if (!entry || offset < 0 || length < 0 || offset >= entry.bytes)
    throw new Error("Invalid file range");
  const end = Math.min(offset + length, entry.bytes);
  if (pack.backend === "idb")
    return (await readFile(pack, path)).slice(offset, end);
  const directory = await (await root()).getDirectoryHandle(pack.directory);
  const file = await (await directory.getFileHandle(path)).getFile();
  return file.slice(offset, end).arrayBuffer();
}
export async function readJSON<T>(pack: Installed, path: string): Promise<T> {
  const bytes = await readFile(pack, path);
  const reader = new Blob([bytes])
    .stream()
    .pipeThrough(new DecompressionStream("gzip"))
    .getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > 32_000_000) {
      await reader.cancel();
      throw new Error("Decoded chunk exceeds memory budget");
    }
    chunks.push(part.value);
  }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(output));
}
export async function removePack(pack: Installed) {
  const database = await db();
  if (pack.backend === "opfs")
    await (await root()).removeEntry(pack.directory, { recursive: true });
  else {
    const tx = database.transaction("files", "readwrite");
    for (const f of pack.manifest.files)
      await tx.store.delete(`${pack.directory}/${f.path}`);
    await tx.done;
  }
  const current = await database.get("packs", pack.manifest.id);
  if (current?.directory === pack.directory)
    await database.delete("packs", pack.manifest.id);
}
export async function installPack(
  url: string,
  progress: (fraction: number) => void,
  signal: AbortSignal,
): Promise<Installed> {
  const manifest = await readManifest(url);
  const paths = manifest.files.map((f) => f.path);
  if (
    new Set(paths).size !== paths.length ||
    !["index.ibx", "graph.ibx"].every((name) => paths.includes(name))
  )
    throw new Error("Invalid pack file list");
  const total = manifest.files.reduce((s, f) => s + f.bytes, 0);
  if (total > 400_000_000)
    throw new Error("Pack exceeds this prototype’s 400 MB storage limit");
  const estimate = await storageEstimate();
  if (estimate.quota && estimate.quota - (estimate.usage ?? 0) < total * 1.15)
    throw new Error("Not enough storage to install this region");
  await navigator.storage?.persist?.().catch(() => false);
  const database = await db(),
    previous: Installed | undefined = await database.get("packs", manifest.id);
  if (previous?.manifest.version === manifest.version) return previous;
  const pack: Installed = {
    manifest,
    installedAt: new Date().toISOString(),
    directory: `${manifest.id}-${manifest.version}`,
    backend:
      typeof navigator.storage?.getDirectory === "function" ? "opfs" : "idb",
  };
  let directory: FileSystemDirectoryHandle | undefined;
  if (pack.backend === "opfs") {
    try {
      directory = await (
        await root()
      ).getDirectoryHandle(pack.directory, { create: true });
      const probe = await directory.getFileHandle("probe", { create: true });
      const writer = await probe.createWritable();
      await writer.close();
      await directory.removeEntry("probe");
    } catch {
      directory = undefined;
      pack.backend = "idb";
    }
  }
  let done = 0;
  const resumeKey = `download:${pack.directory}`;
  const completed: string[] =
    (await database.get("preferences", resumeKey)) ?? [];
  try {
    for (const f of manifest.files) {
      signal.throwIfAborted();
      if (completed.includes(f.path)) {
        try {
          const saved = await readFile(pack, f.path);
          const hash = await sha256Hex(saved);
          if (hash === f.sha256) {
            done += f.bytes;
            progress(done / total);
            continue;
          }
        } catch {
          /* The browser may have evicted a staged file. */
        }
      }
      const response = await fetch(new URL(f.path, url), { signal });
      if (!response.ok || !response.body)
        throw new Error(`Cannot download ${f.path}`);
      const reader = response.body.getReader(),
        chunks: Uint8Array[] = [];
      let received = 0;
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        received += part.value.byteLength;
        if (received > f.bytes) {
          await reader.cancel();
          throw new Error("Pack size differs from manifest");
        }
        chunks.push(part.value);
        progress((done + received) / total);
      }
      if (received !== f.bytes) throw new Error("Incomplete download");
      const bytes = new Uint8Array(received);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      chunks.length = 0;
      const hash = await sha256Hex(bytes);
      if (hash !== f.sha256) throw new Error("Pack checksum mismatch");
      if (directory) {
        const handle = await directory.getFileHandle(f.path, { create: true });
        const writer = await handle.createWritable();
        try {
          await writer.write(bytes);
          await writer.close();
        } catch (e) {
          await writer.abort();
          throw e;
        }
      } else
        await database.put(
          "files",
          bytes.buffer,
          `${pack.directory}/${f.path}`,
        );
      if (!completed.includes(f.path)) completed.push(f.path);
      await database.put("preferences", completed, resumeKey);
      done += received;
    }
    signal.throwIfAborted();
    await database.put("packs", pack, manifest.id);
    await database.delete("preferences", resumeKey);
  } catch (e) {
    if (signal.aborted) {
      await removePack(pack).catch(() => {});
      await database.delete("preferences", resumeKey);
    }
    throw e;
  }
  if (previous) await removePack(previous).catch(() => {});
  return pack;
}
export async function savePreference(key: string, value: unknown) {
  await (await db()).put("preferences", value, key);
}
export async function preference<T>(key: string): Promise<T | undefined> {
  return (await db()).get("preferences", key);
}
