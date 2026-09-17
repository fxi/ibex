/**
 * First run after cloning: install dependencies, create `.env`, and say what is missing.
 * Safe to rerun; an existing `.env` is never touched.
 */
import { execSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync } from "node:fs";

const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 13))
  throw new Error(`Node 22.13+ required, found ${process.versions.node}`);

execSync("npm ci", { stdio: "inherit" });

if (!existsSync(".env")) {
  copyFileSync(".env.example", ".env");
  console.log("\nCreated .env from .env.example");
}

const env = Object.fromEntries(
  readFileSync(".env", "utf8")
    .split("\n")
    .map((line) => line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/))
    .filter(Boolean)
    .map((m) => [m[1], m[2].replace(/^["']|["']$/g, "")]),
);
const notes = [];
if (!env.VITE_MAPTILER_API_KEY)
  notes.push(
    "VITE_MAPTILER_API_KEY is empty: the basemap and place search need a free key from https://cloud.maptiler.com",
  );
if (!env.VITE_DATA_URL)
  notes.push(
    "VITE_DATA_URL is empty: the app reads locally staged data (npm run data:stage); see docs/data-format.md",
  );
console.log(
  notes.length ? `\n${notes.map((n) => `- ${n}`).join("\n")}\n` : "",
  "\nReady: npm run dev",
);
