/**
 * Level 9, option B: expand and prune.
 * Globs and directories become a file list in code. Dependencies, VCS folders, binaries, and files over the budget drop out with a reason. The 255 cap is enforced before any call is made.
 */
import { glob, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { LIMITS } from "../../core/types.ts";
import { MAX_FILE_CHARS } from "../level08/read-state.ts";

export const SKIP_DIRS = new Set(["node_modules", ".git", ".sessions", "dist", "build", "coverage", ".pi"]);
const GLOB_CHARS = /[*?[\]{}]/;

export interface Skipped {
  path: string;
  reason: string;
}

/** Patterns are globs, files, or directories. A directory means its files, or everything below it when recursive. */
export async function expandPatterns(patterns: string[], cwd: string, recursive: boolean): Promise<string[]> {
  const out = new Set<string>();
  for (const raw of patterns) {
    const pattern = raw.trim();
    if (!pattern) continue;
    if (GLOB_CHARS.test(pattern)) {
      for await (const p of glob(pattern, { cwd })) out.add(String(p).replaceAll("\\", "/"));
      continue;
    }
    const full = isAbsolute(pattern) ? pattern : resolve(cwd, pattern);
    let info;
    try { info = await stat(full); } catch { out.add(pattern); continue; } // let prune report it
    if (info.isFile()) { out.add(pattern); continue; }
    for await (const p of glob(recursive ? `${pattern.replace(/\/+$/, "")}/**/*` : `${pattern.replace(/\/+$/, "")}/*`, { cwd })) out.add(String(p).replaceAll("\\", "/"));
  }
  return [...out].sort();
}

/** What survives, and why each dropped file dropped. Nothing here calls Jev. */
export async function pruneFiles(paths: string[], cwd: string, cap = LIMITS.MAX_CHOICE_OPTIONS): Promise<{ files: string[]; skipped: Skipped[] }> {
  const files: string[] = [];
  const skipped: Skipped[] = [];
  for (const path of paths) {
    const full = isAbsolute(path) ? path : resolve(cwd, path);
    const rel = relative(cwd, full);
    if (rel.startsWith("..")) { skipped.push({ path, reason: "outside the repo" }); continue; }
    if (rel.split(sep).some((part) => SKIP_DIRS.has(part))) { skipped.push({ path, reason: "skipped directory" }); continue; }
    let info;
    try { info = await stat(full); } catch { skipped.push({ path, reason: "not found" }); continue; }
    if (!info.isFile()) continue;
    if (info.size === 0) { skipped.push({ path, reason: "empty" }); continue; }
    if (info.size > MAX_FILE_CHARS) { skipped.push({ path, reason: `too large, ${info.size} bytes` }); continue; }
    if (/\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tgz|woff2?|ttf|mp[34]|mov|lock)$/i.test(path)) { skipped.push({ path, reason: "binary or lock file" }); continue; }
    if (files.length >= cap) { skipped.push({ path, reason: `over the ${cap} file cap; narrow the pattern` }); continue; }
    files.push(path);
  }
  return { files, skipped };
}
