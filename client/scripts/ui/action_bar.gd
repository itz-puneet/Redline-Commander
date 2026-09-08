extends PanelContainer
## Minimal action bar for the selected unit.
##
## Placeholder HUD: a bottom bar rather than a floating menu because it is
## reachable by thumb on a phone and needs no world-to-screen maths. The real
## HUD (funds, unit info panel, turn banner) is a separate roadmap item.
##
## Attack is deliberately NOT a button here - the player attacks by tapping a
## highlighted enemy, which is one gesture instead of two.

## Height the bar occupies, so the camera can keep the board clear of it.
const BAR_HEIGHT := 72.0

signal capture_pressed()
signal wait_pressed()
signal cancel_pressed()
signal end_turn_pressed()

@onready var _status: Label = $Row/Status
@onready var _capture: Button = $Row/Capture
@onready var _wait: Button = $Row/Wait
@onready var _cancel: Button = $Row/Cancel
@onready var _end_turn: Button = $Row/EndTurn


func _ready() -> void:
	_capture.pressed.connect(func(): capture_pressed.emit())
	_wait.pressed.connect(func(): wait_pressed.emit())
	_cancel.pressed.connect(func(): cancel_pressed.emit())
	_end_turn.pressed.connect(func(): end_turn_pressed.emit())


## Called by MatchController after every state change.
func refresh(status_text: String, has_selection: bool, can_capture: bool,
		can_end_turn: bool) -> void:
	_status.text = status_text
	_capture.visible = can_capture
	_wait.visible = has_selection
	_cancel.visible = has_selection
	# Ending the turn mid-selection is a common misfire, so it is offered
	# only when nothing is selected.
	_end_turn.visible = can_end_turn and not has_selection
