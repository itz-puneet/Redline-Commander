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

const port = Number(process.env.PORT ?? 2567);
// Relative to the working directory (i.e. server/) rather than __dirname, so
// it lands in the same place whether running from src/ or build/.
const dataDir = process.env.REDLINE_MATCH_DIR ?? path.resolve(process.cwd(), ".matches");

const app = express();
app.get("/health", (_req, res) => res.json({ ok: true, service: "redline-commander" }));

const httpServer = http.createServer(app);
const matches = new MatchService(new FileMatchStore(dataDir));
attachGameServer(httpServer, matches);

httpServer.listen(port, () => {
  console.log(`Redline Commander server listening on ws://localhost:${port}/play`);
  console.log(`Match storage: ${dataDir}`);
});
