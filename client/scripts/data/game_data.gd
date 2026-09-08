extends Node
## Autoload: GameData
##
## Loads the shared data tables that the server also reads. res://data is a
## generated copy of the repo's /shared/data - do not edit it by hand, run
## tools/sync-shared-data.sh. The point is that a unit's move cost or a
## damage number is written down in exactly one place in the whole project.

const DATA_DIR := "res://data"

var units: Dictionary = {}
var terrain: Dictionary = {}
var damage_matrix: Dictionary = {}
var factions: Dictionary = {}

var _maps: Dictionary = {}


func _ready() -> void:
	units = _load_json("units.json").get("units", {})
	terrain = _load_json("terrain.json").get("terrain", {})
	damage_matrix = _load_json("damage_matrix.json").get("matrix", {})
	factions = _load_json("factions.json").get("factions", {})

	if units.is_empty() or terrain.is_empty():
		push_error("GameData: data tables failed to load - run tools/sync-shared-data.sh")


func _load_json(file_name: String) -> Dictionary:
	var path := "%s/%s" % [DATA_DIR, file_name]
	if not FileAccess.file_exists(path):
		push_error("GameData: missing %s" % path)
		return {}

	var text := FileAccess.get_file_as_string(path)
	var parsed: Variant = JSON.parse_string(text)
	if typeof(parsed) != TYPE_DICTIONARY:
		push_error("GameData: %s is not a JSON object" % path)
		return {}
	return parsed as Dictionary


func unit_stats(unit_type: String) -> Dictionary:
	return units.get(unit_type, {})


func terrain_stats(terrain_id: String) -> Dictionary:
	return terrain.get(terrain_id, {})


## Movement points needed to enter `terrain_id`, or -1 if impassable.
func move_cost(terrain_id: String, move_type: String) -> int:
	var costs: Dictionary = terrain_stats(terrain_id).get("move_cost", {})
	var value: Variant = costs.get(move_type)
	return -1 if value == null else int(value)


## Base damage percent, attacker type -> defender type. 0 means "cannot engage".
func base_damage(attacker_type: String, defender_type: String) -> int:
	return int(damage_matrix.get(attacker_type, {}).get(defender_type, 0))


func load_map(map_id: String) -> Dictionary:
	if not _maps.has(map_id):
		_maps[map_id] = _load_json("maps/%s.json" % map_id)
	return _maps[map_id]


## Health as the player sees it: 10 pips, and never 0 for a living unit.
static func display_hp(hp: int) -> int:
	return 0 if hp <= 0 else maxi(1, ceili(hp / 10.0))
