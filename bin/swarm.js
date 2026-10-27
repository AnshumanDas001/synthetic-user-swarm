#!/usr/bin/env node
// Launches the TypeScript CLI through tsx so no build step is needed.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const r = spawnSync(process.execPath, ["--import", "tsx", path.join(root, "src/cli.ts"), ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(r.status ?? 1);
