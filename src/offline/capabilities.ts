import { sha256 } from "@noble/hashes/sha2.js";

/** StorageManager and Web Crypto are absent on ordinary LAN HTTP origins. */
export async function storageEstimate(): Promise<StorageEstimate> {
  try {
    return (await navigator.storage?.estimate?.()) ?? {};
  } catch {
    return {};
  }
}

export async function sha256Hex(
  input: ArrayBuffer | Uint8Array,
): Promise<string> {
  const bytes = new Uint8Array(
    input instanceof Uint8Array ? input : new Uint8Array(input),
  );
  const digest = globalThis.crypto?.subtle
    ? new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))
    : sha256(bytes);
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}
