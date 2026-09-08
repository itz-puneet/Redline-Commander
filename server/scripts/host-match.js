/**
 * Dev helper: hosts a match so the Godot client has someone to play against.
 *
 * Creates a match, writes its join code to the file given as the first
 * argument, then stays connected as player 1 and ends its turn once the
 * opponent joins - so the client under test gets an actionable board.
 *
 *   node scripts/host-match.js /tmp/code.txt
 *
 * Used by the client's live_check, and useful on its own when poking at the
 * app by hand without a second phone.
 */

const fs = require("fs");
const { WebSocket } = require("ws");

const URL = process.env.REDLINE_URL || "ws://localhost:2567/play";
const codeFile = process.argv[2];
if (!codeFile) {
  console.error("usage: node scripts/host-match.js <code-output-file>");
  process.exit(1);
}

const socket = new WebSocket(URL);
let matchId = null;
let endedTurn = false;

socket.on("open", () => {
  socket.send(JSON.stringify({
    t: "hello", playerId: "dev-host", token: "dev", clientVersion: "0.2.0",
  }));
  socket.send(JSON.stringify({
    t: "createMatch", mapId: "crossing", faction: "crimson_alliance",
  }));
});

socket.on("message", (data) => {
  const message = JSON.parse(data.toString());

  if (message.t === "matchCreated") {
    matchId = message.matchId;
    fs.writeFileSync(codeFile, matchId, "utf8");
    console.log(`host: created ${matchId}`);
    return;
  }

  if (message.t === "update" && message.view.phase === "active" && !endedTurn) {
    // Hand the turn to the client under test so its board is live.
    endedTurn = true;
    console.log("host: opponent joined, ending turn");
    socket.send(JSON.stringify({ t: "action", matchId, action: { type: "endTurn" } }));
  }
});

socket.on("error", (err) => {
  console.error("host: socket error", err.message);
  process.exit(1);
});
