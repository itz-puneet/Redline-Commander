extends Node
## Checks the lobby and the screen routing.
##
## No socket anywhere. The lobby is a dumb view that emits intents, so its
## rules are tested by pressing buttons; the router is driven by emitting
## the Net autoload's signals directly, which is exactly what the real
## socket would do to it.
##
##   cd client && godot --headless res://tests/lobby_check.tscn

const LOBBY_SCENE := preload("res://scenes/lobby.tscn")
const MAIN_SCENE := preload("res://scenes/main.tscn")

var _failures := 0
var _lobby: Control = null
var _intents: Array[Dictionary] = []


func _ready() -> void:
	_check_server_urls()
	await _check_lobby_view()
	await _check_routing()

	if _failures == 0:
		print("\nlobby_check: all checks passed")
	else:
		printerr("\nlobby_check: %d check(s) FAILED" % _failures)
	get_tree().quit(0 if _failures == 0 else 1)


func _check(label: String, condition: bool, detail: String = "") -> void:
	if condition:
		print("ok   %s" % label)
	else:
		_failures += 1
		printerr("FAIL %s%s" % [label, "" if detail.is_empty() else " (%s)" % detail])


func _node(path: String) -> Node:
	return _lobby.get_node("Center/Panel/Margin/Column/" + path)


## --- server addresses --------------------------------------------------

## The device secret travels in the first frame, so an unencrypted address to
## anything but this machine gives it away. The client says so in advance
## rather than leaving the player with an opaque refusal.
func _check_server_urls() -> void:
	_check("wss is recognised as secure", ServerUrl.is_secure("wss://example.com:2567/play"))
	_check("ws is not", not ServerUrl.is_secure("ws://example.com:2567/play"))
	_check("and the check is not fooled by case",
		ServerUrl.is_secure("WSS://Example.com/play"))

	_check("a host is extracted without port or path",
		ServerUrl.host_of("wss://play.example.com:2567/play") == "play.example.com",
		"got '%s'" % ServerUrl.host_of("wss://play.example.com:2567/play"))
	_check("an IPv6 literal survives extraction",
		ServerUrl.host_of("ws://[::1]:2567/play") == "[::1]",
		"got '%s'" % ServerUrl.host_of("ws://[::1]:2567/play"))

	for local in ["ws://localhost:2567/play", "ws://127.0.0.1:2567/play", "ws://[::1]:2567/play"]:
		_check("%s counts as local" % local, ServerUrl.is_local(local))
	_check("a remote host does not", not ServerUrl.is_local("ws://play.example.com:2567/play"))

	# Plaintext to localhost is fine - nothing crosses a wire.
	_check("no warning for plaintext on this machine",
		ServerUrl.risk_of("ws://localhost:2567/play").is_empty())
	_check("no warning for a secure remote address",
		ServerUrl.risk_of("wss://play.example.com:2567/play").is_empty())
	_check("but plaintext to a remote host is called out",
		ServerUrl.risk_of("ws://play.example.com:2567/play").contains("wss://"),
		"got '%s'" % ServerUrl.risk_of("ws://play.example.com:2567/play"))
	_check("and nonsense is called out too",
		not ServerUrl.risk_of("play.example.com").is_empty())

	_check("a bare host is assumed to want the secure scheme",
		ServerUrl.normalise("play.example.com:2567/play") == "wss://play.example.com:2567/play",
		"got '%s'" % ServerUrl.normalise("play.example.com:2567/play"))
	_check("https becomes wss",
		ServerUrl.normalise("https://play.example.com/play") == "wss://play.example.com/play")
	_check("http becomes ws, rather than being silently upgraded",
		ServerUrl.normalise("http://localhost:2567/play") == "ws://localhost:2567/play")
	_check("an address that is already right is left alone",
		ServerUrl.normalise("  wss://play.example.com/play  ") == "wss://play.example.com/play")
	_check("and an empty field stays empty", ServerUrl.normalise("   ") == "")

	# A join that the server refuses must not leave a match id behind: Net
	# re-sends `rejoinMatch` for whatever it holds on every reconnect, so a
	# bogus one is asked for forever.
	var before := Net.current_match_id
	Net.current_match_id = ""
	Net.join_match("never-accepted", "crimson_alliance")
	_check("joining does not claim the match before the server seats us",
		Net.current_match_id.is_empty(), "held '%s'" % Net.current_match_id)
	Net.current_match_id = before

	_check("a valid address validates", ServerUrl.is_valid("wss://example.com/play"))
	_check("a schemeless one does not", not ServerUrl.is_valid("example.com/play"))
	_check("and neither does an empty one", not ServerUrl.is_valid(""))


