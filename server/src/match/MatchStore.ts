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
    const target = this.file(state.matchId);
    const temp = `${target}.tmp`;
    await fs.promises.writeFile(temp, JSON.stringify(state), "utf8");
    await fs.promises.rename(temp, target);
  }

  async delete(matchId: string): Promise<void> {
    await fs.promises.rm(this.file(matchId), { force: true });
  }

  async listActive(): Promise<string[]> {
    const files = await fs.promises.readdir(this.dir).catch(() => [] as string[]);
    return files.filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, ""));
  }
}
