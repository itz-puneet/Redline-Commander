extends PanelContainer
## Persistent status: whose turn it is, which round, and what you can spend.
##
## Funds used to live in the action bar's status line, where they competed
## with contextual text and vanished whenever something was selected. Money
## is a standing fact, so it belongs somewhere that never changes meaning.

@onready var _turn: Label = $Margin/Row/Turn
@onready var _round: Label = $Margin/Row/Round
@onready var _funds: Label = $Margin/Row/Funds


func refresh(state: MatchState) -> void:
	if state == null:
		_turn.text = "Connecting..."
		_round.text = ""
		_funds.text = ""
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

	# A dropped opponent is worth saying out loud: in a game where a turn can
	# arrive hours later, silence and absence look identical.
	for player in state.players:
		if int(player.get("slot", 0)) != state.you_slot \
				and not bool(player.get("connected", true)):
			_turn.text = "%s  (opponent offline)" % _turn.text
			break
