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
## then units. Fog sits UNDER the overlays deliberately - a player can move
## into ground they have not scouted, so the movement range has to stay
## readable through the fog rather than being dimmed by it.

@onready var terrain_layer: TileMapLayer = $TerrainLayer
@onready var fog_layer: FogOverlay = $FogLayer
@onready var overlay_layer: TileOverlay = $OverlayLayer
@onready var unit_layer: Node2D = $UnitLayer
@onready var camera: BoardCamera = $BoardCamera

var state: MatchState = null

var _unit_nodes: Dictionary = {}   ## unit_id -> Unit
var _atlas_coords: Dictionary = {}
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
			var key := TerrainTileSet.tile_key(state.terrain_at(x, y), state.tile_owner_at(x, y))
			if _atlas_coords.has(key):
				terrain_layer.set_cell(Vector2i(x, y), _source_id, _atlas_coords[key])


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


## --- coordinates -------------------------------------------------------

func tile_at_world(world_position: Vector2) -> Vector2i:
	return Vector2i(floori(world_position.x / BoardTheme.TILE_SIZE),
		floori(world_position.y / BoardTheme.TILE_SIZE))


func world_at_tile(tile: Vector2i) -> Vector2:
	return Vector2(tile) * BoardTheme.TILE_SIZE


# TODO (next pass): tap-to-select and tap-to-move. Board emits the tap, a
# controller asks MovementPreview what to highlight, and confirms through
# TurnController - keeping input, preview and submission separable.
