extends Node
## Renders a map's terrain to a PNG, at the zoom the game actually frames it at.
##
## board_preview shows the playable screen - HUD, units, a selection. This
## shows the ground, and nothing else, because the thing being inspected is
## the terrain art itself: whether shores face the land, whether roads meet
## at their tile edges, whether a reef reads as an obstacle. Units and fog
## would sit on top of exactly the tiles in question.
##
## Needs a real renderer, so it will not run under --headless:
##
##   cd client && xvfb-run -a godot --resolution 1280x720 \
##       res://tests/terrain_preview.tscn -- --map straits
##
## Writes to user://terrain_preview_<map>.png and prints the absolute path.

const BOARD_SCENE := preload("res://scenes/board.tscn")
const DEFAULT_MAP := "straits"


func _ready() -> void:
	var map_id := _requested_map()

	var board: Board = BOARD_SCENE.instantiate()
	add_child(board)

	# reveal_all, then units stripped: fog and sprites both cover ground.
	var view := Fixtures.match_view(true, map_id)
	view["units"] = []
	board.render(MatchState.from_view(view))

	await RenderingServer.frame_post_draw
	await get_tree().process_frame
	await RenderingServer.frame_post_draw

	var output := "user://terrain_preview_%s.png" % map_id
	var image := get_viewport().get_texture().get_image()
	var error := image.save_png(output)
	if error != OK:
		printerr("terrain_preview: could not write %s (error %d)" % [output, error])
		get_tree().quit(1)
		return

	print("terrain_preview: %s at zoom %.3f -> %s"
		% [map_id, board.camera.zoom.x, ProjectSettings.globalize_path(output)])
	get_tree().quit(0)


## `-- --map <id>`. Anything unrecognised falls through to the default rather
## than rendering the wrong map silently.
func _requested_map() -> String:
	var args := OS.get_cmdline_user_args()
	for i in args.size():
		if args[i] == "--map" and i + 1 < args.size():
			return args[i + 1]
	return DEFAULT_MAP
