extends Node
## End-to-end check against a REAL server.
##
## Everything else in tests/ runs offline against fixtures. This one drives
## the actual app - lobby, socket, protocol, board - so the pieces are proven
## to fit together rather than each being right on its own.
##
##   # terminal 1
##   cd server && npm run dev
##   # terminal 2
##   cd server && node scripts/host-match.js /tmp/code.txt
##   # terminal 3
##   cd client && REDLINE_JOIN_CODE=$(cat /tmp/code.txt) \
##     xvfb-run -a godot --resolution 1280x720 res://tests/live_check.tscn
##
## Needs a real renderer, and a join code from a host that is already
## waiting. Writes a screenshot of the live board to user://live_check.png.

const MAIN_SCENE := preload("res://scenes/main.tscn")
const OUTPUT := "user://live_check.png"
const TIMEOUT_SECONDS := 20.0

var _failures := 0
var _app: App = null


func _ready() -> void:
	var code := OS.get_environment("REDLINE_JOIN_CODE").strip_edges()
	if code.is_empty():
		printerr("live_check: set REDLINE_JOIN_CODE to a waiting match's code")
		get_tree().quit(1)
		return

	# Start clean so the lobby offers a join rather than a stale rejoin.
	Session.forget_match()

	# A self-signed dev certificate is trusted only if we are handed it; a
	# real deployment uses a CA-signed one and needs none of this.
	var ca_path := OS.get_environment("REDLINE_TLS_CA").strip_edges()
	if not ca_path.is_empty():
		if not Net.trust_certificate_file(ca_path):
			printerr("live_check: could not load the certificate at %s" % ca_path)
			get_tree().quit(1)
			return
		print("live_check: trusting the certificate at %s" % ca_path)

	_app = MAIN_SCENE.instantiate()
	add_child(_app)
	await get_tree().process_frame

	if not await _wait_until(func(): return Net.is_connected_to_server()):
		printerr("live_check: never connected - is the server running?")
		get_tree().quit(1)
		return
	_check("the app connects to a real server", true)
	_check("and opens on the lobby", _app.current_screen() == "lobby")

	# When the run is over TLS, say so - a green suite that silently fell
	# back to plaintext would prove the opposite of what it claims.
	var expected_url := OS.get_environment("REDLINE_SERVER_URL").strip_edges()
	if expected_url.begins_with("wss://"):
		_check("the connection is encrypted", ServerUrl.is_secure(Net.server_url),
			"connected to %s" % Net.server_url)

	await _join_through_the_lobby(code)

	if not await _wait_until(func(): return _app.current_screen() == "match"):
		_check("joining switches to the match screen", false, "still on lobby")
		_finish()
		return
	_check("joining a real match switches to the board", true)

	var controller: MatchController = _app.get_node("Screens").get_child(0).get_node("MatchController")
	var state: MatchState = controller.state()
	_check("the board has the server's state", state != null and state.map_width == 15)
	_check("we were seated as player 2", state.you_slot == 2, "got slot %d" % state.you_slot)
	_check("both players are in the match", state.players.size() == 2)
	_check("the server hid the opponent's funds",
		state.players[0].get("funds") == null)
	_check("fog is in effect", state.visible_tiles.size() < state.map_width * state.map_height,
		"%d tiles visible" % state.visible_tiles.size())

	# The host ends its turn on join, so control should come to us.
	if await _wait_until(func(): return controller.state().is_my_turn()):
		_check("the turn arrives from the server", true)
		var mine := controller.state().units_of(2)
		_check("we have units to command", mine.size() > 0, "%d units" % mine.size())
		if mine.size() > 0:
			var unit: Dictionary = mine[0]
			controller.tap_tile(Vector2i(int(unit["x"]), int(unit["y"])))
			_check("tapping our own unit selects it on a live board",
				controller.selected_unit_id() == String(unit["id"]))
	else:
		_check("the turn arrives from the server", false, "still the opponent's turn")

	await _screenshot()
	_finish()


func _check(label: String, condition: bool, detail: String = "") -> void:
	if condition:
		print("ok   %s" % label)
	else:
		_failures += 1
		printerr("FAIL %s%s" % [label, "" if detail.is_empty() else " (%s)" % detail])


## Go through the actual widgets rather than calling Net directly, so the
## lobby's own wiring is part of what this proves.
func _join_through_the_lobby(code: String) -> void:
	var lobby: Control = _app.get_node("Screens").get_child(0)
	var column := "Center/Panel/Margin/Column/"
	(lobby.get_node(column + "JoinRow/Code") as LineEdit).text = code
	(lobby.get_node(column + "JoinRow/Join") as Button).pressed.emit()


func _wait_until(predicate: Callable) -> bool:
	var elapsed := 0.0
	while elapsed < TIMEOUT_SECONDS:
		if predicate.call():
			return true
		await get_tree().process_frame
		elapsed += get_process_delta_time()
	return false


func _screenshot() -> void:
	await RenderingServer.frame_post_draw
	await get_tree().process_frame
	await RenderingServer.frame_post_draw
	var image := get_viewport().get_texture().get_image()
	if image.save_png(OUTPUT) == OK:
		print("live_check: wrote %s" % ProjectSettings.globalize_path(OUTPUT))


func _finish() -> void:
	if _failures == 0:
		print("\nlive_check: all checks passed")
	else:
		printerr("\nlive_check: %d check(s) FAILED" % _failures)
	get_tree().quit(0 if _failures == 0 else 1)
