extends Node
## Renders the unit sheet through the real tint shader and checks the result.
##
## This is the check sprite_check cannot be. Everything about the tint - that
## `UV` inside a canvas_item shader lands in the sprite's region rather than
## across the whole sheet, that the mask lines up with the frame it is
## masking, that a faction colour comes out as that colour - only exists once
## something has actually rasterised. Under --headless the dummy renderer
## draws nothing, so this needs a display.
##
##   cd client && xvfb-run -a godot --resolution 1280x720 res://tests/sprite_preview.tscn
##
## Writes user://sprite_preview.png (every unit type in two factions) and
## prints the absolute path.

const OUTPUT := "user://sprite_preview.png"
## Two slots far apart in hue, so "did the tint apply" cannot be answered by
## a rounding difference.
const SLOT_A := 1
const SLOT_B := 2
## A pixel counts as re-tinted when the two factions' renders differ by more
## than this on any channel. Above the render's own noise, well below the
## distance between the two faction colours.
const DIFFERENCE := 0.08
## The tinted-pixel count is compared against the mask's own team-pixel
## count. They will not match exactly - the shader blends partial mask values
## on antialiased edges - but a mis-mapped UV would miss by far more.
const COUNT_TOLERANCE := 0.15

var _failures := 0


func _check(label: String, condition: bool, detail: String = "") -> void:
	if condition:
		print("ok   %s" % label)
	else:
		_failures += 1
		printerr("FAIL %s%s" % [label, "" if detail.is_empty() else " (%s)" % detail])


func _ready() -> void:
	if not UnitSprites.ready():
		printerr("sprite_preview: no unit sheet - run tools/render-sprites.sh")
		get_tree().quit(1)
		return
	if DisplayServer.get_name() == "headless":
		# Without this the viewport reads back empty and every assertion
		# below passes on a blank image, which is worse than not running.
		printerr("sprite_preview: needs a display; run it under xvfb-run")
		get_tree().quit(1)
		return

	await _run()

	if _failures == 0:
		print("\nsprite_preview: all checks passed")
	else:
		printerr("\nsprite_preview: %d check(s) FAILED" % _failures)
	get_tree().quit(0 if _failures == 0 else 1)


func _run() -> void:
	var types: Array = UnitSprites.frame_names()
	var cell := UnitSprites.cell_size()

	var rendered_a := await _render_row(types, SLOT_A)
	var rendered_b := await _render_row(types, SLOT_B)
	_check("the board renders the sheet at all",
		rendered_a != null and rendered_b != null)
	if rendered_a == null or rendered_b == null:
		return

	var mask := UnitSprites.mask().get_image()
	var mismatched: Array = []
	var untinted: Array = []
	for index in types.size():
		var expected := _team_pixels(mask, int(UnitSprites.region_for(types[index]).position.x), cell)
		var actual := _changed_pixels(rendered_a, rendered_b, index * cell, cell)
		if actual == 0:
			untinted.append(types[index])
		elif absf(float(actual - expected)) / maxf(float(expected), 1.0) > COUNT_TOLERANCE:
			mismatched.append("%s: masked %d, tinted %d" % [types[index], expected, actual])

	# If the tint applied to nothing, the shader is not running, the mask
	# never reached it, or every faction renders identically.
	_check("every unit re-tints when its faction changes", untinted.is_empty(),
		"unchanged: %s" % str(untinted))
	# If the tint applied to the wrong pixels, UV is not landing inside the
	# sprite's region and units are being masked by their neighbour's frame.
	_check("the tinted pixels are the ones the mask marks", mismatched.is_empty(),
		str(mismatched))

	_check_faction_colour(rendered_a, rendered_b, cell, types)

	var contact := Image.create(rendered_a.get_width(), cell * 2, false,
		rendered_a.get_format())
	contact.blit_rect(rendered_a, Rect2i(0, 0, rendered_a.get_width(), cell), Vector2i.ZERO)
	contact.blit_rect(rendered_b, Rect2i(0, 0, rendered_b.get_width(), cell), Vector2i(0, cell))
	var error := contact.save_png(OUTPUT)
	if error != OK:
		printerr("sprite_preview: could not write %s (error %d)" % [OUTPUT, error])
	else:
		print("sprite_preview: wrote %s" % ProjectSettings.globalize_path(OUTPUT))


