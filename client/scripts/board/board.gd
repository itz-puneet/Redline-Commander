class_name Board
extends Node2D
## Renders a match.
##
## One entry point: `render(state)`. Everything drawn is derived from the
## MatchState the server sent - the board holds no game state of its own and
## makes no rules decisions. That is what lets it be driven identically by a
## live match, a replay, or the synthetic fixture the tests use.
##
## Node order sets the draw order: terrain, then fog, then range overlays,
## then units, then transient effects. Fog sits UNDER the overlays
## deliberately - a player can move into ground they have not scouted, so the
## movement range has to stay readable through the fog rather than being
## dimmed by it.

## A tap on a tile. Emitted only for taps - a drag that pans the camera is
## not a tap, and neither is a pinch.
signal tile_tapped(tile: Vector2i)

@onready var terrain_layer: TileMapLayer = $TerrainLayer
@onready var fog_layer: FogOverlay = $FogLayer
@onready var overlay_layer: TileOverlay = $OverlayLayer
@onready var unit_layer: Node2D = $UnitLayer
## Damage numbers and capture flashes, drawn above the units.
@onready var effects_layer: Node2D = $EffectsLayer
@onready var camera: BoardCamera = $BoardCamera

var state: MatchState = null

var _unit_nodes: Dictionary = {}   ## unit_id -> Unit
var _atlas_coords: Dictionary = {}
## Terrain keys already reported as missing, so the error is logged once.
var _missing_tiles: Dictionary = {}
var _source_id: int = -1
var _framed_map: String = ""


func _ready() -> void:
	var built := TerrainTileSet.build()
	if built.is_empty():
		return
	terrain_layer.tile_set = built["tile_set"]
	_source_id = int(built["source_id"])
	_atlas_coords = built["coords"]


## Draw a match state. Safe to call on every server update.
func render(new_state: MatchState) -> void:
	if new_state == null:
		return
	state = new_state
	_render_terrain()
	_render_units()
	fog_layer.render(state)

	# Only reframe when the map itself changes, so the camera does not jump
	# back every time the opponent moves.
	if _framed_map != state.map_id:
		_framed_map = state.map_id
		camera.frame_map(state.map_width, state.map_height)


func _render_terrain() -> void:
	terrain_layer.clear()
	if _source_id < 0:
		return

	for y in state.map_height:
		for x in state.map_width:
			var terrain_id := state.terrain_at(x, y)
			var key := _terrain_tile_key(x, y, terrain_id)
			if not _atlas_coords.has(key):
				# Fall back to the unowned variant rather than drawing
				# nothing: an owner the tileset has no colour for is a bug,
				# but a hole in the map is a worse way to report it than a
				# tile that renders as neutral and an error in the log.
				_report_missing_tile(key)
				key = TerrainTileSet.tile_key(terrain_id, 0)
			if _atlas_coords.has(key):
				terrain_layer.set_cell(Vector2i(x, y), _source_id, _atlas_coords[key])


## The tile to draw at (x, y): the neighbour-aware variant when the sheet
## carries one, the plain tile when it does not.
##
## A missing variant is not reported as an error, unlike a missing owner
## slot above. It is the normal case today - no variant art has been drawn
## yet - and it is not a hole in the map, just a shoreline that does not
## know which way the land is.
func _terrain_tile_key(x: int, y: int, terrain_id: String) -> String:
	var owner_slot := state.tile_owner_at(x, y)
	if not TerrainTileSet.autotiles(terrain_id):
		return TerrainTileSet.tile_key(terrain_id, owner_slot)

	var neighbours := [
		state.terrain_at(x, y - 1),
		state.terrain_at(x + 1, y),
		state.terrain_at(x, y + 1),
		state.terrain_at(x - 1, y),
	]
	var mask := TerrainTileSet.neighbour_mask(terrain_id, neighbours)
	var candidates := TerrainTileSet.variant_keys(terrain_id, owner_slot, mask)
	for candidate in candidates:
		if _atlas_coords.has(candidate):
			return String(candidate)
	return String(candidates[candidates.size() - 1])


## Reconciles the unit nodes against the state: update what is still there,
## add what is new, free what is gone. Rebuilding the layer wholesale would
## throw away any in-flight animation on a unit that merely moved.
func _render_units() -> void:
	for unit_id in _unit_nodes.keys():
		if not state.units.has(unit_id):
			(_unit_nodes[unit_id] as Node).queue_free()
			_unit_nodes.erase(unit_id)

	for unit_id in state.units:
		var node: Unit = _unit_nodes.get(unit_id)
		if node == null:
			node = Unit.new()
			unit_layer.add_child(node)
			_unit_nodes[unit_id] = node
		node.bind(state.units[unit_id])


## Once per key, not once per tile: a map full of a missing variant would
## otherwise push hundreds of identical errors per redraw.
func _report_missing_tile(key: String) -> void:
	if _missing_tiles.has(key):
		return
	_missing_tiles[key] = true
	push_error("Board: no terrain tile for '%s'; drawing it unowned. "
		% key + "TerrainTileSet.owner_slots() and BoardTheme.SLOT_COLORS disagree.")


func unit_node(unit_id: String) -> Unit:
	return _unit_nodes.get(unit_id)


## --- overlays ----------------------------------------------------------

func clear_overlays() -> void:
	overlay_layer.clear()


func show_movement_range(tiles: Array) -> void:
	overlay_layer.highlight(tiles, BoardTheme.MOVE_RANGE)


func show_attack_range(tiles: Array) -> void:
	overlay_layer.highlight(tiles, BoardTheme.ATTACK_RANGE)


func show_selection(tile: Vector2i) -> void:
	overlay_layer.highlight([tile], Color.WHITE, true)


## The target a second tap would attack, marked apart from the others so
## "which one is armed" is never a guess.
func show_armed_target(tile: Vector2i) -> void:
	overlay_layer.highlight([tile], BoardTheme.ARMED_TARGET, true)


## --- coordinates -------------------------------------------------------

func tile_at_world(world_position: Vector2) -> Vector2i:
	return Vector2i(floori(world_position.x / BoardTheme.TILE_SIZE),
		floori(world_position.y / BoardTheme.TILE_SIZE))


func world_at_tile(tile: Vector2i) -> Vector2:
	return Vector2(tile) * BoardTheme.TILE_SIZE


## --- input -------------------------------------------------------------
##
## The board only reports *where* the player tapped. What that means - select,
## move, attack - is MatchController's decision. Keeping the two apart is what
## lets the interaction rules be tested without synthesising input events.
##
## Only touch events are handled: the project enables
## pointing/emulate_touch_from_mouse, so mouse clicks arrive here as touches
## too, and listening to both families would fire every tap twice.

func _unhandled_input(event: InputEvent) -> void:
	if event is InputEventScreenTouch and not event.pressed:
		_resolve_tap(event.position)


func _resolve_tap(screen_position: Vector2) -> void:
	# A release that ended a pan or pinch is not a tap.
	if camera.was_dragged():
		return

	var world: Vector2 = get_viewport().get_canvas_transform().affine_inverse() * screen_position
	var tile := tile_at_world(world)
	if state != null and not state.in_bounds(tile.x, tile.y):
		return
	tile_tapped.emit(tile)
