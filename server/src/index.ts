/**
 * Redline Commander - authoritative match server.
 *
 * Bootstrap only: wire storage -> match service -> websocket transport.
 */

import http from "http";
import path from "path";
import express from "express";
import { attachGameServer } from "./net/server";
import { MatchService } from "./match/MatchService";
import { FileMatchStore } from "./match/MatchStore";
import { AuthService } from "./auth/AuthService";
import { FileCredentialStore } from "./auth/CredentialStore";

const port = Number(process.env.PORT ?? 2567);
// Durable server state: matches in progress and device credentials. Named
// REDLINE_STATE_DIR rather than the old REDLINE_MATCH_DIR now that it holds
// more than matches, and distinct from REDLINE_DATA_DIR, which points at the
// read-only shared data tables.
//
// Relative to the working directory (i.e. server/) rather than __dirname, so
// it lands in the same place whether running from src/ or build/.
const stateDir = process.env.REDLINE_STATE_DIR ?? path.resolve(process.cwd(), ".state");

const app = express();
app.get("/health", (_req, res) => res.json({ ok: true, service: "redline-commander" }));

const httpServer = http.createServer(app);
const matches = new MatchService(new FileMatchStore(path.join(stateDir, "matches")));
const auth = new AuthService(new FileCredentialStore(path.join(stateDir, "credentials")));
attachGameServer(httpServer, matches, auth);

httpServer.listen(port, () => {
  console.log(`Redline Commander server listening on ws://localhost:${port}/play`);
  console.log(`State: ${stateDir}`);
});
