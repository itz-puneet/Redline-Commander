extends Node
## Headless checks for the board renderer.
##
## Runs without a display: it asserts on the scene graph the board builds
## rather than on pixels. Pairs with board_preview.tscn, which renders the
## same fixture to a PNG when a display is available.
##
##   cd client && godot --headless res://tests/board_check.tscn

const BOARD_SCENE := preload("res://scenes/board.tscn")

var _failures := 0
var _board: Board = null


func _ready() -> void:
	_board = BOARD_SCENE.instantiate()
	add_child(_board)

	var state := MatchState.from_view(Fixtures.match_view())
	_board.render(state)

	_check_terrain(state)
	_check_units(state)
	_check_fog(state)
	_check_overlays(state)
	_check_reconciliation(state)
	_check_hud_inset(state)
	_check_coordinates()
	_check_every_seat_has_tiles(state)
	_check_real_terrain_art()
	_check_neighbour_masks()
	_check_variant_preference()
	_check_water_map_renders(state)

	if _failures == 0:
		print("\nboard_check: all checks passed")
	else:
		printerr("\nboard_check: %d check(s) FAILED" % _failures)
	get_tree().quit(0 if _failures == 0 else 1)


func _check(label: String, condition: bool, detail: String = "") -> void:
	if condition:
		print("ok   %s" % label)
	else:
		_failures += 1
		printerr("FAIL %s%s" % [label, "" if detail.is_empty() else " (%s)" % detail])


func _check_terrain(state: MatchState) -> void:
	var layer := _board.terrain_layer
	_check("a tileset was generated", layer.tile_set != null)
	_check("every map tile has a cell",
		layer.get_used_cells().size() == state.map_width * state.map_height,
		"got %d of %d" % [layer.get_used_cells().size(), state.map_width * state.map_height])

	# Ownership is encoded in the tile itself, so an owned HQ and a neutral
	# city of the same terrain must resolve to different atlas coordinates.
	var owned_hq := TerrainTileSet.tile_key("hq", 1)
	var neutral_hq := TerrainTileSet.tile_key("hq", 0)
	_check("ownership produces distinct tiles", owned_hq != neutral_hq)

	var plain_a := TerrainTileSet.tile_key("plains", 0)
	var plain_b := TerrainTileSet.tile_key("plains", 2)
	_check("un-ownable terrain has one variant", plain_a == plain_b)


func _check_units(state: MatchState) -> void:
	_check("a node exists per unit in the state",
		_board.unit_layer.get_child_count() == state.units.size(),
		"got %d nodes for %d units" % [_board.unit_layer.get_child_count(), state.units.size()])

	var tank := _board.unit_node("a1")
	_check("units are addressable by id", tank != null)
	if tank == null:
		return
	_check("a unit sits on its tile in world space",
		tank.position == Vector2(6, 4) * BoardTheme.TILE_SIZE,
		"at %s" % tank.position)
	_check("a unit reads its own stats", tank.display_name() == "Light Tank")

	var infantry := _board.unit_node("a2")
	_check("a damaged unit reports pips, not raw hp", infantry != null and infantry.display_hp() == 7)
	_check("capture progress is bound", infantry != null and infantry.capture_progress == 10)

	var spent := _board.unit_node("a3")
	_check("a spent unit is marked", spent != null and spent.has_acted)


func _check_fog(state: MatchState) -> void:
	# The fixture's vision is computed the same way the server computes it,
	# so this also guards the client's reading of `visibleTiles`.
	_check("fog leaves some of the map hidden",
		state.visible_tiles.size() < state.map_width * state.map_height,
		"%d of %d visible" % [state.visible_tiles.size(), state.map_width * state.map_height])
	_check("the tile under our own unit is visible", state.is_visible(6, 4))
	_check("distant ground is not visible", not state.is_visible(13, 8))

	# The decisive one: an enemy outside our vision is absent from the state
	# entirely, so there is nothing for the fog layer to have to hide.
	_check("an unseen enemy is absent from the payload", not state.units.has("b2"))
	_check("a seen enemy is present", state.units.has("b1"))


