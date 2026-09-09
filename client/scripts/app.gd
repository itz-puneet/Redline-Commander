class_name App
extends Node
## Application root: owns the connection and decides which screen is up.
##
## The lobby and the match screen know nothing about each other. This is the
## only place that talks to Net about lobby-level messages, and the only
## place that swaps screens - so "what happens when a match starts" is one
## readable function rather than something spread across two scenes.
##
## Once a match screen exists its own TurnController takes over receiving
## updates from Net. The first view arrives before that scene is built, so
## it is handed over explicitly rather than being missed.

signal screen_changed(screen_name: String)

const LOBBY_SCENE := preload("res://scenes/lobby.tscn")
const MATCH_SCENE := preload("res://scenes/match.tscn")

const DEFAULT_SERVER_URL := "ws://localhost:2567/play"

## Refusals about who this device is, rather than what it asked for.
const AUTH_ERROR_CODES := ["auth_failed", "invalid_player_id", "invalid_token"]

@onready var _screens: Node = $Screens

var _lobby: Control = null
var _match: Node = null
var _current := ""


func _ready() -> void:
	Net.connected.connect(_on_connected)
	Net.disconnected.connect(_on_disconnected)
	Net.match_created.connect(_on_match_created)
	Net.state_received.connect(_on_view)
	Net.update_received.connect(func(_events: Array, view: Dictionary): _on_view(view))
	Net.server_error.connect(_on_server_error)
	Net.replaced_by_other_device.connect(_on_replaced)

	show_lobby()
	Net.connect_to_server(_server_url())


## Remembers the last server that worked, so a friend's address or a tunnel
## URL does not have to be retyped every launch. REDLINE_SERVER_URL overrides
## it, which is how the end-to-end check aims the real client at a test
## server without touching stored settings.
func _server_url() -> String:
	var from_env := OS.get_environment("REDLINE_SERVER_URL").strip_edges()
	if not from_env.is_empty():
		return from_env
	var stored := String(ProjectSettings.get_setting("redline/server_url", ""))
	return stored if not stored.is_empty() else DEFAULT_SERVER_URL


## --- screens -----------------------------------------------------------

func current_screen() -> String:
	return _current


func show_lobby() -> void:
	if _match != null:
		_match.queue_free()
		_match = null

	if _lobby == null:
		_lobby = LOBBY_SCENE.instantiate()
		_screens.add_child(_lobby)
		_lobby.create_requested.connect(_on_create_requested)
		_lobby.join_requested.connect(_on_join_requested)
		_lobby.rejoin_requested.connect(_on_rejoin_requested)
		_lobby.reconnect_requested.connect(_on_reconnect_requested)
		_lobby.reset_identity_requested.connect(_on_reset_identity_requested)
		_lobby.set_server_url(_server_url())
		_lobby.set_connected(Net.is_connected_to_server())

	_current = "lobby"
	screen_changed.emit(_current)


## Swap to the board, seeding it with the view that got us here.
func show_match(view: Dictionary) -> void:
	if _lobby != null:
		_lobby.queue_free()
		_lobby = null

	if _match == null:
		_match = MATCH_SCENE.instantiate()
		_screens.add_child(_match)

	var controller: MatchController = _match.get_node("MatchController")
	controller.load_view(view)

	_current = "match"
	screen_changed.emit(_current)


## --- lobby intents -----------------------------------------------------

func _on_create_requested(map_id: String, faction: String) -> void:
	_lobby.set_busy(true, "Creating match...")
	Net.create_match(map_id, faction)


func _on_join_requested(match_id: String, faction: String) -> void:
	_lobby.set_busy(true, "Joining %s..." % match_id)
	Net.join_match(match_id, faction)


func _on_rejoin_requested(match_id: String) -> void:
	_lobby.set_busy(true, "Rejoining %s..." % match_id)
	Net.rejoin_match(match_id)


