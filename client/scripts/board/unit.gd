class_name Unit
extends Node2D
## The visual representation of one unit on the board.
##
## Holds no authoritative data of its own: it is bound to an entry from
## MatchState and re-reads it. Stats always come from GameData by unit type,
## never hardcoded here, so rebalancing is a data edit and nothing else.
##
## The artwork is a frame from the generated unit sheet (see UnitSprites),
## tinted to the owner's colour through a mask so one render serves every
## faction. The blocks drawn in _draw() are the fallback for a checkout that
## has not rendered the sheet yet - `sprite_check` is what asserts the sheet
## actually covers every unit type, because a fallback that looks plausible
## is exactly the kind of thing nobody notices.
##
## State the player reads off a unit - health pips, capture progress, whether
## it has already acted - stays in _draw() on top of the sprite rather than
## being baked into the artwork, so it costs nothing to re-render the sheet.

var unit_id: String = ""
var unit_type: String = "infantry"
var owner_slot: int = 0
var grid_position := Vector2i.ZERO
var hp: int = 100
var has_moved: bool = false
var has_acted: bool = false
var capture_progress: int = 0
## Enemy units are reported without fuel/ammo - the server does not send what
## the player is not entitled to see.
var fuel: int = -1
var ammo: int = -1

const TEAM_TINT: Shader = preload("res://shaders/team_tint.gdshader")
## Dimmed rather than covered: a tint rect over a sprite would square off its
## silhouette, which is the one thing the artwork exists to preserve.
const SPENT_SPRITE_TINT := Color(0.68, 0.68, 0.75)

var _sprite: Sprite2D = null


func _init() -> void:
	_sprite = Sprite2D.new()
	# Behind the parent, so the overlays _draw() puts on top - pips, capture
	# progress - are not hidden by the child that draws after it.
	_sprite.show_behind_parent = true
	# The sheet is antialiased 3D, not pixel art: nearest-neighbour would
	# crawl the moment the camera moves off 1:1. Mipmaps stay off on purpose,
	# so a minified frame cannot bleed into the frame beside it on the sheet.
	_sprite.texture_filter = CanvasItem.TEXTURE_FILTER_LINEAR
	_sprite.visible = false
	add_child(_sprite)


func bind(data: Dictionary) -> void:
	unit_id = String(data.get("id", ""))
	unit_type = String(data.get("unitType", "infantry"))
	owner_slot = int(data.get("ownerSlot", 0))
	grid_position = Vector2i(int(data.get("x", 0)), int(data.get("y", 0)))
	hp = int(data.get("hp", 100))
	has_moved = bool(data.get("hasMoved", false))
	has_acted = bool(data.get("hasActed", false))
	capture_progress = int(data.get("captureProgress", 0))
	fuel = -1 if data.get("fuel") == null else int(data.get("fuel"))
	ammo = -1 if data.get("ammo") == null else int(data.get("ammo"))
	position = Vector2(grid_position) * BoardTheme.TILE_SIZE
	# bind() fully defines how this node looks. Animations move, fade and
	# scale these nodes, and one that is abandoned part-way (a newer update
	# arriving mid-sequence) would otherwise stay ghosted forever.
	modulate = Color.WHITE
	scale = Vector2.ONE
	_apply_sprite()
	queue_redraw()


## Points the sprite at this unit's frame and faction colour, or hides it
## when the sheet has no frame for this type. Called from bind(), so the
## sprite is part of "bind() fully defines how this node looks" rather than
## something an animation could leave behind.
func _apply_sprite() -> void:
	if not UnitSprites.ready() or not UnitSprites.has_frame(unit_type):
		_sprite.visible = false
		return

	if _sprite.texture == null:
		_sprite.texture = UnitSprites.sheet()
		var tint := ShaderMaterial.new()
		tint.shader = TEAM_TINT
		tint.set_shader_parameter("mask_tex", UnitSprites.mask())
		_sprite.material = tint

	_sprite.region_enabled = true
	_sprite.region_rect = UnitSprites.region_for(unit_type)
	# The cell is larger than the tile, and centring it on the tile is what
	# gives an overhanging rotor or gun barrel somewhere to go.
	_sprite.position = Vector2.ONE * (BoardTheme.TILE_SIZE * 0.5)
	(_sprite.material as ShaderMaterial).set_shader_parameter(
		"team_color", BoardTheme.slot_color(owner_slot))
	_sprite.modulate = SPENT_SPRITE_TINT if has_acted else Color.WHITE
	_sprite.visible = true


## Whether this unit is drawing artwork rather than a placeholder block.
## sprite_check asserts this is true for every unit type in the shared table.
func has_sprite() -> bool:
	return _sprite != null and _sprite.visible


func stats() -> Dictionary:
	return GameData.unit_stats(unit_type)


func display_name() -> String:
	return String(stats().get("display_name", unit_type))


func display_hp() -> int:
	return GameData.display_hp(hp)


func is_mine(you_slot: int) -> bool:
	return owner_slot == you_slot


## Whether the local player could still order this unit to do something.
func is_selectable(you_slot: int, my_turn: bool) -> bool:
	return my_turn and is_mine(you_slot) and not has_acted


func can_capture() -> bool:
	return bool(stats().get("can_capture", false))


func _draw() -> void:
	var size := float(BoardTheme.TILE_SIZE)
	var color := BoardTheme.slot_color(owner_slot)
	var body := Rect2(4, 4, size - 8, size - 8)
	var font := ThemeDB.fallback_font
	# Everything below is sized off the tile rather than in fixed pixels, so
	# TILE_SIZE stays the one number that lays the board out.
	var scale_to_tile := size / 32.0

	if not has_sprite():
		draw_rect(body, color.darkened(0.35))
		draw_rect(body.grow(-1.0), color)
		draw_string(font, Vector2(0, size * 0.62), BoardTheme.unit_label(unit_type),
			HORIZONTAL_ALIGNMENT_CENTER, size, roundi(9 * scale_to_tile), Color.WHITE)

	# Damaged units show their pip count, the way the player reads health.
	var pips := display_hp()
	if pips < 10:
		var badge_size := Vector2(10, 9) * scale_to_tile
		var badge := Rect2(Vector2(size, size) - badge_size - Vector2.ONE, badge_size)
		draw_rect(badge, Color(0, 0, 0, 0.7))
		draw_string(font, Vector2(badge.position.x, badge.end.y - 1.5 * scale_to_tile),
			str(pips), HORIZONTAL_ALIGNMENT_CENTER, badge_size.x,
			roundi(8 * scale_to_tile), Color.WHITE)

	if capture_progress > 0:
		var ratio := clampf(capture_progress / 20.0, 0.0, 1.0)
		draw_rect(Rect2(4, 4, (size - 8) * ratio, 2.5 * scale_to_tile), Color("#ffd766"))

	# A unit that has already acted is greyed out, so "what can still move"
	# is readable without tapping anything. The sprite dims itself in
	# _apply_sprite(); covering it with a rect would square off its outline.
	if has_acted and not has_sprite():
		draw_rect(body, BoardTheme.SPENT_TINT)


# TODO: per-unit-type idle and firing frames. The sheet has one frame per
# type today; adding more means another axis on the sheet and a frame index
# here, not a change to anything that reads it.
