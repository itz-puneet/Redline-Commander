extends Node
## Renders the fixture match to a PNG.
##
## Unlike board_check.tscn this needs a real renderer, so it will not run
## under --headless. On a machine without a display, use xvfb:
##
##   cd client && xvfb-run -a godot res://tests/board_preview.tscn
##
## Writes to user://board_preview.png and prints the absolute path. Useful
## for eyeballing a change to the theme or the tile generator without
## building the whole app, and for attaching a picture to a review.

const BOARD_SCENE := preload("res://scenes/board.tscn")
const OUTPUT := "user://board_preview.png"


func _ready() -> void:
	var board: Board = BOARD_SCENE.instantiate()
	add_child(board)

	var state := MatchState.from_view(Fixtures.match_view())
	board.render(state)

	# Show what the player would see with the light tank selected: its real
	# movement range from MovementPreview, plus what it could attack.
	var tank: Dictionary = state.units["a1"]
	board.show_movement_range(MovementPreview.reachable_tiles(state, tank).keys())
	board.show_attack_range(MovementPreview.attackable_tiles(state, tank))
	board.show_selection(Vector2i(int(tank["x"]), int(tank["y"])))

	# Let the renderer settle before grabbing the frame.
	await RenderingServer.frame_post_draw
	await get_tree().process_frame
	await RenderingServer.frame_post_draw

	var image := get_viewport().get_texture().get_image()
	var error := image.save_png(OUTPUT)
	if error != OK:
		printerr("board_preview: could not write %s (error %d)" % [OUTPUT, error])
		get_tree().quit(1)
		return

	print("board_preview: wrote %s" % ProjectSettings.globalize_path(OUTPUT))
	get_tree().quit(0)
