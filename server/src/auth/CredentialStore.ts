/**
 * Where device credentials live.
 *
 * Same shape as MatchStore, and for the same reason: the interface is what
 * the rest of the code depends on, and the JSON-file implementation below is
 * fine for development and a group of friends. Swap in Postgres behind these
 * three methods when you outgrow it.
 *
 * Only the salt and hash are ever written. The token itself is never stored
 * and never logged.
 */

import crypto from "crypto";
import fs from "fs";
import path from "path";
import { PLAYER_ID_PATTERN, type Credential } from "./tokens";

export interface CredentialStore {
  find(playerId: string): Promise<Credential | null>;
  save(credential: Credential): Promise<void>;
  count(): Promise<number>;
}

export class FileCredentialStore implements CredentialStore {
  constructor(private readonly dir: string) {
    fs.mkdirSync(dir, { recursive: true });
  }

  private file(playerId: string): string {
    // Ids are validated before they reach here, but a store that builds
    // paths from input checks for itself rather than trusting its caller.
    if (!PLAYER_ID_PATTERN.test(playerId)) {
      throw new Error(`invalid player id: ${playerId}`);
    }
    return path.join(this.dir, `${playerId}.json`);
  }

  async find(playerId: string): Promise<Credential | null> {
    try {
      return JSON.parse(await fs.promises.readFile(this.file(playerId), "utf8")) as Credential;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  /** Write-then-rename, so a crash mid-write cannot corrupt a credential. */
  async save(credential: Credential): Promise<void> {
    await this.writeDurably(this.file(credential.playerId), JSON.stringify(credential));
  }

  async count(): Promise<number> {
    const files = await fs.promises.readdir(this.dir).catch(() => [] as string[]);
    return files.filter((f) => f.endsWith(".json")).length;
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
