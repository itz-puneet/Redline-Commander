/**
 * Redline Commander - authoritative match server.
 *
 * Bootstrap only: wire storage -> match service -> websocket transport.
 */

import fs from "fs";
import http from "http";
import https from "https";
import path from "path";
import express from "express";
import { attachGameServer } from "./net/server";
import { MatchService } from "./match/MatchService";
import { FileMatchStore } from "./match/MatchStore";
import { AuthService } from "./auth/AuthService";
import { FileCredentialStore } from "./auth/CredentialStore";
import {
  describePosture,
  readTlsSettings,
  terminatesTls,
  tlsConfigError,
} from "./net/tls";
import { RateLimiter, readRateLimits } from "./net/rate_limit";

const port = Number(process.env.PORT ?? 2567);
// Durable server state: matches in progress and device credentials. Named
// REDLINE_STATE_DIR rather than the old REDLINE_MATCH_DIR now that it holds
// more than matches, and distinct from REDLINE_DATA_DIR, which points at the
// read-only shared data tables.
//
// Relative to the working directory (i.e. server/) rather than __dirname, so
// it lands in the same place whether running from src/ or build/.
const stateDir = process.env.REDLINE_STATE_DIR ?? path.resolve(process.cwd(), ".state");

/**
 * A server full of live matches should not disappear because one promise
 * rejected in a corner. These are still bugs and are logged as such - but a
 * rejection is usually recoverable, so it is survived, while an uncaught
 * exception may have left state inconsistent and is not: the process exits
 * and a supervisor restarts it. That is cheap here because every committed
 * turn is already on disk.
 */
process.on("unhandledRejection", (reason) => {
  console.error("[server] unhandled rejection (this is a bug, continuing)", reason);
});
process.on("uncaughtException", (err) => {
  // Written synchronously: console.error followed by process.exit truncates
  // a piped stderr, which is where this lands under Docker or systemd -
  // precisely when the diagnostic matters most.
  try {
    fs.writeSync(2, `[server] uncaught exception (this is a bug, exiting)\n${err?.stack ?? err}\n`);
  } catch {
    // Nothing useful to do if even stderr is gone.
  }
  // Safe to exit immediately: writeSync has already flushed, so nothing is
  // lost the way it would be with console.error followed by exit().
  process.exit(1);
});

const tls = readTlsSettings();
const configError = tlsConfigError(tls);
if (configError !== null) {
  console.error(`Refusing to start: ${configError}`);
  process.exit(1);
}

const app = express();
app.get("/health", (_req, res) => res.json({ ok: true, service: "redline-commander" }));

// Terminate TLS here when given a certificate; otherwise serve plaintext and
// let net/tls.ts decide who is allowed to connect over it.
const httpServer = terminatesTls(tls)
  ? https.createServer(
      {
        cert: fs.readFileSync(tls.certPath!),
        key: fs.readFileSync(tls.keyPath!),
      },
      app,
    )
  : http.createServer(app);
const matchStore = new FileMatchStore(path.join(stateDir, "matches"));
const credentialStore = new FileCredentialStore(path.join(stateDir, "credentials"));
const matches = new MatchService(matchStore);
const auth = new AuthService(credentialStore);

/**
 * A crash between write and rename leaves a temp file nothing would ever
 * remove. This runs to completion before the server listens, so it cannot
 * race a save of its own; the stores additionally ignore temps young enough
 * that another process might still own them.
 */
async function cleanTempFiles(): Promise<void> {
  const [staleMatches, staleCredentials] = await Promise.all([
    matchStore.cleanOrphanedTempFiles(),
    credentialStore.cleanOrphanedTempFiles(),
  ]);
  const total = staleMatches + staleCredentials;
  if (total > 0) console.log(`Cleaned ${total} orphaned temp file(s) from a previous crash`);
}
const limiter = new RateLimiter(readRateLimits());
attachGameServer(httpServer, matches, auth, tls, limiter);

// Listening only after the sweep: it must not race a save of its own.
cleanTempFiles()
  .catch((err) => console.warn("[server] could not clean temp files", err))
  .finally(() => {
  httpServer.listen(port, () => {
    const scheme = terminatesTls(tls) ? "wss" : "ws";
    console.log(`Redline Commander server listening on ${scheme}://localhost:${port}/play`);
    console.log(`Transport: ${describePosture(tls)}`);
    console.log(`Rate limits: ${limiter.describe()}`);
    if (tls.allowInsecure) {
      console.warn("WARNING: REDLINE_ALLOW_INSECURE is set. Device secrets travel in "
        + "cleartext and anyone on the network path can steal them.");
    }
    console.log(`State: ${stateDir}`);
  });
  });
