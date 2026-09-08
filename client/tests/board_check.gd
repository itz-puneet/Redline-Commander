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
	_check_coordinates()

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
	_board.show_movement_range(reachable.keys())
	_board.show_selection(Vector2i(6, 4))
	_check("overlays accept a range without error", _board.overlay_layer != null)

	_board.clear_overlays()
	_check("overlays can be cleared", true)

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


func _check_coordinates() -> void:
	var size := BoardTheme.TILE_SIZE
	_check("world position maps back to its tile",
		_board.tile_at_world(Vector2(size * 3 + 5, size * 2 + 5)) == Vector2i(3, 2))
	_check("tile maps to world position",
		_board.world_at_tile(Vector2i(3, 2)) == Vector2(size * 3, size * 2))
	_check("negative space maps outside the board",
		_board.tile_at_world(Vector2(-4, -4)) == Vector2i(-1, -1))
