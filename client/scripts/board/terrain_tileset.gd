class_name TerrainTileSet
extends RefCounted
## Builds the terrain TileSet at runtime from flat colours.
##
## Generated rather than authored so the repo carries no placeholder art and
## so a terrain type added to shared/data/terrain.json shows up on the board
## without touching a .tres. Swapping in real art later means pointing the
## atlas source at a real texture and keeping the same coordinate mapping.
##
## Capturable terrain gets one tile variant per owner (neutral, slot 1,
## slot 2, ...) so ownership is part of the tile rather than an overlay.

const OWNER_SLOTS := [0, 1, 2]


## Returns { tile_set, source_id, coords } where `coords` maps a tile key
## (see tile_key()) to atlas coordinates.
static func build(tile_size: int = BoardTheme.TILE_SIZE) -> Dictionary:
	var keys: Array[String] = []
	for terrain_id in GameData.terrain.keys():
		var id := String(terrain_id)
		if bool(GameData.terrain_stats(id).get("capturable", false)):
			for slot in OWNER_SLOTS:
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