func _check_overlays(state: MatchState) -> void:
	var tank: Dictionary = state.units["a1"]
	var reachable := MovementPreview.reachable_tiles(state, tank)

	_board.clear_overlays()
	_check("an empty overlay holds nothing", _board.overlay_layer.layer_count() == 0)

	_board.show_movement_range(reachable.keys())
	_check("a movement range is actually held",
		_board.overlay_layer.layer_count() == 1,
		"%d layers" % _board.overlay_layer.layer_count())
	var held := _board.overlay_layer.highlighted_tiles()
	_check("with every tile of the range in it", held.size() == reachable.size(),
		"%d held for %d reachable" % [held.size(), reachable.size()])
	_check("and the tiles are the ones asked for", held.has(reachable.keys()[0]))

	_board.show_selection(Vector2i(6, 4))
	_check("a selection adds a layer rather than replacing one",
		_board.overlay_layer.layer_count() == 2)
	_check("and marks the selected tile",
		_board.overlay_layer.highlighted_tiles().has(Vector2i(6, 4)))

	_board.clear_overlays()
	_check("clearing removes them all", _board.overlay_layer.layer_count() == 0)
	_check("and leaves no tiles behind", _board.overlay_layer.highlighted_tiles().is_empty())

	# The range the overlay draws is the range the server would accept, so
	# spot-check the terrain rules it has to respect.
	var illegal := 0
	for tile in reachable.keys():
		var terrain := state.terrain_at(tile.x, tile.y)
		if terrain == "river" or terrain == "mountain":
			illegal += 1
	_check("the drawn range excludes terrain treads cannot enter", illegal == 0,
		"%d illegal tiles" % illegal)
	_check("the central bridge is reachable", reachable.has(Vector2i(7, 5)),
		"armour must have a middle crossing")


func _check_reconciliation(state: MatchState) -> void:
	var tank_before := _board.unit_node("a1")

	# Re-render a state where the tank moved and the enemy died: the tank's
	# node must survive (so an animation on it would not be thrown away) and
	# the destroyed unit's node must go.
	var view := Fixtures.match_view()
	var units: Array = view["units"]
	var next: Array = []
	for unit in units:
		if String(unit["id"]) == "b1":
			continue
		if String(unit["id"]) == "a1":
			unit["x"] = 7
		next.append(unit)
	view["units"] = next
	_board.render(MatchState.from_view(view))

	_check("a moved unit keeps its node", _board.unit_node("a1") == tank_before)
	_check("a moved unit is repositioned",
		_board.unit_node("a1").position == Vector2(7, 4) * BoardTheme.TILE_SIZE)
	_check("a destroyed unit's node is released", _board.unit_node("b1") == null)


## The camera must keep the board clear of the HUD, or the bottom row of
## the map is unreachable by touch.
func _check_hud_inset(state: MatchState) -> void:
	var camera := _board.camera
	camera.bottom_inset = 0.0
	camera.frame_map(state.map_width, state.map_height)
	var centred := camera.position.y
	var full_zoom := camera.zoom.x

	camera.bottom_inset = 72.0
	camera.frame_map(state.map_width, state.map_height)
	_check("a HUD inset shifts the view up", camera.position.y > centred,
		"%f -> %f" % [centred, camera.position.y])
	_check("a HUD inset does not zoom in past the full-viewport fit",
		camera.zoom.x <= full_zoom + 0.0001,
		"%f -> %f" % [full_zoom, camera.zoom.x])

	camera.bottom_inset = 0.0


func _check_coordinates() -> void:
	var size := BoardTheme.TILE_SIZE
	_check("world position maps back to its tile",
		_board.tile_at_world(Vector2(size * 3 + 5, size * 2 + 5)) == Vector2i(3, 2))
	_check("tile maps to world position",
		_board.world_at_tile(Vector2i(3, 2)) == Vector2(size * 3, size * 2))
	_check("negative space maps outside the board",
		_board.tile_at_world(Vector2(-4, -4)) == Vector2i(-1, -1))


## Every seat the board can colour needs a tile variant for every capturable
## terrain, or the atlas has no entry for that key.
##
## This existed as a hole for as long as the board did: OWNER_SLOTS was
## [0, 1, 2] while BoardTheme.SLOT_COLORS defined four seats, and
## _render_terrain skipped a key it did not have - so on a three- or
## four-player map every city and factory owned by players 3 and 4 simply
## was not drawn, with nothing logged.
##
## The two checks below cover the two halves of that, and each was verified
## against its own mutation - neither catches the other's:
##   - reverting owner_slots() to [0, 1, 2] fails the coverage check, but
##     not the draw check, because the fallback added to _render_terrain
##     now draws the tile unowned instead of skipping it
##   - removing that fallback fails the draw check
func _check_every_seat_has_tiles(state: MatchState) -> void:
	var built: Dictionary = TerrainTileSet.build()
	var coords: Dictionary = built.get("coords", {})
	var missing: Array = []
	for terrain_id in GameData.terrain.keys():
		if not bool(GameData.terrain_stats(String(terrain_id)).get("capturable", false)):
			continue
		for slot in BoardTheme.SLOT_COLORS.keys():
			var key := TerrainTileSet.tile_key(String(terrain_id), int(slot))
			if not coords.has(key):
				missing.append(key)
	_check("every colourable seat has a tile for every capturable terrain",
		missing.is_empty(), "no atlas entry for %s" % str(missing))

	# And the board actually draws them. Asserting on the atlas alone would
	# stay green if _render_terrain dropped the cell anyway.
	var highest: int = 0
	for slot in BoardTheme.SLOT_COLORS.keys():
		highest = maxi(highest, int(slot))
	var owned := MatchState.from_view(Fixtures.match_view())
	var capturable := Vector2i(-1, -1)
	for y in owned.map_height:
		for x in owned.map_width:
			if bool(GameData.terrain_stats(owned.terrain_at(x, y)).get("capturable", false)):
				capturable = Vector2i(x, y)
				break
		if capturable.x >= 0:
			break
	if capturable.x < 0:
		_check("the fixture map has a capturable tile to test with", false)
		return
	owned.tile_owners[owned.tile_index(capturable.x, capturable.y)] = highest
	_board.render(owned)
	var layer: TileMapLayer = _board.terrain_layer
	_check("a building owned by the highest seat is drawn, not skipped",
		layer.get_cell_source_id(capturable) >= 0,
		"seat %d at %s left an empty cell" % [highest, capturable])

	# Put the board back the way the other checks left it.
	_board.render(state)


