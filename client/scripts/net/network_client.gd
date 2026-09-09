extends Node
## Autoload: Net
##
## Talks to the match server over a plain WebSocket, exchanging JSON text
## frames (docs/PROTOCOL.md). Deliberately a thin transport: it does not know
## any game rules and never decides anything - it emits what the server said
## and lets MatchState adopt it.
##
## Auto-reconnects with backoff and re-issues `rejoinMatch`, because a phone
## loses its connection constantly (backgrounded app, wifi to cellular) and
## none of that should cost the player their match.

signal connected()
signal disconnected()
signal welcomed(player_id: String)
signal match_created(match_id: String, join_code: String)
## Full authoritative snapshot, already fog-filtered for this player.
signal state_received(view: Dictionary)
## Incremental: events to animate, plus the resulting view to adopt.
signal update_received(events: Array, view: Dictionary)
signal action_rejected(reason: String, view: Dictionary)
signal server_error(code: String, detail: String)
## This device was signed in somewhere else and lost the connection to it.
signal replaced_by_other_device()
## The opponent came or went. Presence arrives on its own, not inside a view,
## because nothing about the board changed.
signal opponent_connection_changed(slot: int, connected: bool)

const PROTOCOL_VERSION := 1
const RECONNECT_DELAYS := [1.0, 2.0, 4.0, 8.0, 15.0]

## Server errors that reconnecting cannot fix. Retrying these would spin
## forever against a server that has already made up its mind.
const FATAL_ERROR_CODES := [
	"auth_failed", "invalid_player_id", "invalid_token", "insecure_transport",
]

## Close codes the server uses deliberately (server/src/net/server.ts).
const CLOSE_REPLACED := 4000
const CLOSE_AUTH_FAILED := 4001
const CLOSE_INSECURE := 4002
const CLOSE_RATE_LIMITED := 4003

var server_url: String = "ws://localhost:2567/play"
var current_match_id: String = ""

## A certificate to trust in addition to the system store, for a server using
## a self-signed cert on a home network. Leave null for a real certificate.
var trusted_certificate: X509Certificate = null

var _socket := WebSocketPeer.new()
var _last_state := WebSocketPeer.STATE_CLOSED
var _want_connection := false
var _reconnect_attempt := 0
var _reconnect_timer := 0.0


func _ready() -> void:
	set_process(true)


## True once the socket is open. The lobby uses this to decide whether its
## buttons should do anything.
func is_connected_to_server() -> bool:
	return _socket.get_ready_state() == WebSocketPeer.STATE_OPEN


func connect_to_server(url: String = "") -> void:
	if not url.is_empty():
		server_url = url
	_want_connection = true
	_reconnect_attempt = 0
	_open()


func disconnect_from_server() -> void:
	_want_connection = false
	current_match_id = ""
	_socket.close()


## Trust a specific certificate file, for a self-signed server. Returns
## false if it cannot be read, so a typo in the path is not mistaken for a
## certificate problem later.
func trust_certificate_file(path: String) -> bool:
	var certificate := X509Certificate.new()
	if certificate.load(path) != OK:
		push_warning("Net: could not load certificate %s" % path)
		return false
	trusted_certificate = certificate
	return true


func _open() -> void:
	# Connecting over a socket that is still live returns ERR_ALREADY_IN_USE
	# and would arm a reconnect timer while the existing connection quietly
	# stopped being polled. A fresh peer each time avoids reusing one that is
	# mid-teardown.
	if _socket.get_ready_state() != WebSocketPeer.STATE_CLOSED:
		_socket.close()
	_socket = WebSocketPeer.new()

	# A pinned certificate only means anything over wss://.
	var options: TLSOptions = null
	if ServerUrl.is_secure(server_url) and trusted_certificate != null:
		options = TLSOptions.client(trusted_certificate)

	var err := _socket.connect_to_url(server_url, options)
	if err != OK:
		push_warning("Net: connect_to_url(%s) failed: %s" % [server_url, err])
		_schedule_reconnect()
		return

	# Record that a connection is in progress. Without this the socket sits
	# at CLOSED both before and after a failed attempt, so the transition
	# below never fires and the reconnect loop dies silently.
	_last_state = WebSocketPeer.STATE_CONNECTING


