class_name MatchState
extends RefCounted
## Local mirror of the server's view of the match.
##
## Read-only from the game's point of view: it is replaced wholesale whenever
## the server sends a view, and never mutated optimistically. If the client
## edited this speculatively it would drift from the server on every rejected
## action and every fog reveal, and the two would have to be reconciled - so
## it simply does not.
##
## Anything the local player is allowed to know is here; anything they are
## not was never sent (see server/src/game/view.ts).

var match_id: String = ""
var phase: String = "lobby"
var version: int = 0

var you_slot: int = 0
var current_slot: int = 0
var round_number: int = 0
var winner_slot: int = -1

var map_id: String = ""
var map_width: int = 0
var map_height: int = 0
var terrain: PackedStringArray = PackedStringArray()
var tile_owners: PackedInt32Array = PackedInt32Array()
var visible_tiles: Dictionary = {}   ## tile index -> true, used as a set

var players: Array[Dictionary] = []
var units: Dictionary = {}           ## unit_id -> unit Dictionary


static func from_view(view: Dictionary) -> MatchState:
	var state := MatchState.new()
	state.adopt(view)
	return state


## Replace everything with the server's version. This is the only way the
## state ever changes.
func adopt(view: Dictionary) -> void:
	match_id = String(view.get("matchId", ""))
	phase = String(view.get("phase", "lobby"))
	version = int(view.get("version", 0))
	you_slot = int(view.get("youSlot", 0))
	current_slot = int(view.get("currentSlot", 0))
	round_number = int(view.get("roundNumber", 0))
	winner_slot = -1 if view.get("winnerSlot") == null else int(view.get("winnerSlot"))

	var map_data: Dictionary = view.get("map", {})
	map_id = String(map_data.get("id", ""))
	map_width = int(map_data.get("width", 0))
	map_height = int(map_data.get("height", 0))

	terrain = PackedStringArray()
	for value in map_data.get("terrain", []):
		terrain.append(String(value))

	tile_owners = PackedInt32Array()
	for value in map_data.get("tileOwners", []):
		tile_owners.append(int(value))

	visible_tiles = {}
	for index in view.get("visibleTiles", []):
		visible_tiles[int(index)] = true

	players = []
	for entry in view.get("players", []):
		players.append(entry as Dictionary)

	units = {}
	for entry in view.get("units", []):
		var unit: Dictionary = entry
		units[String(unit.get("id", ""))] = unit


func tile_index(x: int, y: int) -> int:
	return y * map_width + x


func in_bounds(x: int, y: int) -> bool:
	return x >= 0 and y >= 0 and x < map_width and y < map_height


func terrain_at(x: int, y: int) -> String:
	return "" if not in_bounds(x, y) else terrain[tile_index(x, y)]


func tile_owner_at(x: int, y: int) -> int:
	return 0 if not in_bounds(x, y) else tile_owners[tile_index(x, y)]


func is_visible(x: int, y: int) -> bool:
	return in_bounds(x, y) and visible_tiles.has(tile_index(x, y))


func unit_at(x: int, y: int) -> Dictionary:
	for unit in units.values():
		if int(unit.get("x", -1)) == x and int(unit.get("y", -1)) == y:
			return unit
	return {}


func units_of(slot: int) -> Array[Dictionary]:
	var result: Array[Dictionary] = []
	for unit in units.values():
		if int(unit.get("ownerSlot", 0)) == slot:
			result.append(unit)
	return result


func is_my_turn() -> bool:
	return phase == "active" and current_slot == you_slot


func my_funds() -> int:
	for player in players:
		if int(player.get("slot", 0)) == you_slot:
			var funds: Variant = player.get("funds")
			return 0 if funds == null else int(funds)
	return 0


## True once the match is over. `winner_slot` is -1 for a draw.
func is_finished() -> bool:
	return phase == "finished"