## The committed terrain sheet must actually be the thing drawn, not a
## silent fallback to flat colour. Verified two ways: that the real sheet
## is used at the board's own tile size, and that asking for a tile size
## the sheet does not match correctly reports "not using it" - the same
## mismatch a stale or half-regenerated sheet would trigger, so this proves
## the fallback path is reachable rather than assuming it from reading the
## code.
func _check_real_terrain_art() -> void:
	_check("the committed terrain sheet is used, not the flat-colour fallback",
		TerrainTileSet.using_real_art(BoardTheme.TILE_SIZE))
	_check("a tile-size mismatch is detected as not using the real sheet",
		not TerrainTileSet.using_real_art(BoardTheme.TILE_SIZE + 1))


## The connectivity mask, which is where the shoreline and the road network
## actually get decided. Tested directly rather than through the render,
## because no variant art exists yet - every lookup currently falls back to
## the plain tile, so a render-level assertion would pass with the mask
## computed entirely wrong.
##
## Verified against three mutations, one per group below:
##   - _connects() returning false for "road": every road mask goes to 0
##   - shallow_water's off-map rule flipped to count as land: the open-sea
##     check fails while the land checks stay green
##   - MASK_LETTERS reordered to N, S, E, W: the suffix checks fail
func _check_neighbour_masks() -> void:
	_check("road and shore autotile, open water does not",
		TerrainTileSet.autotiles("road") and TerrainTileSet.autotiles("shallow_water")
		and not TerrainTileSet.autotiles("deep_water")
		and not TerrainTileSet.autotiles("plains"))

	# Road: N, E, S, W.
	var straight := TerrainTileSet.neighbour_mask("road", ["road", "plains", "road", "plains"])
	_check("a road between two roads reads as a straight",
		TerrainTileSet.mask_suffix(straight) == "NS",
		"got %s" % TerrainTileSet.mask_suffix(straight))
	var alone := TerrainTileSet.neighbour_mask("road", ["plains", "forest", "plains", "river"])
	_check("a road with nothing to join reads as isolated",
		alone == 0 and TerrainTileSet.mask_suffix(alone) == "0")
	_check("a building continues the road",
		TerrainTileSet.neighbour_mask("road", ["city", "plains", "plains", "plains"]) == 1)
	_check("the map edge continues the road rather than ending it",
		TerrainTileSet.neighbour_mask("road", ["", "plains", "plains", "plains"]) == 1)
	var junction := TerrainTileSet.neighbour_mask("road", ["road", "road", "road", "hq"])
	_check("four ways in reads as a crossroads",
		TerrainTileSet.mask_suffix(junction) == "NESW")

	# Shore: the bit means "this side is land", so the sand faces the coast.
	var west_coast := TerrainTileSet.neighbour_mask("shallow_water",
		["deep_water", "deep_water", "deep_water", "plains"])
	_check("water with land to the west faces west",
		TerrainTileSet.mask_suffix(west_coast) == "W",
		"got %s" % TerrainTileSet.mask_suffix(west_coast))
	var north_coast := TerrainTileSet.neighbour_mask("shallow_water",
		["forest", "shallow_water", "deep_water", "reef"])
	_check("and water with land to the north faces north, reef counting as sea",
		TerrainTileSet.mask_suffix(north_coast) == "N",
		"got %s" % TerrainTileSet.mask_suffix(north_coast))
	var bay := TerrainTileSet.neighbour_mask("shallow_water",
		["mountain", "city", "deep_water", "deep_water"])
	_check("a corner faces both its shores", TerrainTileSet.mask_suffix(bay) == "NE")
	_check("open sea beyond the map edge is not a shore",
		TerrainTileSet.neighbour_mask("shallow_water", ["", "", "deep_water", ""]) == 0)


