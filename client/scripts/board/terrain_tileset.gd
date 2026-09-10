class_name TerrainTileSet
extends RefCounted
## Builds the terrain TileSet, from real art when it exists and from flat
## colours when it does not.
##
## The real sheet is generated from art/png/terrain/*.png by
## art/png/build_terrain_sheet.py into
## client/assets/terrain/{terrain.png,terrain.json}, which is committed -
## see art/png/README.md. A checkout with that sheet missing, or one whose
## tile size does not match the board's, falls back to the procedural
## flat-colour painter below, so the game always renders something.
## using_real_art() is the test seam that tells the two apart, the way
## UnitSprites.ready() does for units.
##
## Capturable terrain gets one tile variant per owner (neutral, slot 1,
## slot 2, ...) so ownership is part of the tile rather than an overlay.

const SHEET_PATH := "res://assets/terrain/terrain.png"
const MANIFEST_PATH := "res://assets/terrain/terrain.json"


## Neutral, then every seat the board can colour. Derived from
## BoardTheme.SLOT_COLORS rather than written out, because the two must agree:
## a slot with a colour but no tile variant produced no atlas entry, and
## Board._render_terrain skipped the cell silently - every building owned by
## players 3 and 4 was a hole in the map, with no error anywhere.
static func owner_slots() -> Array:
	var slots: Array = [0]
	var coloured: Array = BoardTheme.SLOT_COLORS.keys()
	coloured.sort()
	slots.append_array(coloured)
	return slots


## True when a real, board-sized sheet is present and will be used - false
## means build() is about to fall back to flat colour. Tests use this rather
## than re-deriving the same loading logic.
static func using_real_art(tile_size: int = BoardTheme.TILE_SIZE) -> bool:
	return _load_manifest(tile_size) != null


## Returns { tile_set, source_id, coords } where `coords` maps a tile key
## (see tile_key()) to atlas coordinates.
static func build(tile_size: int = BoardTheme.TILE_SIZE) -> Dictionary:
	var manifest: Variant = _load_manifest(tile_size)
	if manifest != null:
		var built := _build_from_sheet(manifest, tile_size)
		if not built.is_empty():
			return built
	return _build_procedural(tile_size)


## The parsed manifest, or null if there is nothing usable to build from -
## missing file, malformed JSON, or a tile size that does not match the
## board's. A size mismatch falls back rather than stretching or
## mis-tiling a texture region sized for a different TILE_SIZE.
static func _load_manifest(tile_size: int) -> Variant:
	if not FileAccess.file_exists(MANIFEST_PATH) or not ResourceLoader.exists(SHEET_PATH):
		return null
	var text := FileAccess.get_file_as_string(MANIFEST_PATH)
	var parsed: Variant = JSON.parse_string(text)
	if typeof(parsed) != TYPE_DICTIONARY:
		push_error("TerrainTileSet: %s is not a JSON object" % MANIFEST_PATH)
		return null
	var manifest: Dictionary = parsed
	if not manifest.has("coords"):
		push_error("TerrainTileSet: %s is missing coords" % MANIFEST_PATH)
		return null
	if int(manifest.get("tile", -1)) != tile_size:
		push_error("TerrainTileSet: %s tile size %s does not match TILE_SIZE %d - falling back to flat colour"
			% [MANIFEST_PATH, str(manifest.get("tile")), tile_size])
		return null
	return manifest


static func _build_from_sheet(manifest: Dictionary, tile_size: int) -> Dictionary:
	var texture: Texture2D = load(SHEET_PATH)
	if texture == null:
		push_error("TerrainTileSet: could not load %s - falling back to flat colour" % SHEET_PATH)
		return {}

	var source := TileSetAtlasSource.new()
	source.texture = texture
	source.texture_region_size = Vector2i(tile_size, tile_size)

	var coords: Dictionary = {}
	var raw_coords: Dictionary = manifest["coords"]
	for key in raw_coords:
		var cell := Vector2i(int(raw_coords[key]), 0)
		source.create_tile(cell)
		coords[key] = cell

	var tile_set := TileSet.new()
	tile_set.tile_size = Vector2i(tile_size, tile_size)
	var source_id := tile_set.add_source(source)

	return {"tile_set": tile_set, "source_id": source_id, "coords": coords}


## The fallback used when no real sheet is present: flat colour, generated
## rather than authored so the repo carries no placeholder art and a
## terrain type added to shared/data/terrain.json shows up on the board
## without touching a .tres.
static func _build_procedural(tile_size: int) -> Dictionary:
	var keys: Array[String] = []
	for terrain_id in GameData.terrain.keys():
		var id := String(terrain_id)
		if bool(GameData.terrain_stats(id).get("capturable", false)):
			for slot in owner_slots():
				keys.append(tile_key(id, slot))
		else:
			keys.append(tile_key(id, 0))

	if keys.is_empty():
		push_error("TerrainTileSet: no terrain in GameData - is client/data synced?")
		return {}

	var image := Image.create(tile_size * keys.size(), tile_size, false, Image.FORMAT_RGBA8)
	var coords: Dictionary = {}

	for index in keys.size():
		var parts := keys[index].split(":")
		_paint_tile(image, index * tile_size, tile_size, parts[0], int(parts[1]))
		coords[keys[index]] = Vector2i(index, 0)

	var source := TileSetAtlasSource.new()
	source.texture = ImageTexture.create_from_image(image)
	source.texture_region_size = Vector2i(tile_size, tile_size)
	for index in keys.size():
		source.create_tile(Vector2i(index, 0))

	var tile_set := TileSet.new()
	tile_set.tile_size = Vector2i(tile_size, tile_size)
	var source_id := tile_set.add_source(source)

	return {"tile_set": tile_set, "source_id": source_id, "coords": coords}


## Ownership only distinguishes tiles that can actually be owned, so plain
## terrain needs a single variant rather than one per slot.
static func tile_key(terrain_id: String, owner_slot: int) -> String:
	if not bool(GameData.terrain_stats(terrain_id).get("capturable", false)):
		return "%s:0" % terrain_id
	return "%s:%d" % [terrain_id, owner_slot]


static func _paint_tile(image: Image, x_offset: int, size: int, terrain_id: String, owner_slot: int) -> void:
	var base := BoardTheme.terrain_color(terrain_id)
	image.fill_rect(Rect2i(x_offset, 0, size, size), base)

	# A one-pixel darker edge, so the grid reads without a separate overlay.
	var edge := base.darkened(0.25)
	image.fill_rect(Rect2i(x_offset, 0, size, 1), edge)
	image.fill_rect(Rect2i(x_offset, size - 1, size, 1), edge)
	image.fill_rect(Rect2i(x_offset, 0, 1, size), edge)
	image.fill_rect(Rect2i(x_offset + size - 1, 0, 1, size), edge)

	var stats := GameData.terrain_stats(terrain_id)
	if not bool(stats.get("capturable", false)):
		return

	# Buildings get a solid block in the owner's colour; an HQ gets a bigger
	# one so it is obvious at a glance which tile ends the match.
	var inset := 6 if bool(stats.get("is_hq", false)) else 9
	var fill := BoardTheme.NEUTRAL if owner_slot == 0 else BoardTheme.slot_color(owner_slot)
	var box := size - inset * 2
	image.fill_rect(Rect2i(x_offset + inset, inset, box, box), fill.darkened(0.15))
	image.fill_rect(Rect2i(x_offset + inset + 1, inset + 1, box - 2, box - 2), fill)
