class_name TileOverlay
extends Node2D
## Highlights sets of tiles - movement range, attack range, the selected unit.
##
## Purely a renderer: it is handed tiles and colours and draws them. It does
## not decide which tiles are legal. That comes from MovementPreview, which is
## itself only a preview - the server has the final say (see CLAUDE.md rule 4).

var _layers: Array[Dictionary] = []


func clear() -> void:
	_layers.clear()
	queue_redraw()


func highlight(tiles: Array, color: Color, outline: bool = false) -> void:
	_layers.append({"tiles": tiles, "color": color, "outline": outline})
	queue_redraw()


func _draw() -> void:
	var size := float(BoardTheme.TILE_SIZE)
	for layer in _layers:
		var color: Color = layer["color"]
		var outline: bool = layer["outline"]
		for tile in layer["tiles"]:
			var position := Vector2(tile.x * size, tile.y * size)
			var rect := Rect2(position, Vector2(size, size))
			if outline:
				draw_rect(rect.grow(-1.5), color, false, 2.0)
			else:
				draw_rect(rect, color)
