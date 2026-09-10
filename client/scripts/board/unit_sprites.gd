class_name UnitSprites
extends RefCounted
## The rendered unit sheet, and where each unit type sits on it.
##
## The sheet, its mask and this manifest are all generated - see
## art/blender/ and tools/render-sprites.sh. Nothing here is authored by
## hand, and nothing here is game data: the frame order comes from
## shared/data/units.json at render time, so a unit type added to the game
## gets a frame without anyone editing a table twice.
##
## A unit is rendered into a `cell` of pixels but occupies a `tile`, the
## smaller of the two, so a rotor or a gun barrel can overhang its tile
## without being clipped. The board centres the cell on the tile.
##
## If the sheet is missing - a fresh checkout that has not run the renderer,
## or an import that has not completed - `ready()` is false and the board
## falls back to the placeholder blocks in Unit._draw(). That keeps the game
## runnable, so `sprite_check` asserts coverage rather than trusting the
## board to look wrong loudly.

const MANIFEST_PATH := "res://assets/units/units.json"
const SHEET_DIR := "res://assets/units/"

static var _loaded := false
static var _manifest: Dictionary = {}
static var _sheet: Texture2D = null
static var _mask: Texture2D = null


static func _load() -> void:
	if _loaded:
		return
	# Set before the work, not after: a malformed manifest must not send
	# every subsequent call back through the same failing parse.
	_loaded = true

	if not FileAccess.file_exists(MANIFEST_PATH):
		return
	var text := FileAccess.get_file_as_string(MANIFEST_PATH)
	var parsed: Variant = JSON.parse_string(text)
	if typeof(parsed) != TYPE_DICTIONARY:
		push_error("UnitSprites: %s is not a JSON object" % MANIFEST_PATH)
		return
	var manifest: Dictionary = parsed
	if not manifest.has("frames") or not manifest.has("cell"):
		push_error("UnitSprites: %s is missing frames/cell" % MANIFEST_PATH)
		return

	var sheet_path: String = SHEET_DIR + String(manifest.get("sheet", "units.png"))
	var mask_path: String = SHEET_DIR + String(manifest.get("mask", "units_mask.png"))
	if not ResourceLoader.exists(sheet_path) or not ResourceLoader.exists(mask_path):
		return
	_sheet = load(sheet_path)
	_mask = load(mask_path)
	if _sheet == null or _mask == null:
		return
	_manifest = manifest


## True when a sheet is loaded and usable. Everything below returns an empty
## value when this is false, so a caller that forgets to check gets nothing
## drawn rather than a crash mid-match.
static func ready() -> bool:
	_load()
	return _sheet != null and not _manifest.is_empty()


static func sheet() -> Texture2D:
	_load()
	return _sheet


static func mask() -> Texture2D:
	_load()
	return _mask


static func cell_size() -> int:
	_load()
	return int(_manifest.get("cell", 0))


static func tile_size() -> int:
	_load()
	return int(_manifest.get("tile", 0))


static func has_frame(unit_type: String) -> bool:
	_load()
	return (_manifest.get("frames", {}) as Dictionary).has(unit_type)


## The rectangle on the sheet holding this unit type, or a zero rect when
## there is none.
static func region_for(unit_type: String) -> Rect2:
	_load()
	var frames: Dictionary = _manifest.get("frames", {})
	if not frames.has(unit_type):
		return Rect2()
	var cell := cell_size()
	return Rect2(int(frames[unit_type]) * cell, 0, cell, cell)


## Every unit type the sheet carries. Used by sprite_check to compare the
## sheet against the shared unit table.
static func frame_names() -> Array:
	_load()
	var names: Array = (_manifest.get("frames", {}) as Dictionary).keys()
	names.sort()
	return names


## Test seam: drop the cached sheet so a check can reload it.
static func _reset_for_test() -> void:
	_loaded = false
	_manifest = {}
	_sheet = null
	_mask = null
