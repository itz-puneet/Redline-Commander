class_name TransportRules
extends RefCounted
## Which transports will take which passengers, and where a hold can be put
## ashore.
##
## Client-side and advisory, like MovementPreview and CombatForecast: this
## exists to decide what to *offer* - whether to light up a transport as a
## destination, which beach tiles to highlight - and the server re-checks
## every one of these rules before anything happens (see doLoad/doUnload in
## server/src/game/engine.ts). Where the two disagree, this one is the bug.


## Can `passenger` board `transport` right now?
##
## Mirrors the server's refusals in order: same owner, a real bay, room in
## it, the right kind of cargo, and alongside. Adjacency is the one that
## looks arbitrary and is not - a loaded tile is occupied like any other, so
## the passenger cannot simply *move* onto the transport; boarding is what
## crosses that last tile.
static func can_load(state: MatchState, passenger: Dictionary, transport: Dictionary) -> bool:
	if passenger.is_empty() or transport.is_empty():
		return false
	if String(passenger.get("id", "")) == String(transport.get("id", "")):
		return false
	if int(passenger.get("ownerSlot", -1)) != int(transport.get("ownerSlot", -2)):
		return false
	if MatchState.is_carried(passenger) or MatchState.is_carried(transport):
		return false
	if bool(passenger.get("hasActed", false)):
		return false

	var bay: Dictionary = GameData.unit_stats(String(transport.get("unitType", "")))
	var capacity := int(bay.get("carry_capacity", 0))
	if capacity <= 0:
		return false
	if transport.get("cargo", []).size() >= capacity:
		return false

	var rider: Dictionary = GameData.unit_stats(String(passenger.get("unitType", "")))
	var carried_types: Array = bay.get("carry_move_types", [])
	if not carried_types.has(String(rider.get("move_type", ""))):
		return false

	return _manhattan(passenger, transport) <= 1


## The tiles a transport could put a given passenger down on: adjacent, in
## bounds, empty, and terrain that passenger can actually stand on.
static func unload_tiles(
	state: MatchState, transport: Dictionary, passenger: Dictionary
) -> Array[Vector2i]:
	var out: Array[Vector2i] = []
	if transport.is_empty() or passenger.is_empty():
		return out

	var move_type := String(GameData.unit_stats(
		String(passenger.get("unitType", ""))).get("move_type", ""))
	var origin := Vector2i(int(transport.get("x", 0)), int(transport.get("y", 0)))

	for step in [Vector2i(0, -1), Vector2i(1, 0), Vector2i(0, 1), Vector2i(-1, 0)]:
		var tile: Vector2i = origin + step
		if not state.in_bounds(tile.x, tile.y):
			continue
		if not state.unit_at(tile.x, tile.y).is_empty():
			continue
		if GameData.move_cost(state.terrain_at(tile.x, tile.y), move_type) < 0:
			continue
		out.append(tile)
	return out


static func _manhattan(a: Dictionary, b: Dictionary) -> int:
	return absi(int(a.get("x", 0)) - int(b.get("x", 0))) \
		+ absi(int(a.get("y", 0)) - int(b.get("y", 0)))
