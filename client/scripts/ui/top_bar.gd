extends PanelContainer
## Persistent status: whose turn it is, which round, and what you can spend.
##
## Funds used to live in the action bar's status line, where they competed
## with contextual text and vanished whenever something was selected. Money
## is a standing fact, so it belongs somewhere that never changes meaning.

@onready var _turn: Label = $Margin/Row/Turn
@onready var _round: Label = $Margin/Row/Round
@onready var _funds: Label = $Margin/Row/Funds
@onready var _directive: Label = $Margin/Row/Directive


func refresh(state: MatchState) -> void:
	if state == null:
		_turn.text = "Connecting..."
		_round.text = ""
		_funds.text = ""
		_directive.text = ""
		return

	if state.is_finished():
		_turn.text = "Victory" if state.winner_slot == state.you_slot else "Defeat"
		_turn.modulate = Color("#8ce99a") if state.winner_slot == state.you_slot \
			else Color("#ff8a80")
	else:
		_turn.text = "Your turn" if state.is_my_turn() else "Opponent's turn"
		_turn.modulate = Color("#ffffff") if state.is_my_turn() else Color("#9aa0ac")

	_round.text = "Round %d" % state.round_number
	_funds.text = "%d funds" % state.my_funds()
	_directive.text = _directive_text(state)

	# A dropped opponent is worth saying out loud: in a game where a turn can
	# arrive hours later, silence and absence look identical.
	for player in state.players:
		if int(player.get("slot", 0)) != state.you_slot \
				and not bool(player.get("connected", true)):
			_turn.text = "%s  (opponent offline)" % _turn.text
			break


## Either what is running - yours or theirs, since both are visible - or how
## close the local player is to being able to fire their own.
func _directive_text(state: MatchState) -> String:
	for player in state.players:
		var slot := int(player.get("slot", 0))
		var active := state.active_directive(slot)
		if active.is_empty():
			continue
		var name := String(GameData.factions.get(
			String(player.get("faction", "")), {}).get("directive", {}).get("display_name", active))
		return "%s: %s" % ["Yours" if slot == state.you_slot else "Enemy", name]

	var cost := GameData.directive_cost(state.my_faction())
	if cost <= 0:
		return ""
	return "Directive %d/%d" % [state.my_directive_charge(), cost]
