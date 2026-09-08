extends Node
## Autoload: Session
##
## Remembers which match this device was last in, so the app can offer to
## rejoin after being closed. Separate from PlayerIdentity on purpose:
## identity is who you are and never changes, this is what you were doing
## and changes every match.
##
## The server is the authority on whether the match still exists - this is
## only a hint for the lobby, and a stale id simply gets `no_such_match`.

const SESSION_PATH := "user://session.json"

var last_match_id: String = ""


func _ready() -> void:
	_load()


func remember_match(match_id: String) -> void:
	if match_id == last_match_id:
		return
	last_match_id = match_id
	_save()


func forget_match() -> void:
	remember_match("")


func has_match() -> bool:
	return not last_match_id.is_empty()


func _load() -> void:
	if not FileAccess.file_exists(SESSION_PATH):
		return
	var parsed: Variant = JSON.parse_string(FileAccess.get_file_as_string(SESSION_PATH))
	if typeof(parsed) != TYPE_DICTIONARY:
		return
	last_match_id = String((parsed as Dictionary).get("last_match_id", ""))


func _save() -> void:
	var file := FileAccess.open(SESSION_PATH, FileAccess.WRITE)
	if file == null:
		push_warning("Session: could not write %s" % SESSION_PATH)
		return
	file.store_string(JSON.stringify({"last_match_id": last_match_id}))
