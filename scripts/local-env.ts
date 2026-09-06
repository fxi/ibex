import { readFileSync } from "node:fs";
import { parse } from "dotenv";

/** Read exactly this file: no ancestor search, ambient values, or expansion. */
export function localEnv(file: URL): Record<string, string> {
  try {
    return parse(readFileSync(file));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

export function mapTilerKey(file: URL): string {
  return localEnv(file).VITE_MAPTILER_API_KEY?.trim() ?? "";
}
