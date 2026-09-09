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

/** Long enough to satisfy the server's token rules; see server/src/auth. */
const tokenFor = (playerId) => `smoke-token-for-${playerId}-0000`;

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : ` (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
}

function open(playerId, token = tokenFor(playerId)) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    ws.inbox = [];
    ws.on("message", (data) => ws.inbox.push(JSON.parse(data.toString())));
    ws.on("error", reject);
    ws.on("open", () => {
      ws.send(JSON.stringify({ t: "hello", playerId, token, clientVersion: "0.2.0" }));
      resolve(ws);
    });
  });
}

/** Most recent message of a type - earlier ones are stale lobby states. */
const last = (ws, t) => [...ws.inbox].reverse().find((m) => m.t === t);
const send = (ws, message) => ws.send(JSON.stringify(message));

(async () => {
  // Auth first, on an identity of its own. A second connection claiming an
  // id displaces the first, so probing with the match players' ids would
  // pull the socket out from under the match being set up.
  const first = await open("smoke-carol");
  await wait(200);
  check("a new device registers on first use", last(first, "welcome") !== undefined, true);
  first.close();
  await wait(100);

  const returning = await open("smoke-carol");
  await wait(200);
  check("and is recognised when it comes back", last(returning, "welcome") !== undefined, true);
  returning.close();
  await wait(100);

  const impostor = await open("smoke-carol", "wrong-token-entirely-0000");
  await wait(200);
  check("an impostor with the wrong secret is refused", last(impostor, "error")?.code, "auth_failed");
  check("and is told nothing else", last(impostor, "welcome"), undefined);
  impostor.close();

  const malformed = await open("smoke-carol", "short");
  await wait(200);
  check("a malformed token is refused on shape", last(malformed, "error")?.code, "invalid_token");
  malformed.close();

  const traversal = await open("../../etc/passwd", tokenFor("x"));
  await wait(200);
  check("a path-traversal id is refused", last(traversal, "error")?.code, "invalid_player_id");
  traversal.close();
  await wait(100);

  // Messages from one connection must be handled in order. Authenticating
  // is async, so without an explicit queue a follow-up sent in the same tick
  // as `hello` overtakes it and is rejected as unauthenticated.
  const impatient = new WebSocket(URL);
  impatient.inbox = [];
  impatient.on("message", (data) => impatient.inbox.push(JSON.parse(data.toString())));
  await new Promise((resolve) => impatient.on("open", resolve));
  impatient.send(JSON.stringify({
    t: "hello", playerId: "smoke-eager", token: tokenFor("smoke-eager"), clientVersion: "0.2.0",
  }));
  impatient.send(JSON.stringify({ t: "createMatch", mapId: "crossing", faction: "crimson_alliance" }));
  await wait(250);
  check("a message sent in the same tick as hello is not overtaken",
    last(impatient, "error")?.code, undefined);
  check("and is acted on once authentication finishes",
    typeof last(impatient, "matchCreated")?.matchId, "string");
  impatient.close();
  await wait(100);

  // Rate limiting, on an identity of its own so the flood does not spend the
  // match players' allowance. The checks that follow all passing is itself
  // the evidence that ordinary play stays well under the limit.
  const flooder = await open("smoke-flood");
  await wait(200);
  check("the flooder is welcomed first", last(flooder, "welcome") !== undefined, true);
  for (let i = 0; i < 200; i += 1) {
    flooder.send(JSON.stringify({ t: "ping" }));
  }
  await wait(400);
  const limited = flooder.inbox.filter((m) => m.t === "error" && m.code === "rate_limited");
  const pongs = flooder.inbox.filter((m) => m.t === "pong");
  check("a flood is rate limited", limited.length > 0, true);
  check("but the first messages still got through", pongs.length > 0, true);
  check("and most of the flood did not", pongs.length < 100, true);
  flooder.close();
  await wait(100);

  // An oversized frame is refused by the transport before it is ever parsed.
  const fat = await open("smoke-fatframe");
  await wait(200);
  const closed = new Promise((resolve) => fat.on("close", (code) => resolve(code)));
  fat.send(JSON.stringify({ t: "ping", padding: "x".repeat(200_000) }));
  const closeCode = await Promise.race([closed, wait(1500).then(() => "never closed")]);
  check("an oversized frame closes the connection", closeCode, 1009);

  // A rate-limited handshake must CLOSE the socket, not drop the frame: a
  // client sends `hello` once, so a dropped one leaves it connected forever
  // with no way to recover.
  const chatty = new WebSocket(URL);
  chatty.inbox = [];
  chatty.on("message", (data) => chatty.inbox.push(JSON.parse(data.toString())));
  await new Promise((resolve) => chatty.on("open", resolve));
  const chattyClosed = new Promise((resolve) => chatty.on("close", (code) => resolve(code)));
  for (let i = 0; i < 30; i += 1) {
    chatty.send(JSON.stringify({ t: "ping" }));
  }
  check("a pre-auth flood closes the socket rather than stranding it",
    await Promise.race([chattyClosed, wait(2000).then(() => "never closed")]), 4003);

  // One identity per socket. A second hello used to leave the first player
  // mapped to this session with nothing to remove it on close.
  const doubled = await open("smoke-twice");
  await wait(200);
  check("the first hello is welcomed", last(doubled, "welcome") !== undefined, true);
  doubled.send(JSON.stringify({
    t: "hello", playerId: "smoke-other", token: tokenFor("smoke-other"), clientVersion: "0.2.0",
  }));
  await wait(250);
  check("a second hello on the same socket is refused",
    last(doubled, "error")?.code, "already_authenticated");
  doubled.close();
  await wait(100);

  const a = await open("smoke-alice");
  const b = await open("smoke-bob");
  await wait(200);
  check("both match players are welcomed",
    [last(a, "welcome") !== undefined, last(b, "welcome") !== undefined], [true, true]);

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
