class_name Fixtures
extends RefCounted
## Synthetic match data for client tests and previews.
##
## Builds payloads in exactly the shape server/src/game/view.ts produces, so
## the client is exercised against the real contract rather than a
## convenient one. If the server's view shape changes, this is the one place
## the client tests need updating - and the mismatch will show up here loudly
## instead of silently at runtime.

## A mid-game position on the shipped map: units in contact, one capture in
## progress, one damaged unit, one that has already acted.
const SCENARIO_UNITS := [
	{"id": "a1", "unitType": "light_tank", "slot": 1, "x": 6, "y": 4, "hp": 100},
	{"id": "a2", "unitType": "infantry", "slot": 1, "x": 5, "y": 3, "hp": 70, "capture": 10},
	{"id": "a3", "unitType": "artillery", "slot": 1, "x": 4, "y": 5, "hp": 100, "acted": true},
	{"id": "a4", "unitType": "recon", "slot": 1, "x": 3, "y": 2, "hp": 100},
	{"id": "b1", "unitType": "anti_tank_infantry", "slot": 2, "x": 7, "y": 4, "hp": 90},
	{"id": "b2", "unitType": "light_tank", "slot": 2, "x": 10, "y": 6, "hp": 40},
]


## `reveal_all` skips the fog computation, for tests that care about logic
## rather than visibility.
static func match_view(reveal_all: bool = false) -> Dictionary:
	var map_data := GameData.load_map("crossing")
	var width := int(map_data.get("width", 0))
	var height := int(map_data.get("height", 0))

	var terrain := _terrain_array(map_data)
	var owners := _owner_array(map_data)
	var units := _units(reveal_all, terrain, width)
	var visible := _visible_tiles(units, terrain, owners, width, height) if not reveal_all \
		else range(width * height)

	return {
		"matchId": "fixture",
		"phase": "active",
		"version": 12,
		"youSlot": 1,
		"currentSlot": 1,
		"roundNumber": 4,
		"winnerSlot": null,
		"map": {
			"id": "crossing",
			"displayName": String(map_data.get("display_name", "")),
			"width": width, "height": height,
			"terrain": terrain, "tileOwners": owners,
		},
		"players": [
			{"slot": 1, "faction": "crimson_alliance", "defeated": false, "connected": true,
				"funds": 5000, "directiveCharge": 40},
			{"slot": 2, "faction": "azure_federation", "defeated": false, "connected": true,
				"funds": null, "directiveCharge": null},
		],
		"units": units,
		"visibleTiles": visible,
	}


static func _terrain_array(map_data: Dictionary) -> Array:
	var legend: Dictionary = map_data.get("_legend", {})
	var terrain: Array = []
	for row in map_data.get("tiles", []):
		var text := String(row)
		for i in text.length():
			terrain.append(String(legend.get(text[i], "plains")))
	return terrain


static func _owner_array(map_data: Dictionary) -> Array:
	var owners: Array = []
	for row in map_data.get("tile_owners", []):
		var text := String(row)
		for i in text.length():
			owners.append(int(text[i]))
	return owners


## Own units in full; enemy units only where visible and stripped of the
## fields the server does not send - the same redaction as view.ts.
static func _units(reveal_all: bool, terrain: Array, width: int) -> Array:
	var visible_to_us := _own_vision(terrain, width) if not reveal_all else {}
	var units: Array = []

	for entry in SCENARIO_UNITS:
		var slot := int(entry["slot"])
		if slot == 1:
			var stats := GameData.unit_stats(String(entry["unitType"]))
			units.append({
				"id": entry["id"], "unitType": entry["unitType"], "ownerSlot": slot,
				"x": entry["x"], "y": entry["y"], "hp": entry["hp"],
				"fuel": int(stats.get("max_fuel", 50)),
				"ammo": stats.get("max_ammo"),
				"hasMoved": bool(entry.get("acted", false)),
				"hasActed": bool(entry.get("acted", false)),
				"captureProgress": int(entry.get("capture", 0)),
				"cargo": [],
			})
			continue

		if reveal_all or visible_to_us.has(int(entry["y"]) * width + int(entry["x"])):
			units.append({
				"id": entry["id"], "unitType": entry["unitType"], "ownerSlot": slot,
				"x": entry["x"], "y": entry["y"], "hp": entry["hp"],
				"captureProgress": int(entry.get("capture", 0)),
			})

	return units


static func _own_vision(terrain: Array, width: int) -> Dictionary:
	var seen: Dictionary = {}
	var height := terrain.size() / width if width > 0 else 0
	for entry in SCENARIO_UNITS:
		if int(entry["slot"]) != 1:
			continue
		var radius := int(GameData.unit_stats(String(entry["unitType"])).get("vision", 1))
		for dy in range(-radius, radius + 1):
			for dx in range(-radius, radius + 1):
				var x := int(entry["x"]) + dx
				var y := int(entry["y"]) + dy
				if x >= 0 and y >= 0 and x < width and y < height:
					seen[y * width + x] = true
	return seen


static func _visible_tiles(units: Array, terrain: Array, owners: Array,
		width: int, height: int) -> Array:
	var seen := _own_vision(terrain, width)
	# Owned buildings always see themselves.
	for i in owners.size():
		if int(owners[i]) == 1:
			seen[i] = true
	var out: Array = seen.keys()
	out.sort()
	return out