## Draws every unit type in one row, owned by `slot`, and reads it back.
func _render_row(types: Array, slot: int) -> Image:
	var cell := UnitSprites.cell_size()
	var viewport := SubViewport.new()
	viewport.size = Vector2i(cell * types.size(), cell)
	viewport.transparent_bg = true
	viewport.render_target_update_mode = SubViewport.UPDATE_ALWAYS
	add_child(viewport)

	for index in types.size():
		var unit := Unit.new()
		viewport.add_child(unit)
		unit.bind({"id": "u%d" % index, "unitType": types[index], "ownerSlot": slot,
			"x": 0, "y": 0, "hp": 100})
		# Centre each cell in its column: the sprite sits half a tile into
		# the unit, and the cell is drawn centred on that.
		unit.position = Vector2(index * cell + (cell - BoardTheme.TILE_SIZE) * 0.5,
			(cell - BoardTheme.TILE_SIZE) * 0.5)

	# Two frames, not one: the first is where the viewport is sized and the
	# material compiled, and reading back after it returns an empty image.
	await RenderingServer.frame_post_draw
	await RenderingServer.frame_post_draw
	var image := viewport.get_texture().get_image()
	viewport.queue_free()
	return image


func _team_pixels(mask: Image, origin: int, cell: int) -> int:
	var count := 0
	for y in cell:
		for x in cell:
			var pixel := mask.get_pixel(origin + x, y)
			if pixel.a > 0.5 and pixel.r > 0.5:
				count += 1
	return count


func _changed_pixels(a: Image, b: Image, origin: int, cell: int) -> int:
	var count := 0
	for y in cell:
		for x in cell:
			var first := a.get_pixel(origin + x, y)
			var second := b.get_pixel(origin + x, y)
			if absf(first.r - second.r) > DIFFERENCE or absf(first.g - second.g) > DIFFERENCE \
					or absf(first.b - second.b) > DIFFERENCE:
				count += 1
	return count


## The tint has to produce the faction's actual colour, not merely some
## difference: a shader that swapped the channels would satisfy everything
## above.
func _check_faction_colour(a: Image, b: Image, cell: int, types: Array) -> void:
	var red := BoardTheme.slot_color(SLOT_A)
	var blue := BoardTheme.slot_color(SLOT_B)
	var wrong: Array = []
	for index in types.size():
		var first := _mean_of_changed(a, b, index * cell, cell, a)
		var second := _mean_of_changed(a, b, index * cell, cell, b)
		# Compare within each render rather than against a fixed value: the
		# render's shading moves the absolute brightness, but the faction
		# with more red must still come out redder.
		var a_leans_red: bool = first.r - first.b > second.r - second.b
		if not a_leans_red:
			wrong.append("%s: slot %d %s, slot %d %s" % [types[index], SLOT_A, first,
				SLOT_B, second])
	_check("slot %d renders redder than slot %d, as its colours say"
		% [SLOT_A, SLOT_B], wrong.is_empty(), str(wrong))
	_check("the faction colours under test are actually far apart",
		absf((red.r - red.b) - (blue.r - blue.b)) > 0.3,
		"%s vs %s" % [red, blue])


func _mean_of_changed(a: Image, b: Image, origin: int, cell: int, source: Image) -> Color:
	var total := Color(0, 0, 0, 0)
	var count := 0
	for y in cell:
		for x in cell:
			var first := a.get_pixel(origin + x, y)
			var second := b.get_pixel(origin + x, y)
			if absf(first.r - second.r) > DIFFERENCE or absf(first.b - second.b) > DIFFERENCE:
				total += source.get_pixel(origin + x, y)
				count += 1
	if count == 0:
		return Color(0, 0, 0, 0)
	return total / float(count)
