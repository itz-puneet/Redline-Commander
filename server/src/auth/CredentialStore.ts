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
    const target = this.file(credential.playerId);
    // Unique per write: two saves racing on one record would otherwise
    // share a temp path, and whichever renamed second would find it
    // already gone and throw ENOENT.
    const temp = `${target}.${crypto.randomUUID()}.tmp`;
    await fs.promises.writeFile(temp, JSON.stringify(credential), { encoding: "utf8", mode: 0o600 });
    await fs.promises.rename(temp, target);
  }

  async count(): Promise<number> {
    const files = await fs.promises.readdir(this.dir).catch(() => [] as string[]);
    return files.filter((f) => f.endsWith(".json")).length;
  }

  /**
   * Removes temp files left behind by a crash between write and rename.
   * Without this they accumulate forever - the `.json` filter never saw them,
   * so nothing noticed. Called once at startup, when nothing is mid-write.
   */
  async cleanOrphanedTempFiles(): Promise<number> {
    const files = await fs.promises.readdir(this.dir).catch(() => [] as string[]);
    let removed = 0;
    for (const file of files) {
      if (!file.endsWith(".tmp")) continue;
      await fs.promises.rm(path.join(this.dir, file), { force: true });
      removed += 1;
    }
    return removed;
  }

}
