extends PanelContainer
## The build menu: what this production building can make, and for how much.
##
## A dumb view like the lobby - it is handed a tile and some funds, renders
## the options, and emits which one was picked. It does not know whether the
## player may build, only what the choices look like; MatchController decides
## when to open it and the server decides whether the build stands.
##
## Sits above the action bar rather than over the middle of the board, so the
## tile being built on stays visible while choosing.

signal unit_chosen(unit_type: String)
signal cancelled()

@onready var _header: Label = $Margin/Column/Header
## A grid rather than a list: seven ground units in one column would
## scroll on a phone, and the whole point is comparing prices at a glance.
@onready var _list: GridContainer = $Margin/Column/Scroll/List
@onready var _cancel: Button = $Margin/Column/Cancel

## Enough to show every option without scrolling, but no taller. A factory
## has seven options and a port has one; a fixed height either clips the
## first or leaves the second mostly empty.
const ROW_HEIGHT := 50.0
const CHROME_HEIGHT := 118.0   ## header, cancel button, margins and gaps
const MIN_HEIGHT := 168.0
const MAX_HEIGHT := 380.0
const COLUMNS := 2
## Height of the action bar this sits above.
const BOTTOM_INSET := -72.0

var _tile := Vector2i.ZERO
var _affordable := 0


func _ready() -> void:
	_cancel.pressed.connect(func():
		close()
		cancelled.emit())
	hide()


## Populate for a production tile. `funds` gates which entries are pressable.
func open_for(terrain_id: String, tile: Vector2i, funds: int, faction_id: String) -> void:
	_tile = tile
	_affordable = 0

	for child in _list.get_children():
		child.queue_free()
	# Freed children linger until the frame ends, so drop them from the tree
	# now - otherwise the counts below include the previous tile's options.
	for child in _list.get_children():
		_list.remove_child(child)

	var terrain := GameData.terrain_stats(terrain_id)
	_header.text = "%s — %d funds" % [terrain.get("display_name", terrain_id), funds]

	for unit_type in GameData.buildable_at(terrain_id):
		var stats := GameData.unit_stats(unit_type)
		var cost := GameData.build_cost(unit_type, faction_id)
		var affordable := cost <= funds
		if affordable:
			_affordable += 1

		var button := Button.new()
		button.text = "%s      %d" % [stats.get("display_name", unit_type), cost]
		button.alignment = HORIZONTAL_ALIGNMENT_LEFT
		button.custom_minimum_size = Vector2(0, 44)
		button.size_flags_horizontal = Control.SIZE_EXPAND_FILL
		button.disabled = not affordable
		button.pressed.connect(func(): _choose(unit_type))
		_list.add_child(button)

	_size_to_content()
	show()


## Anchored to the bottom, so the height is set by moving the top edge.
func _size_to_content() -> void:
	var rows := ceili(_list.get_child_count() / float(COLUMNS))
	var height := clampf(CHROME_HEIGHT + rows * ROW_HEIGHT, MIN_HEIGHT, MAX_HEIGHT)
	offset_top = BOTTOM_INSET - height
	offset_bottom = BOTTOM_INSET


func close() -> void:
	hide()


func is_open() -> bool:
	return visible


func tile() -> Vector2i:
	return _tile


## Test seams: how many options are listed, and how many can be paid for.
func option_count() -> int:
	return _list.get_child_count()


func affordable_count() -> int:
	return _affordable


func option_labels() -> Array[String]:
	var out: Array[String] = []
	for child in _list.get_children():
		out.append((child as Button).text)
	return out


func _choose(unit_type: String) -> void:
	close()
	unit_chosen.emit(unit_type)
