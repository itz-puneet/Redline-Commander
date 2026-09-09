extends Control
## The lobby: connect, then create or join a match.
##
## A dumb view. It renders state and emits intents - it never talks to Net
## itself. App does the wiring, which is what lets every rule below be
## tested by pressing buttons with no socket anywhere in sight.
##
## Placeholder styling: this is the shape of the screen, not its final look.

signal create_requested(map_id: String, faction: String)
signal join_requested(match_id: String, faction: String)
signal rejoin_requested(match_id: String)
signal reconnect_requested(server_url: String)
## Abandon this device's identity and start again as a new player.
signal reset_identity_requested()

@onready var _status: Label = $Center/Panel/Margin/Column/Status
@onready var _server_url: LineEdit = $Center/Panel/Margin/Column/ServerRow/ServerUrl
@onready var _connect_button: Button = $Center/Panel/Margin/Column/ServerRow/Connect
@onready var _faction: OptionButton = $Center/Panel/Margin/Column/FactionRow/Faction
@onready var _map: OptionButton = $Center/Panel/Margin/Column/MapRow/Map
@onready var _create: Button = $Center/Panel/Margin/Column/Create
@onready var _join_code: LineEdit = $Center/Panel/Margin/Column/JoinRow/Code
@onready var _join: Button = $Center/Panel/Margin/Column/JoinRow/Join
@onready var _rejoin: Button = $Center/Panel/Margin/Column/Rejoin
@onready var _message: Label = $Center/Panel/Margin/Column/Message
@onready var _reset_identity: Button = $Center/Panel/Margin/Column/ResetIdentity

var _connected := false
var _busy := false


func _ready() -> void:
	_populate_factions()
	_populate_maps()

	_connect_button.pressed.connect(func(): reconnect_requested.emit(_server_url.text.strip_edges()))
	_create.pressed.connect(_on_create_pressed)
	_join.pressed.connect(_on_join_pressed)
	_rejoin.pressed.connect(_on_rejoin_pressed)
	_reset_identity.pressed.connect(func():
		offer_identity_reset(false)
		reset_identity_requested.emit())
	# Typing a code and hitting enter should just work.
	_join_code.text_submitted.connect(func(_text: String): _on_join_pressed())

	_refresh()


## Factions come from the shared data table, so adding one to
## factions.json puts it in the lobby with no code change.
func _populate_factions() -> void:
	_faction.clear()
	for faction_id in GameData.factions.keys():
		var faction: Dictionary = GameData.factions[faction_id]
		_faction.add_item(String(faction.get("display_name", faction_id)))
		_faction.set_item_metadata(_faction.item_count - 1, String(faction_id))
	if _faction.item_count > 0:
		_faction.select(0)


func _populate_maps() -> void:
	_map.clear()
	for entry in GameData.map_list():
		var map_data: Dictionary = entry
		var label := "%s  (%s)" % [map_data.get("display_name", map_data.get("id", "?")),
			map_data.get("size", "?")]
		_map.add_item(label)
		_map.set_item_metadata(_map.item_count - 1, String(map_data.get("id", "")))
	if _map.item_count > 0:
		_map.select(0)


## --- state from App ----------------------------------------------------

func set_server_url(url: String) -> void:
	_server_url.text = url


func set_connected(connected: bool) -> void:
	_connected = connected
	_status.text = "Connected" if connected else "Not connected"
	_refresh()


## Blocks the buttons while a request is outstanding, so an impatient double
## tap cannot create two matches.
func set_busy(busy: bool, note: String = "") -> void:
	_busy = busy
	if not note.is_empty():
		_status.text = note
	_refresh()


## Only offered when the server has actually refused this device - it throws
## away the identity, and with it any match that identity was in.
func offer_identity_reset(offer: bool) -> void:
	_reset_identity.visible = offer


func show_message(text: String, is_error: bool = false) -> void:
	_message.text = text
	_message.modulate = Color("#ff8a80") if is_error else Color("#cfd3dc")


func show_waiting(join_code: String) -> void:
	set_busy(true, "Waiting for an opponent...")
	show_message("Share this code: %s" % join_code)


func selected_faction() -> String:
	if _faction.selected < 0:
		return ""
	return String(_faction.get_item_metadata(_faction.selected))


func selected_map() -> String:
	if _map.selected < 0:
		return ""
	return String(_map.get_item_metadata(_map.selected))


## --- button handlers ---------------------------------------------------

func _on_create_pressed() -> void:
	if not _can_act():
		return
	create_requested.emit(selected_map(), selected_faction())


func _on_join_pressed() -> void:
	if not _can_act():
		return
	var code := _join_code.text.strip_edges().to_lower()
	if code.is_empty():
		show_message("Enter the code your friend shared with you.", true)
		return
	join_requested.emit(code, selected_faction())


func _on_rejoin_pressed() -> void:
	if not _can_act() or not Session.has_match():
		return
	rejoin_requested.emit(Session.last_match_id)


func _can_act() -> bool:
	if _busy:
		return false
	if not _connected:
		show_message("Not connected to a server yet.", true)
		return false
	return true


func _refresh() -> void:
	var ready := _connected and not _busy
	_create.disabled = not ready
	_join.disabled = not ready
	_rejoin.disabled = not ready
	# Only offer a rejoin when there is actually a match to go back to.
	_rejoin.visible = Session.has_match()
	if _rejoin.visible:
		_rejoin.text = "Rejoin match %s" % Session.last_match_id
	_reset_identity.disabled = _busy