## The lookup order. The specific key has to be tried first or the sheet
## could carry every shoreline in the world and none would ever be drawn,
## and the plain key has to be last or a tile with no variant is a hole.
func _check_variant_preference() -> void:
	var keys := TerrainTileSet.variant_keys("road", 0, 5)
	_check("the neighbour-aware key is preferred", keys.size() == 2 and keys[0] == "road:0@NS",
		"got %s" % str(keys))
	_check("and the plain key is the last resort", keys.size() == 2 and keys[1] == "road:0")
	_check("terrain that does not autotile asks for one key only",
		TerrainTileSet.variant_keys("plains", 0, 15) == ["plains:0"])


## The water map, rendered.
##
## The load-bearing check here is the resolution one: a variant key the
## sheet does not carry must come back as the plain key. Everything else in
## this mechanism is dead if that is wrong, and - this is why it is asserted
## directly rather than through the render - the board would still LOOK
## right if it were, because _render_terrain has its own fallback for a
## missing owner slot that would quietly catch an unresolved variant too,
## while pushing an error per tile per redraw.
##
## Verified against two mutations:
##   - dropping the `_atlas_coords.has()` test from the candidate loop in
##     Board._terrain_tile_key, so the specific key wins whether or not the
##     sheet carries it: the resolution check fails with shallow_water:0@NW
##   - that, plus dropping the owner fallback in _render_terrain, which is
##     what was masking it: 58 tiles of the water map and 38 of the land map
##     go empty, and the drawn-cells checks fail too
##
## Note that mutating the final `return` in _terrain_tile_key changes
## nothing: the loop above it already returns the plain key, so that line is
## reached only when the sheet has neither candidate. It is a guard, not a
## behaviour, and no check here claims otherwise.
func _check_water_map_renders(state: MatchState) -> void:
	var view := Fixtures.match_view(true, "straits")
	view["units"] = []
	var water := MatchState.from_view(view)
	_board.render(water)

	var layer: TileMapLayer = _board.terrain_layer
	_check("every tile of the water map is drawn",
		layer.get_used_cells().size() == water.map_width * water.map_height,
		"%d of %d" % [layer.get_used_cells().size(), water.map_width * water.map_height])

	# A variant the sheet genuinely has no art for still has to fall back to
	# the plain tile rather than resolve to a key nothing can draw. Roads
	# supply the case: art/png/terrain/ has no road_N.png (a dead-end piece),
	# and straits has one, so this exercises the fallback against real
	# rather than fabricated data - if a future art drop fills in the last
	# road ends, this check starts failing its premise loudly (no candidate
	# tile found) rather than silently passing on the wrong thing.
	var built: Dictionary = TerrainTileSet.build()
	var coords: Dictionary = built.get("coords", {})
	var dead_end := Vector2i(-1, -1)
	for y in water.map_height:
		for x in water.map_width:
			if water.terrain_at(x, y) != "road":
				continue
			var mask := TerrainTileSet.neighbour_mask("road", [
				water.terrain_at(x, y - 1), water.terrain_at(x + 1, y),
				water.terrain_at(x, y + 1), water.terrain_at(x - 1, y)])
			if TerrainTileSet.mask_suffix(mask).length() == 1:
				dead_end = Vector2i(x, y)
				break
		if dead_end.x >= 0:
			break
	_check("straits has a road end to test the fallback with", dead_end.x >= 0)
	if dead_end.x >= 0:
		var resolved: String = _board._terrain_tile_key(dead_end.x, dead_end.y, "road")
		_check("a variant with no art falls back to the plain tile",
			resolved == "road:0", "resolved to %s" % resolved)

	# The shoreline, the opposite case: every orientation straits uses IS in
	# the sheet now (art/png/terrain/shallow_water_*.png), so this checks the
	# render actually reaches that art rather than quietly falling back to
	# the plain tile while still passing "every tile is drawn" above.
	var orientations: Dictionary = {}
	var fallen_back: Array = []
	for y in water.map_height:
		for x in water.map_width:
			if water.terrain_at(x, y) != "shallow_water":
				continue
			var key: String = _board._terrain_tile_key(x, y, "shallow_water")
			if key == "shallow_water:0" or not coords.has(key):
				fallen_back.append("(%d,%d)->%s" % [x, y, key])
			orientations[key] = true
	_check("every shoreline tile resolves to real art, not the fallback",
		fallen_back.is_empty(), "%d did not: %s" % [fallen_back.size(), str(fallen_back)])
	_check("the shoreline uses more than one orientation of real art",
		orientations.size() >= 4, "%d distinct: %s" % [orientations.size(), str(orientations.keys())])

	_board.render(state)
