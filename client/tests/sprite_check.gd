extends Node
## Headless checks for the generated unit sprite sheet.
##
## The sheet is produced by Blender (art/blender/, tools/render-sprites.sh)
## and committed, so nothing here re-renders it - these are the assertions
## that the committed sheet is one the board can actually use, and that it
## covers every unit type the shared table declares. A missing frame does
## not crash the game; Unit falls back to a placeholder block. That is
## exactly why it needs a check rather than a look.
##
##   cd client && godot --headless res://tests/sprite_check.tscn

var _failures := 0


func _ready() -> void:
	_check_manifest()
	_check_geometry()
	_check_coverage()
	_check_units_use_it()

	if _failures == 0:
		print("\nsprite_check: all checks passed")
	else:
		printerr("\nsprite_check: %d check(s) FAILED" % _failures)
	get_tree().quit(0 if _failures == 0 else 1)


func _check(label: String, condition: bool, detail: String = "") -> void:
	if condition:
		print("ok   %s" % label)
	else:
		_failures += 1
		printerr("FAIL %s%s" % [label, "" if detail.is_empty() else " (%s)" % detail])


func _check_manifest() -> void:
	_check("the sprite sheet loads", UnitSprites.ready())
	if not UnitSprites.ready():
		# Everything below reads the sheet; without one they would each
		# report a second failure for the same cause.
		return

	# Data-driven on purpose: adding a unit to shared/data/units.json without
	# re-rendering the sheet has to fail here, not ship as an invisible unit.
	var expected: Array = GameData.units.keys()
	expected.sort()
	_check("every unit type in the shared table has a frame",
		UnitSprites.frame_names() == expected,
		"sheet has %s, table has %s" % [UnitSprites.frame_names(), expected])

	_check("the sheet's tile size matches the board's",
		UnitSprites.tile_size() == BoardTheme.TILE_SIZE,
		"sheet %d vs BoardTheme %d" % [UnitSprites.tile_size(), BoardTheme.TILE_SIZE])
	_check("a cell is at least as large as a tile",
		UnitSprites.cell_size() >= UnitSprites.tile_size(),
		"cell %d, tile %d" % [UnitSprites.cell_size(), UnitSprites.tile_size()])


func _check_geometry() -> void:
	if not UnitSprites.ready():
		return
	var sheet := UnitSprites.sheet()
	var mask := UnitSprites.mask()
	var cell := UnitSprites.cell_size()

	_check("the mask is the same size as the sheet",
		mask.get_size() == sheet.get_size(),
		"%v vs %v" % [mask.get_size(), sheet.get_size()])
	_check("the sheet is exactly one row of cells",
		sheet.get_height() == cell, "%d vs %d" % [sheet.get_height(), cell])
	_check("the sheet is exactly as wide as it has frames",
		sheet.get_width() == cell * UnitSprites.frame_names().size(),
		"%d px for %d frames" % [sheet.get_width(), UnitSprites.frame_names().size()])

	var inside := true
	for unit_type in UnitSprites.frame_names():
		var region := UnitSprites.region_for(unit_type)
		if region.position.x < 0 or region.end.x > sheet.get_width() \
				or region.end.y > sheet.get_height():
			inside = false
	_check("every frame lies inside the sheet", inside)


func _check_coverage() -> void:
	if not UnitSprites.ready():
		return
	var base := UnitSprites.sheet().get_image()
	var mask := UnitSprites.mask().get_image()
	var cell := UnitSprites.cell_size()

	var empty: Array = []
	var untinted: Array = []
	var leaking: Array = []
	var bleeding: Array = []

	for unit_type in UnitSprites.frame_names():
		var origin := int(UnitSprites.region_for(unit_type).position.x)
		var drawn := 0
		var team := 0
		var mask_outside_unit := 0
		var edge := 0
		for y in cell:
			for x in cell:
				var alpha := base.get_pixel(origin + x, y).a
				var mask_pixel := mask.get_pixel(origin + x, y)
				var is_team: bool = mask_pixel.a > 0.5 and mask_pixel.r > 0.5
				if alpha > 0.5:
					drawn += 1
					if is_team:
						team += 1
					# The border of the cell must stay clear, or a frame
					# would show a slice of its neighbour on the board.
					if x == 0 or y == 0 or x == cell - 1 or y == cell - 1:
						edge += 1
				elif is_team:
					# The tint would be painted where there is no unit.
					mask_outside_unit += 1
		if drawn == 0:
			empty.append(unit_type)
		if team == 0:
			untinted.append(unit_type)
		if mask_outside_unit > 0:
			leaking.append("%s:%d" % [unit_type, mask_outside_unit])
		if edge > 0:
			bleeding.append("%s:%d" % [unit_type, edge])

	_check("every frame has a unit rendered in it", empty.is_empty(),
		"blank: %s" % str(empty))
	# Without this a unit would be drawn in neutral grey whoever owned it,
	# and the board's only cue for ownership would be gone.
	_check("every frame has faction-coloured pixels to tint", untinted.is_empty(),
		"no team mask: %s" % str(untinted))
	_check("the mask never marks pixels outside a unit", leaking.is_empty(),
		str(leaking))
	_check("no frame touches its cell border", bleeding.is_empty(), str(bleeding))


func _check_units_use_it() -> void:
	# The point of the sheet is that Unit draws it. Asserting on the manifest
	# alone would stay green if Unit never looked at it.
	var without: Array = []
	for unit_type in GameData.units.keys():
		var unit := Unit.new()
		add_child(unit)
		unit.bind({"id": "u1", "unitType": unit_type, "ownerSlot": 1, "x": 0, "y": 0,
			"hp": 100})
		if not unit.has_sprite():
			without.append(unit_type)
		unit.queue_free()
	_check("a Unit of every type draws a sprite rather than a placeholder",
		without.is_empty(), "placeholder: %s" % str(without))

	# The fallback has to keep working: a checkout that has not rendered the
	# sheet must still put something on the board.
	var unknown := Unit.new()
	add_child(unknown)
	unknown.bind({"id": "u2", "unitType": "not_a_unit", "ownerSlot": 1, "x": 0, "y": 0,
		"hp": 100})
	_check("a unit type with no frame falls back to a placeholder",
		not unknown.has_sprite())
	unknown.queue_free()