func _on_reconnect_requested(server_url: String) -> void:
	if server_url.is_empty():
		return

	# Accept a bare host or an http(s) URL and turn it into what was meant,
	# defaulting to the secure scheme.
	var url := ServerUrl.normalise(server_url)
	var risk := ServerUrl.risk_of(url)
	if not risk.is_empty():
		_lobby.set_server_url(url)
		_lobby.show_message(risk, true)
		if not ServerUrl.is_valid(url):
			return

	ProjectSettings.set_setting("redline/server_url", url)
	_lobby.set_server_url(url)
	_lobby.set_busy(true, "Connecting...")
	Net.connect_to_server(url)


## The last resort when the server will not accept this device: throw the
## credentials away and come back as somebody new. Any match the old identity
## was in is gone with it, which is why this is only ever offered, never done
## automatically.
func _on_reset_identity_requested() -> void:
	PlayerIdentity.reset()
	Session.forget_match()
	if _lobby != null:
		_lobby.show_message("New identity created. Reconnecting...")
	Net.connect_to_server(_server_url())


## --- network -----------------------------------------------------------

func _on_connected() -> void:
	if _lobby != null:
		_lobby.set_busy(false)
		_lobby.set_connected(true)
		_lobby.offer_identity_reset(false)
		_lobby.show_message("")


func _on_replaced() -> void:
	show_lobby()
	if _lobby != null:
		_lobby.set_busy(false)
		_lobby.set_connected(false)
		_lobby.show_message(
			"Signed in on another device. Only one at a time can hold a seat.", true)


func _on_disconnected() -> void:
	if _lobby != null:
		_lobby.set_busy(false)
		_lobby.set_connected(false)
	# A match in progress is not abandoned: Net reconnects and re-sends
	# rejoinMatch on its own, so the board simply resumes.


func _on_match_created(match_id: String, join_code: String) -> void:
	Session.remember_match(match_id)
	if _lobby != null:
		_lobby.show_waiting(join_code)


## Every view, from either a `state` or an `update`. The lobby waits here
## until the match actually starts - a created match sits in `lobby` phase
## until the second player joins.
func _on_view(view: Dictionary) -> void:
	if view.is_empty():
		return

	var match_id := String(view.get("matchId", ""))
	if not match_id.is_empty():
		Session.remember_match(match_id)

	var phase := String(view.get("phase", ""))
	if phase == "lobby":
		if _current == "lobby" and _lobby != null:
			_lobby.set_busy(true, "Waiting for an opponent...")
		return

	if _current != "match":
		show_match(view)


func _on_server_error(code: String, detail: String) -> void:
	if _current != "lobby" or _lobby == null:
		push_warning("Net error during match: %s %s" % [code, detail])
		return

	# A stale rejoin is the common case; clear it so the button stops lying.
	if code == "no_such_match" or code == "not_in_this_match":
		Session.forget_match()

	# The server has refused this device's credentials, and no amount of
	# retrying will change that - offer the one thing that can.
	if AUTH_ERROR_CODES.has(code):
		_lobby.offer_identity_reset(true)

	_lobby.set_busy(false)
	_lobby.set_connected(Net.is_connected_to_server())
	_lobby.show_message(_explain(code, detail), true)


## Protocol codes are stable and safe to show, but they are not English.
func _explain(code: String, detail: String) -> String:
	match code:
		"no_such_match": return "No match with that code."
		"match_full": return "That match already has two players."
		"already_joined": return "You are already in that match."
		"match_already_started": return "That match has already started."
		"not_in_this_match": return "You are not a player in that match."
		"unknown_faction": return "Pick a faction first."
		"not_authenticated": return "The server did not accept this device."
		"auth_failed": return "This device's credentials were refused. Another device may have registered the same identity."
		"invalid_player_id": return "This device's identity is malformed."
		"invalid_token": return "This device's credentials are malformed."
		"insecure_transport": return "The server refused an unencrypted connection. Use a wss:// address."
		"protocol_mismatch": return "Client and server versions do not match. %s" % detail
		_: return detail if not detail.is_empty() else code.replace("_", " ")
