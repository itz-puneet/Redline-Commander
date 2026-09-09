/**
 * Match persistence.
 *
 * A turn-based game played with friends is asynchronous in practice: one
 * player takes a turn now and the other answers hours later. In-memory-only
 * matches would evaporate on every deploy or crash, so a committed turn is
 * written to durable storage before it is acknowledged.
 *
 * The interface is what matters; the JSON-file implementation below is fine
 * for development and small groups. Swap in Postgres/Redis behind the same
 * three methods when you outgrow it - nothing else in the codebase changes.
 */

import crypto from "crypto";
import fs from "fs";
import path from "path";
import type { MatchState } from "../game/types";

export interface MatchStore {
  load(matchId: string): Promise<MatchState | null>;
  save(state: MatchState): Promise<void>;
  delete(matchId: string): Promise<void>;
  listActive(): Promise<string[]>;
}

export class FileMatchStore implements MatchStore {
  constructor(private readonly dir: string) {
    fs.mkdirSync(dir, { recursive: true });
  }

  private file(matchId: string): string {
    // Match ids are server-generated, but never build a path from unvalidated input.
    if (!/^[a-z0-9_-]+$/i.test(matchId)) throw new Error(`invalid match id: ${matchId}`);
    return path.join(this.dir, `${matchId}.json`);
  }

  async load(matchId: string): Promise<MatchState | null> {
    try {
      return JSON.parse(await fs.promises.readFile(this.file(matchId), "utf8")) as MatchState;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  /** Write-then-rename so a crash mid-write cannot corrupt a live match. */
  async save(state: MatchState): Promise<void> {
    await this.writeDurably(this.file(state.matchId), JSON.stringify(state));
  }

  async delete(matchId: string): Promise<void> {
    await fs.promises.rm(this.file(matchId), { force: true });
  }

  async listActive(): Promise<string[]> {
    const files = await fs.promises.readdir(this.dir).catch(() => [] as string[]);
    return files.filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, ""));
  }

  /**
   * Write to a unique temp file, flush it to the platter, then rename.
   *
   * The fsync is what makes the durability claim true: without it a write can
   * be acknowledged, the process can survive, and the contents can still be
   * lost to a power cut. The directory fsync makes the rename itself durable,
   * and is best-effort because not every platform allows opening a directory.
   *
   * The temp name is unique per write: two saves racing on one record would
   * otherwise share a path, and whichever renamed second would find it
   * already gone and throw ENOENT.
   */
  private async writeDurably(target: string, contents: string): Promise<void> {
    const temp = `${target}.${crypto.randomUUID()}.tmp`;

    const handle = await fs.promises.open(temp, "w", 0o600);
    try {
      await handle.writeFile(contents, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }

    await fs.promises.rename(temp, target);

    try {
      const dir = await fs.promises.open(path.dirname(target), "r");
      try {
        await dir.sync();
      } finally {
        await dir.close();
      }
    } catch {
      // Not every platform lets a directory be opened. The file itself is
      // already durable, which is the part that matters most.
    }
  }

  /**
   * Removes temp files left behind by a crash between write and rename.
   *
   * Only files old enough that no live write could still own them: deleting
   * an in-flight temp would turn its rename into ENOENT and lose that write,
   * which matters because this runs at startup and another process may be
   * mid-save.
   */
  async cleanOrphanedTempFiles(olderThanMs = 5 * 60_000): Promise<number> {
    const files = await fs.promises.readdir(this.dir).catch(() => [] as string[]);
    const cutoff = Date.now() - olderThanMs;
    let removed = 0;

    for (const file of files) {
      if (!file.endsWith(".tmp")) continue;
      const full = path.join(this.dir, file);
      const stat = await fs.promises.stat(full).catch(() => null);
      if (stat === null || stat.mtimeMs > cutoff) continue;
      await fs.promises.rm(full, { force: true });
      removed += 1;
    }
    return removed;
  }

}
