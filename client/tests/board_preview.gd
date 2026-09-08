extends Node
## Renders the playable match screen to a PNG.
##
## Drives the real scenes/match.tscn - board, action bar and controller -
## seeded with the test fixture and with a unit selected, so the picture
## shows what a player actually sees rather than a board in isolation.
##
## Needs a real renderer, so it will not run under --headless:
##
##   cd client && xvfb-run -a godot --resolution 1280x720 res://tests/board_preview.tscn
##
## Writes to user://board_preview.png and prints the absolute path.

const MATCH_SCENE := preload("res://scenes/match.tscn")
const OUTPUT := "user://board_preview.png"
## The light tank, mid-map and in contact with an enemy.
const SELECT_TILE := Vector2i(6, 4)


func _ready() -> void:
	var match_scene := MATCH_SCENE.instantiate()
	add_child(match_scene)

	var controller: MatchController = match_scene.get_node("MatchController")
	controller.load_view(Fixtures.match_view())
	controller.tap_tile(SELECT_TILE)

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
