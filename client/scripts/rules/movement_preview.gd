class_name MovementPreview
extends RefCounted
## Client-side movement and attack range preview.
##
## IMPORTANT: this is a UI affordance only. It exists so the player can see a
## blue overlay before committing, and it is NOT authoritative - the server
## re-walks every path in server/src/game/movement.ts and will reject
## anything that does not add up. If the two ever disagree, the server is
## right and this is the bug.
##
## It is a deliberate duplicate of the server's algorithm, which is safe only
## because both sides read the same numbers out of the same data files. Keep
## the algorithm in step; never hardcode a cost here.
##
## Note the split between `cost_field` and `reachable_tiles`: what a unit can
## reach and what it can stop on are different sets, because a friendly unit
## can be passed through but not stood on. Collapsing them leaves holes in
## the cost field that a route cannot be traced back through.

const NEIGHBOURS: Array[Vector2i] = [
	Vector2i(0, -1), Vector2i(1, 0), Vector2i(0, 1), Vector2i(-1, 0),
]


## Tiles the unit may end its move on: tile position -> cost to reach.
## This is the overlay. It is a subset of the cost field below, because a
## friendly unit can be passed through but not stopped on.
static func reachable_tiles(state: MatchState, unit: Dictionary) -> Dictionary:
	var unit_id := String(unit.get("id", ""))
	var field := cost_field(state, unit)
	var stoppable: Dictionary = {}
	for tile in field:
		var occupant := state.unit_at(tile.x, tile.y)
		if occupant.is_empty() or String(occupant.get("id", "")) == unit_id:
			stoppable[tile] = field[tile]
	return stoppable


## Dijkstra over terrain move costs, including tiles that can only be passed
## through. Returns tile position -> cost to reach.
static func cost_field(state: MatchState, unit: Dictionary) -> Dictionary:
	var stats := GameData.unit_stats(String(unit.get("unitType", "")))
	if stats.is_empty():
		return {}

	var move_type := String(stats.get("move_type", "foot"))
	var fuel: Variant = unit.get("fuel")
	var budget := int(stats.get("move", 0))
	if fuel != null:
		budget = mini(budget, int(fuel))

	var origin := Vector2i(int(unit.get("x", 0)), int(unit.get("y", 0)))
	var owner_slot := int(unit.get("ownerSlot", 0))
	var unit_id := String(unit.get("id", ""))

	var best: Dictionary = {origin: 0}
	var frontier: Array[Vector2i] = [origin]
	var result: Dictionary = {}

	while not frontier.is_empty():
		# Small maps: a linear scan for the cheapest node is cheaper than
		# maintaining a heap, and keeps this readable.
		var cheapest := 0
		for i in range(1, frontier.size()):
			if int(best[frontier[i]]) < int(best[frontier[cheapest]]):
				cheapest = i
		var current: Vector2i = frontier[cheapest]
		frontier.remove_at(cheapest)
		var current_cost := int(best[current])

		# Every tile the unit can reach, whether or not it may stop there -
		# reconstructing a path needs the cost of the tiles it passes over.
		result[current] = current_cost

		for step in NEIGHBOURS:
			var next := current + step
			if not state.in_bounds(next.x, next.y):
				continue

			var blocker := state.unit_at(next.x, next.y)
			# Known enemies block; unknown tiles are optimistically passable,
			# and the server corrects an ambush by rejecting the move.
			if not blocker.is_empty() and int(blocker.get("ownerSlot", 0)) != owner_slot:
				continue

			var cost := GameData.move_cost(state.terrain_at(next.x, next.y), move_type)
			if cost < 0:
				continue

			var total := current_cost + cost
			if total > budget:
				continue
			if best.has(next) and total >= int(best[next]):
				continue

			best[next] = total
			frontier.append(next)

	return result


## Builds the cheapest path to `destination` by walking the cost field back
## downhill. Returns [] if unreachable. The result is what gets sent as the
## `path` of a move action.
static func path_to(state: MatchState, unit: Dictionary, destination: Vector2i) -> Array[Vector2i]:
	# The full field, not just the stoppable tiles: a route may pass straight
	# through a friendly unit, and walking back through a hole in the costs
	# would fail to find any route at all.
	var costs := cost_field(state, unit)
	if not costs.has(destination):
		return []

	var stats := GameData.unit_stats(String(unit.get("unitType", "")))
	var move_type := String(stats.get("move_type", "foot"))
	var origin := Vector2i(int(unit.get("x", 0)), int(unit.get("y", 0)))

	var path: Array[Vector2i] = []
	var current := destination
	var guard := 0

	while current != origin:
		path.push_front(current)
		guard += 1
		if guard > costs.size() + 1:
			push_error("MovementPreview: path reconstruction failed")
			return []

		var step_cost := GameData.move_cost(state.terrain_at(current.x, current.y), move_type)
		var previous := current
		for step in NEIGHBOURS:
			var candidate := current + step
			if costs.has(candidate) and int(costs[candidate]) == int(costs[current]) - step_cost:
				previous = candidate
				break
		if previous == current:
			push_error("MovementPreview: no downhill neighbour from %s" % current)
			return []
		current = previous

	return path


## Tiles this unit could attack from where it currently stands. Indirect-fire
## units are shown nothing if they have already moved, matching the rule the
## server enforces.
static func attackable_tiles(state: MatchState, unit: Dictionary) -> Array[Vector2i]:
	var stats := GameData.unit_stats(String(unit.get("unitType", "")))
	if stats.is_empty() or stats.get("fire_mode") == null:
		return []
	if String(stats.get("fire_mode", "")) == "indirect" and bool(unit.get("hasMoved", false)):
		return []

	# An empty magazine is checked server-side too; without this the overlay
	# offers targets that CombatForecast then contradicts.
	var ammo: Variant = unit.get("ammo")
	if stats.get("max_ammo") != null and ammo != null and int(ammo) <= 0:
		return []

	var min_range := int(stats.get("min_range", 1))
	var max_range := int(stats.get("max_range", 1))
	var origin := Vector2i(int(unit.get("x", 0)), int(unit.get("y", 0)))
	var attacker_type := String(unit.get("unitType", ""))
	var owner_slot := int(unit.get("ownerSlot", 0))

	var tiles: Array[Vector2i] = []
	for dy in range(-max_range, max_range + 1):
		for dx in range(-max_range, max_range + 1):
			var distance := absi(dx) + absi(dy)
			if distance < min_range or distance > max_range:
				continue

			var target_pos := origin + Vector2i(dx, dy)
			if not state.in_bounds(target_pos.x, target_pos.y):
				continue

			var target := state.unit_at(target_pos.x, target_pos.y)
			if target.is_empty() or int(target.get("ownerSlot", 0)) == owner_slot:
				continue
			if GameData.base_damage(attacker_type, String(target.get("unitType", ""))) <= 0:
				continue

			tiles.append(target_pos)

	return tiles
