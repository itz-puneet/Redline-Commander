class_name FogOverlay
extends Node2D
## Draws the fog of war.
##
## Cosmetic only, and worth being clear about why: the server never sends
## units standing on tiles this player cannot see (server/src/game/view.ts),
## so this layer is dimming *empty* ground. It cannot leak anything, because
## there is nothing underneath it to hide.

var _state: MatchState = null


func render(state: MatchState) -> void:
	_state = state
	queue_redraw()


func _draw() -> void:
	if _state == null:
		return

	var size := float(BoardTheme.TILE_SIZE)
	for y in _state.map_height:
		for x in _state.map_width:
			if not _state.is_visible(x, y):
				draw_rect(Rect2(x * size, y * size, size, size), BoardTheme.FOG_COLOR)