func _process(delta: float) -> void:
	if _reconnect_timer > 0.0:
		_reconnect_timer -= delta
		if _reconnect_timer <= 0.0:
			_open()
		return

	# Always poll: a socket that is not read is a socket that never reports
	# it has died.
	_socket.poll()
	var state := _socket.get_ready_state()

	if state == WebSocketPeer.STATE_OPEN:
		if _last_state != WebSocketPeer.STATE_OPEN:
			_on_opened()
		while _socket.get_available_packet_count() > 0:
			_handle_packet(_socket.get_packet().get_string_from_utf8())
	elif state == WebSocketPeer.STATE_CLOSED and _last_state != WebSocketPeer.STATE_CLOSED:
		var close_code := _socket.get_close_code()
		disconnected.emit()

		# Two devices reconnecting at each other would fight forever, and a
		# rejected identity will be rejected again, so neither retries.
		if close_code == CLOSE_REPLACED:
			_want_connection = false
			replaced_by_other_device.emit()
		elif close_code == CLOSE_AUTH_FAILED or close_code == CLOSE_INSECURE:
			_want_connection = false
		elif close_code == CLOSE_RATE_LIMITED:
			# Reconnecting straight into a limit only deepens it. Skip to the
			# far end of the backoff rather than hammering.
			_reconnect_attempt = RECONNECT_DELAYS.size() - 1

		if _want_connection:
			_schedule_reconnect()

	_last_state = state


func _on_opened() -> void:
	_reconnect_attempt = 0
	connected.emit()
	# Identity first: nothing else is accepted before it.
	_send({
		"t": "hello",
		"playerId": PlayerIdentity.player_id,
		"token": PlayerIdentity.token,
		"clientVersion": ProjectSettings.get_setting("application/config/version", "0.0.0"),
	})
	# Re-attach to whatever match we were in before the drop.
	if not current_match_id.is_empty():
		_send({"t": "rejoinMatch", "matchId": current_match_id})


func _schedule_reconnect() -> void:
	var index: int = mini(_reconnect_attempt, RECONNECT_DELAYS.size() - 1)
	_reconnect_timer = float(RECONNECT_DELAYS[index])
	_reconnect_attempt += 1
	# _last_state is deliberately left alone. Forcing it to CLOSED here made
	# the next failed attempt indistinguishable from the previous one, so no
	# transition fired and nothing ever scheduled another try.


func _send(message: Dictionary) -> void:
	if _socket.get_ready_state() != WebSocketPeer.STATE_OPEN:
		push_warning("Net: dropping %s - socket not open" % message.get("t", "?"))
		return
	_socket.send_text(JSON.stringify(message))


func _handle_packet(raw: String) -> void:
	var parsed: Variant = JSON.parse_string(raw)
	if typeof(parsed) != TYPE_DICTIONARY:
		push_warning("Net: unparseable frame")
		return

	var message: Dictionary = parsed
	match String(message.get("t", "")):
		"welcome":
			var version := int(message.get("protocolVersion", 0))
			if version != PROTOCOL_VERSION:
				server_error.emit("protocol_mismatch",
					"server speaks v%d, client speaks v%d" % [version, PROTOCOL_VERSION])
			welcomed.emit(String(message.get("playerId", "")))
		"matchCreated":
			current_match_id = String(message.get("matchId", ""))
			match_created.emit(current_match_id, String(message.get("joinCode", "")))
		"state":
			var view: Dictionary = message.get("view", {})
			current_match_id = String(view.get("matchId", current_match_id))
			state_received.emit(view)
		"update":
			var view: Dictionary = message.get("view", {})
			current_match_id = String(view.get("matchId", current_match_id))
			update_received.emit(message.get("events", []), view)
		"actionRejected":
			action_rejected.emit(String(message.get("reason", "unknown")), message.get("view", {}))
		"error":
			var code := String(message.get("code", "unknown"))
			# Stop before the socket even closes, so no backoff timer is armed.
			if FATAL_ERROR_CODES.has(code):
				_want_connection = false
			server_error.emit(code, String(message.get("detail", "")))
		"opponentConnection":
			opponent_connection_changed.emit(
				int(message.get("slot", 0)), bool(message.get("connected", false)))
		"pong":
			pass
		_:
			push_warning("Net: unknown message type %s" % message.get("t", ""))


## --- outbound ----------------------------------------------------------

func create_match(map_id: String, faction: String) -> void:
	_send({"t": "createMatch", "mapId": map_id, "faction": faction})


func join_match(match_id: String, faction: String) -> void:
	# Not recorded until the server actually seats us. A refused join used to
	# leave this set, and every later reconnect asked to rejoin a match we
	# were never in.
	_send({"t": "joinMatch", "matchId": match_id, "faction": faction})


func rejoin_match(match_id: String) -> void:
	current_match_id = match_id
	_send({"t": "rejoinMatch", "matchId": match_id})


## One action per message. The client never batches a turn: with fog of war
## and a server-side damage roll it cannot know the outcome of action N
## before it has seen the result of action N-1.
func send_action(action: Dictionary) -> void:
	if current_match_id.is_empty():
		push_warning("Net: send_action with no active match")
		return
	_send({"t": "action", "matchId": current_match_id, "action": action})
