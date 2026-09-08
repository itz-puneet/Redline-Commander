extends Node
## Autoload: PlayerIdentity
##
## A stable id for this install, persisted to user:// and reused across
## launches. This exists because a socket id is not an identity: if a seat in
## a match were keyed to the connection, closing the app would lose the match.
## The server keys seats to this id, so reconnecting resumes the same seat.
##
## TODO(auth): `token` is a local placeholder. Before the server is exposed
## publicly, back this with a real account or a signed device credential -
## as it stands anyone who learns an id can claim that seat.

const IDENTITY_PATH := "user://identity.json"

var player_id: String = ""
var token: String = ""
var display_name: String = "Commander"


func _ready() -> void:
	if not _load():
		_create()
		_save()


func _load() -> bool:
	if not FileAccess.file_exists(IDENTITY_PATH):
		return false
	var parsed: Variant = JSON.parse_string(FileAccess.get_file_as_string(IDENTITY_PATH))
	if typeof(parsed) != TYPE_DICTIONARY:
		return false

	var data: Dictionary = parsed
	player_id = String(data.get("player_id", ""))
	token = String(data.get("token", ""))
	display_name = String(data.get("display_name", "Commander"))
	return not player_id.is_empty()


func _create() -> void:
	var crypto := Crypto.new()
	player_id = crypto.generate_random_bytes(16).hex_encode()
	token = crypto.generate_random_bytes(32).hex_encode()


func _save() -> void:
	var file := FileAccess.open(IDENTITY_PATH, FileAccess.WRITE)
	if file == null:
		push_error("PlayerIdentity: could not write %s" % IDENTITY_PATH)
		return
	file.store_string(JSON.stringify({
		"player_id": player_id,
		"token": token,
		"display_name": display_name,
	}))