## --- the lobby view ----------------------------------------------------

func _check_lobby_view() -> void:
	Session.forget_match()
	_lobby = LOBBY_SCENE.instantiate()
	add_child(_lobby)
	await get_tree().process_frame

	_lobby.create_requested.connect(func(m, f): _intents.append({"t": "create", "map": m, "faction": f}))
	_lobby.join_requested.connect(func(m, f): _intents.append({"t": "join", "match": m, "faction": f}))
	_lobby.rejoin_requested.connect(func(m): _intents.append({"t": "rejoin", "match": m}))

	var faction: OptionButton = _node("FactionRow/Faction")
	var map: OptionButton = _node("MapRow/Map")
	_check("factions come from the data table", faction.item_count == GameData.factions.size(),
		"%d items for %d factions" % [faction.item_count, GameData.factions.size()])
	_check("maps come from the map index", map.item_count == GameData.map_list().size(),
		"%d items for %d maps" % [map.item_count, GameData.map_list().size()])
	_check("a faction is preselected", not _lobby.selected_faction().is_empty())
	_check("a map is preselected", _lobby.selected_map() == "crossing",
		"got %s" % _lobby.selected_map())

	# Nothing should be actionable before the socket is up.
	var create: Button = _node("Create")
	var join: Button = _node("JoinRow/Join")
	_check("buttons are disabled while disconnected", create.disabled and join.disabled)

	_lobby.set_connected(false)
	create.pressed.emit()
	_check("creating while disconnected emits nothing", _intents.is_empty())

	_lobby.set_connected(true)
	_check("buttons enable once connected", not create.disabled and not join.disabled)

	create.pressed.emit()
	_check("creating emits the selected map and faction",
		_intents.size() == 1 and _intents[0]["t"] == "create"
		and _intents[0]["map"] == "crossing"
		and _intents[0]["faction"] == _lobby.selected_faction(),
		"got %s" % [_intents])

	# Joining with nothing typed is a mistake, not a request.
	_intents.clear()
	join.pressed.emit()
	_check("joining with an empty code emits nothing", _intents.is_empty())
	_check("and explains why", not (_node("Message") as Label).text.is_empty())

	var code: LineEdit = _node("JoinRow/Code")
	code.text = "  AB12CD  "
	join.pressed.emit()
	_check("joining trims and normalises the code",
		_intents.size() == 1 and _intents[0]["match"] == "ab12cd",
		"got %s" % [_intents])

	# A second press while a request is outstanding must not fire again.
	_intents.clear()
	_lobby.set_busy(true, "Creating match...")
	create.pressed.emit()
	create.pressed.emit()
	_check("a busy lobby ignores further presses", _intents.is_empty())
	_lobby.set_busy(false)

	# Rejoin only exists when there is something to rejoin.
	var rejoin: Button = _node("Rejoin")
	_check("rejoin is hidden with no remembered match", not rejoin.visible)

	Session.remember_match("deadbeef")
	_lobby.set_connected(true)
	_check("rejoin appears once a match is remembered", rejoin.visible)
	_check("and names the match", rejoin.text.contains("deadbeef"), "got '%s'" % rejoin.text)

	_intents.clear()
	rejoin.pressed.emit()
	_check("rejoin emits the remembered match id",
		_intents.size() == 1 and _intents[0]["match"] == "deadbeef", "got %s" % [_intents])

	_lobby.queue_free()
	_lobby = null
	await get_tree().process_frame


## --- routing -----------------------------------------------------------

