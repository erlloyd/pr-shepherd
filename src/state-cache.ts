import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { createLogger } from "./log.js";
import type { WatchedPR, PRState } from "./types.js";

const log = createLogger("state-cache");

function cachePath(dataDir: string): string {
  return join(dataDir, "pr-state-cache.json");
}

function ensureDir(filePath: string) {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function readCache(dataDir: string): WatchedPR[] {
  const path = cachePath(dataDir);
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf-8");
  try {
    return JSON.parse(raw) as WatchedPR[];
  } catch {
    log.warn(`Corrupt state cache at ${path}, treating as empty`);
    return [];
  }
}

export function writeCache(dataDir: string, prs: WatchedPR[]): void {
  const path = cachePath(dataDir);
  ensureDir(path);
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(prs, null, 2) + "\n");
  renameSync(tmp, path);
}

export function getCachedPR(
  dataDir: string,
  number: number,
  repo: string,
): WatchedPR | null {
  const prs = readCache(dataDir);
  return prs.find((p) => p.number === number && p.repo === repo) ?? null;
}

export function upsertCachedPR(dataDir: string, pr: WatchedPR): void {
  const prs = readCache(dataDir);
  const idx = prs.findIndex((p) => p.number === pr.number && p.repo === pr.repo);
  if (idx >= 0) {
    prs[idx] = pr;
  } else {
    prs.push(pr);
  }
  writeCache(dataDir, prs);
}

export function removeCachedPR(dataDir: string, number: number, repo: string): void {
  const prs = readCache(dataDir);
  const filtered = prs.filter((p) => !(p.number === number && p.repo === repo));
  if (filtered.length !== prs.length) {
    writeCache(dataDir, filtered);
  }
}
