/**
 * End-to-end protocol smoke test.
 *
 * Drives two real WebSocket clients through a match: create, join, an
 * out-of-turn rejection, a move, a turn hand-off, and a reconnect. It checks
 * the things the unit tests structurally cannot - that the transport, the
 * per-player fog filtering and the persistence actually line up over a real
 * socket.
 *
 * Start the server first (`npm run dev`), then: node scripts/smoke.js
 */

const { WebSocket } = require("ws");

const URL = process.env.REDLINE_URL || "ws://localhost:2567/play";
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : ` (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
}

function open(playerId) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    ws.inbox = [];
    ws.on("message", (data) => ws.inbox.push(JSON.parse(data.toString())));
    ws.on("error", reject);
    ws.on("open", () => {
      ws.send(JSON.stringify({ t: "hello", playerId, token: "dev", clientVersion: "0.2.0" }));
      resolve(ws);
    });
  });
}

/** Most recent message of a type - earlier ones are stale lobby states. */
const last = (ws, t) => [...ws.inbox].reverse().find((m) => m.t === t);
const send = (ws, message) => ws.send(JSON.stringify(message));

(async () => {
  const a = await open("smoke-alice");
  const b = await open("smoke-bob");
  await wait(150);
  check("both clients are welcomed", [last(a, "welcome") !== undefined, last(b, "welcome") !== undefined], [true, true]);

  send(a, { t: "createMatch", mapId: "crossing", faction: "crimson_alliance" });
  await wait(200);
  const matchId = last(a, "matchCreated").matchId;
  check("match was created", typeof matchId, "string");

  send(b, { t: "joinMatch", matchId, faction: "azure_federation" });
  await wait(250);

  const aView = last(a, "update").view;
  const bView = last(b, "update").view;
  check("the match starts once both seats are filled", aView.phase, "active");
  check("slot 1 moves first", aView.currentSlot, 1);
  check("A sees only its own units across the map", aView.units.filter((u) => u.ownerSlot === 2).length, 0);
  check("B sees only its own units across the map", bView.units.filter((u) => u.ownerSlot === 1).length, 0);
  check("A cannot see B's funds", aView.players.find((p) => p.slot === 2).funds, null);

  // Acting out of turn must be refused, and only the offender may hear about it.
  a.inbox.length = 0;
  b.inbox.length = 0;
  send(b, { t: "action", matchId, action: { type: "wait", unitId: bView.units[0].id } });
  await wait(200);
  check("out-of-turn action is rejected", last(b, "actionRejected").reason, "not_your_turn");
  check("the opponent is not told about a rejection", a.inbox.length, 0);

  // A move A can see, that B should not be told about.
  const infantry = aView.units.find((u) => u.unitType === "infantry");
  a.inbox.length = 0;
  b.inbox.length = 0;
  send(a, { t: "action", matchId, action: { type: "move", unitId: infantry.id, path: [{ x: infantry.x + 1, y: infantry.y }] } });
  await wait(200);
  check("the mover sees its own move event", last(a, "update").events.map((e) => e.type), ["unitMoved"]);
  check("the opponent is not told about a move out of their sight", last(b, "update").events, []);

  send(a, { t: "action", matchId, action: { type: "endTurn" } });
  await wait(200);
  check("the turn passes to slot 2", last(b, "update").view.currentSlot, 2);

  // Dropping the connection must not cost the seat or the match.
  b.close();
  await wait(200);
  const b2 = await open("smoke-bob");
  await wait(150);
  send(b2, { t: "rejoinMatch", matchId });
  await wait(250);
  const resumed = last(b2, "state").view;
  check("a reconnecting player resumes their seat", resumed.youSlot, 2);
  check("and the match state survived the drop", resumed.currentSlot, 2);
  check("with their units intact", resumed.units.filter((u) => u.ownerSlot === 2).length, 3);

  a.close();
  b2.close();
  console.log(failures === 0 ? "\nsmoke: all checks passed" : `\nsmoke: ${failures} check(s) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error("smoke: could not run -", err.message);
  console.error("is the server running? (npm run dev)");
  process.exit(1);
});
