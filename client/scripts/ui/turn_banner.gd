extends Label
## A brief banner when the turn changes.
##
## Async play means a turn can arrive minutes or hours after the last one, at
## which point the board looks identical to how it was left. Something has to
## say "it is you now" without the player hunting for a changed label.

const HOLD_SECONDS := 1.1
const FADE_SECONDS := 0.45

var _tween: Tween = null


func _ready() -> void:
	modulate.a = 0.0


func announce(text: String, color: Color) -> void:
	self.text = text
	modulate = color
	modulate.a = 0.0

	# A turn arriving while the last banner is still fading replaces it
	# rather than stacking two tweens on the same property.
	if _tween != null and _tween.is_running():
		_tween.kill()

	_tween = create_tween()
	_tween.tween_property(self, "modulate:a", 1.0, FADE_SECONDS * 0.5)
	_tween.tween_interval(HOLD_SECONDS)
	_tween.tween_property(self, "modulate:a", 0.0, FADE_SECONDS)


func is_showing() -> bool:
	return modulate.a > 0.01
