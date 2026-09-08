extends Node
## Renders the lobby to a PNG.
##
## Companion to board_preview: same idea, the other screen. Shows the lobby
## as it looks connected, with a remembered match so the rejoin row is
## visible - the state that is easiest to break and hardest to notice.
##
##   cd client && xvfb-run -a godot --resolution 1280x720 res://tests/lobby_preview.tscn

const LOBBY_SCENE := preload("res://scenes/lobby.tscn")
const OUTPUT := "user://lobby_preview.png"


func _ready() -> void:
	Session.remember_match("8785837ae6cb")

	var lobby: Control = LOBBY_SCENE.instantiate()
	add_child(lobby)
	await get_tree().process_frame

	lobby.set_server_url("ws://192.168.1.24:2567/play")
	lobby.set_connected(true)
	lobby.show_message("Ask your friend for their match code, or create one.")

	await RenderingServer.frame_post_draw
	await get_tree().process_frame
	await RenderingServer.frame_post_draw

	var image := get_viewport().get_texture().get_image()
	if image.save_png(OUTPUT) != OK:
		printerr("lobby_preview: could not write %s" % OUTPUT)
		get_tree().quit(1)
		return

	print("lobby_preview: wrote %s" % ProjectSettings.globalize_path(OUTPUT))
	get_tree().quit(0)
