/**
 * Cut a release: bump the version, commit, tag, and with `--push` send both to GitHub.
 *
 *   npm run release -- patch            # 0.1.0 → 0.1.1, committed and tagged locally
 *   npm run release -- minor --push     # and pushed: deploys the app, then release.yml
 *   npm run release -- 1.0.0 --push     #   publishes the GitHub release and the map packs
 *
 * The tag must match package.json (release.yml refuses it otherwise), so the version is
 * only ever changed here. The checks run first, because a tag that fails them is public
 * and stays. `--skip-checks` is for a retry right after they passed.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const bump = args.find((a) => !a.startsWith("--"));
const push = args.includes("--push");
const REMOTE = "github";

const git = (...argv: string[]) =>
  execFileSync("git", argv, { encoding: "utf8" }).trim();
const step = (cmd: string, argv: string[]) =>
  execFileSync(cmd, argv, { stdio: "inherit" });
const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};

if (!bump || !/^(patch|minor|major|\d+\.\d+\.\d+)$/.test(bump))
  fail("Usage: npm run release -- <patch|minor|major|x.y.z> [--push] [--skip-checks]");
if (git("branch", "--show-current") !== "main") fail("Release from main.");
if (git("status", "--porcelain")) fail("The working tree is not clean.");
step("git", ["fetch", REMOTE, "main", "--tags"]);
if (git("rev-list", "--count", `HEAD..${REMOTE}/main`) !== "0")
  fail(`main is behind ${REMOTE}/main; pull first.`);

if (!args.includes("--skip-checks"))
  for (const script of ["lint", "typecheck", "test"]) step("npm", ["run", script]);

step("npm", ["version", bump!, "--no-git-tag-version"]);
const version = (JSON.parse(readFileSync("package.json", "utf8")) as { version: string }).version;
const tag = `v${version}`;
if (git("tag", "--list", tag)) fail(`${tag} already exists.`);
step("git", ["add", "package.json", "package-lock.json"]);
step("git", ["commit", "-m", `chore: release ${tag}`]);
step("git", ["tag", "-a", tag, "-m", tag]);

if (push) {
  // Atomic: a tag without its commit on main, or the reverse, is the one state to avoid.
  step("git", ["push", "--atomic", REMOTE, "main", tag]);
  console.log(`Pushed ${tag}. Watch it with: gh run watch`);
} else console.log(`Tagged ${tag} locally. Send it with: git push --atomic ${REMOTE} main ${tag}`);
