class_name BoardTheme
extends RefCounted
## Placeholder visual theme for the board.
##
## Every colour here is temporary scaffolding so the game can be looked at
## and played before any art exists. Real sprites and a tile atlas replace
## all of it in Phase 4 (docs/ROADMAP.md) - at which point only
## terrain_tileset.gd and unit.gd need to change, not the board logic.
##
## This is presentation, so it deliberately does NOT live in shared/data:
## the server has no business knowing what colour a forest is.

const TILE_SIZE := 32

const NEUTRAL := Color("#8d8d94")
const SLOT_COLORS := {
	1: Color("#d9443f"),  # Redline
	2: Color("#3f7fd9"),
	3: Color("#3fb96b"),
	4: Color("#d9a93f"),
}

const TERRAIN_COLORS := {
	"plains": Color("#8fb865"),
	"road": Color("#b9b2a3"),
	"forest": Color("#4f7a44"),
	"mountain": Color("#8c7c68"),
	"river": Color("#6fa8cf"),
	"shallow_water": Color("#4f8ec4"),
	"deep_water": Color("#2f5f96"),
	"reef": Color("#3f8f8a"),
	"city": Color("#c3c3c8"),
	"factory": Color("#9a9aa4"),
	"airport": Color("#a8b6c4"),
	"port": Color("#8fb6b6"),
	"hq": Color("#d8c98a"),
}

## Short labels standing in for unit sprites.
const UNIT_LABELS := {
	"infantry": "INF",
	"anti_tank_infantry": "ATI",
	"recon": "RCN",
	"artillery": "ART",
	"light_tank": "LTK",
	"heavy_tank": "HTK",
	"anti_air": "AA",
	"helicopter": "HEL",
	"fighter_jet": "JET",
	"transport_ship": "TRN",
}

const GRID_LINE := Color(0, 0, 0, 0.14)
const FOG_COLOR := Color(0.04, 0.05, 0.09, 0.55)
# Kept light on purpose: a range overlay covers most of the reachable map,
# and the player still needs to read the terrain underneath it to plan.
const MOVE_RANGE := Color(0.35, 0.62, 1.0, 0.30)
const ATTACK_RANGE := Color(0.95, 0.28, 0.24, 0.38)
const SPENT_TINT := Color(0.35, 0.35, 0.42, 0.55)


static func slot_color(slot: int) -> Color:
	return SLOT_COLORS.get(slot, NEUTRAL)


static func terrain_color(terrain_id: String) -> Color:
	return TERRAIN_COLORS.get(terrain_id, Color.MAGENTA)


static func unit_label(unit_type: String) -> String:
	return UNIT_LABELS.get(unit_type, unit_type.substr(0, 3).to_upper())
