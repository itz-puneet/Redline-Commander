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

const port = Number(process.env.PORT ?? 2567);
// Durable server state: matches in progress and device credentials. Named
// REDLINE_STATE_DIR rather than the old REDLINE_MATCH_DIR now that it holds
// more than matches, and distinct from REDLINE_DATA_DIR, which points at the
// read-only shared data tables.
//
// Relative to the working directory (i.e. server/) rather than __dirname, so
// it lands in the same place whether running from src/ or build/.
const stateDir = process.env.REDLINE_STATE_DIR ?? path.resolve(process.cwd(), ".state");

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
const matches = new MatchService(new FileMatchStore(path.join(stateDir, "matches")));
const auth = new AuthService(new FileCredentialStore(path.join(stateDir, "credentials")));
attachGameServer(httpServer, matches, auth, tls);

httpServer.listen(port, () => {
  const scheme = terminatesTls(tls) ? "wss" : "ws";
  console.log(`Redline Commander server listening on ${scheme}://localhost:${port}/play`);
  console.log(`Transport: ${describePosture(tls)}`);
  if (tls.allowInsecure) {
    console.warn("WARNING: REDLINE_ALLOW_INSECURE is set. Device secrets travel in "
      + "cleartext and anyone on the network path can steal them.");
  }
  console.log(`State: ${stateDir}`);
});
