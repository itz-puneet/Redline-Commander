extends Node
## Renders the build menu to a PNG.
##
## Shown with limited funds on purpose: everything affordable looks the same
## whatever the prices are, so the interesting state is the one where some
## options are out of reach.
##
##   cd client && xvfb-run -a godot --resolution 1280x720 res://tests/build_preview.tscn

const MATCH_SCENE := preload("res://scenes/match.tscn")
const OUTPUT := "user://build_preview.png"
## Slot 1's factory on the shipped map.
const FACTORY := Vector2i(2, 0)
const FUNDS := 750


func _ready() -> void:
	var match_scene := MATCH_SCENE.instantiate()
	add_child(match_scene)

	var controller: MatchController = match_scene.get_node("MatchController")
	# Go in through the real path - a poorer player, then a tap on their
	# factory - so the header, the bar and the greyed-out rows all agree.
	var view := Fixtures.match_view()
	for player in view["players"]:
		if int(player["slot"]) == 1:
			player["funds"] = FUNDS
	controller.load_view(view)
	await get_tree().process_frame

	controller.tap_tile(FACTORY)

	await RenderingServer.frame_post_draw
	await get_tree().process_frame
	await RenderingServer.frame_post_draw

	var image := get_viewport().get_texture().get_image()
	if image.save_png(OUTPUT) != OK:
		printerr("build_preview: could not write %s" % OUTPUT)
		get_tree().quit(1)
		return

	print("build_preview: wrote %s" % ProjectSettings.globalize_path(OUTPUT))
	get_tree().quit(0)