## Drives App by emitting the Net signals the real socket would emit.
func _check_routing() -> void:
	Session.forget_match()
	var app: App = MAIN_SCENE.instantiate()
	add_child(app)
	await get_tree().process_frame

	_check("the app opens on the lobby", app.current_screen() == "lobby",
		"on %s" % app.current_screen())

	# A created match sits in lobby phase until the opponent arrives.
	Net.match_created.emit("abc123", "abc123")
	await get_tree().process_frame
	_check("creating a match remembers it", Session.last_match_id == "abc123")
	_check("and stays on the lobby while waiting", app.current_screen() == "lobby")

	var waiting := Fixtures.match_view()
	waiting["phase"] = "lobby"
	Net.update_received.emit([], waiting)
	await get_tree().process_frame
	_check("a lobby-phase view does not start the match",
		app.current_screen() == "lobby", "on %s" % app.current_screen())

	# The opponent joins: the match is active, so the board takes over.
	Net.update_received.emit([], Fixtures.match_view())
	await get_tree().process_frame
	_check("an active view switches to the match screen",
		app.current_screen() == "match", "on %s" % app.current_screen())

	var controller: MatchController = app.get_node("Screens").get_child(0).get_node("MatchController")
	_check("the match screen is seeded with the view that started it",
		controller.state() != null and controller.state().map_width == 15)
	_check("and the board can be commanded straight away",
		controller.state().is_my_turn())

	# A further update must not re-enter the match screen and wipe state.
	var progressed := Fixtures.match_view()
	progressed["roundNumber"] = 9
	Net.update_received.emit([], progressed)
	await get_tree().process_frame
	_check("later updates stay on the same screen", app.current_screen() == "match")

	# An error while a match is up must not throw the player back to a lobby
	# that no longer exists.
	Net.server_error.emit("internal_error", "")
	await get_tree().process_frame
	_check("a server error during a match does not bounce to the lobby",
		app.current_screen() == "match")

	app.queue_free()
	await get_tree().process_frame

	await _check_stale_rejoin_cleared()
	await _check_auth_failure()


## The server refusing this device is the one failure retrying cannot fix,
## so the lobby has to offer a way out of it.
func _check_auth_failure() -> void:
	Session.forget_match()
	var app: App = MAIN_SCENE.instantiate()
	add_child(app)
	await get_tree().process_frame

	var lobby: Control = app.get_node("Screens").get_child(0)
	var reset: Button = lobby.get_node("Center/Panel/Margin/Column/ResetIdentity")
	var message: Label = lobby.get_node("Center/Panel/Margin/Column/Message")
	_check("no identity reset is offered by default", not reset.visible)

	Net.server_error.emit("no_such_match", "")
	await get_tree().process_frame
	_check("an ordinary error does not offer one either", not reset.visible)

	var before := PlayerIdentity.player_id
	Net.server_error.emit("auth_failed", "")
	await get_tree().process_frame
	_check("a refused identity offers a reset", reset.visible)
	_check("and says so in plain words",
		message.text.to_lower().contains("credentials"), "got '%s'" % message.text)
	_check("without resetting anything on its own", PlayerIdentity.player_id == before)

	reset.pressed.emit()
	await get_tree().process_frame
	_check("pressing it issues a new identity", PlayerIdentity.player_id != before)
	_check("with a new secret too", not PlayerIdentity.token.is_empty())
	_check("and stops offering the reset", not reset.visible)

	# Being displaced by another device is a different story with the same
	# shape: stop, explain, do not silently fight over the seat.
	Net.replaced_by_other_device.emit()
	await get_tree().process_frame
	_check("being replaced returns to the lobby", app.current_screen() == "lobby")
	_check("and explains why", message.text.to_lower().contains("another device"),
		"got '%s'" % message.text)

	app.queue_free()
	await get_tree().process_frame


## A remembered match the server has forgotten must stop being offered.
func _check_stale_rejoin_cleared() -> void:
	Session.remember_match("gone")
	var app: App = MAIN_SCENE.instantiate()
	add_child(app)
	await get_tree().process_frame

	Net.server_error.emit("no_such_match", "")
	await get_tree().process_frame
	_check("a rejoin the server rejects is forgotten", not Session.has_match(),
		"still remembers %s" % Session.last_match_id)

	app.queue_free()
	await get_tree().process_frame
