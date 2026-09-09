# Game Design — Redline Commander

All names and numbers below are original. The authoritative copies of every
table on this page live in `shared/data/` — this document explains them, it
does not define them. When you rebalance, edit the JSON.

## Factions (v1)

Defined in `shared/data/factions.json`.

| Faction | Passive | Field Directive |
|---|---|---|
| Crimson Alliance | Balanced — no bonus or penalty (default/tutorial faction) | **Overdrive** — +20% attack for one turn |
| Azure Federation | Naval and indirect-fire units cost 20% less | **Barrage** — indirect range +1 for one turn |
| Verdant Union | Ground units get +10% defense in forest and mountains | **Fortify** — +20% defense for one turn |
| Solaris Directorate | Vision range +1 for all units | **Uplink** — reveal the map for one turn |
| Umbra Syndicate | Campaign antagonist — units cost 10% more, hit 10% harder | **Blackout** — enemy vision −1 for one turn |

Directives charge by dealing and taking damage and fire once the meter is
full. *The passives are implemented; the directives are data-only so far —
see `docs/ROADMAP.md`.*

## Unit roster (v1 — generic military archetypes)

Defined in `shared/data/units.json`.

| Unit | Role | Cost | Move | Type | Vision | Fuel | Ammo | Fire | Range |
|---|---|---|---|---|---|---|---|---|---|
| Infantry | Cheap capture unit | 100 | 3 | foot | 2 | 99 | ∞ | direct | 1 |
| Anti-Tank Infantry | Anti-armour foot unit | 300 | 2 | foot | 2 | 70 | 3 | direct | 1 |
| Recon | Fast scout | 400 | 8 | wheels | 5 | 80 | ∞ | direct | 1 |
| Artillery | Indirect fire | 600 | 5 | treads | 1 | 50 | 9 | indirect | 2–3 |
| Light Tank | Main line unit | 700 | 6 | treads | 2 | 70 | 9 | direct | 1 |
| Heavy Tank | Late-game brawler | 1600 | 5 | treads | 1 | 50 | 6 | direct | 1 |
| Anti-Air | Counters aircraft | 800 | 6 | treads | 2 | 60 | 9 | direct | 1 |
| Helicopter | Fast air unit | 900 | 6 | air | 3 | 99 | 6 | direct | 1 |
| Fighter Jet | Air superiority only | 2000 | 9 | air | 2 | 99 | 9 | direct | 1 |
| Transport Ship | Carries land units over water | 500 | 6 | sea | 1 | 99 | — | unarmed | — |

Only Infantry and Anti-Tank Infantry can capture. Air and sea units burn fuel
every turn (5 and 1) and are lost at zero unless they end a turn on a
friendly airport/port, which also repairs and resupplies them.

Matchups come from `shared/data/damage_matrix.json` (attacker → defender, as
a percent). The shape of it: infantry are nearly useless against armour,
anti-tank infantry punch far above their cost against tanks but fold to
anything else, anti-air shreds aircraft and little else, and fighter jets
**cannot engage ground targets at all**.

## Terrain

Defined in `shared/data/terrain.json`: Plains, Road, Forest, Mountain, River,
Shallow Water, Deep Water, Reef, City, Factory, Airport, Port, HQ.

Each has a movement cost per move type (`foot`, `wheels`, `treads`, `air`,
`sea`; `null` = impassable) and a defense percentage. Cities, factories,
airports, ports and HQs are capturable, produce 1000 funds per turn for their
owner, and repair the unit classes they service. Factories build ground
units, airports air units, ports sea units.

## Combat

The exact formula, implemented once in `server/src/game/combat.ts`:

```
base       = damage_matrix[attackerType][defenderType]          (percent)
raw        = base × (1 + faction attack bonus) × (attackerHP / 100)
terrainDef = terrain.defense + faction terrain bonus            (percent)
mitigation = 1 − (terrainDef / 100) × (defenderHP / 100)
luck       = integer 0–9, from the match's seeded RNG           (server only)
damage     = floor((raw + luck) × mitigation)
```

Terrain defense scales with the defender's remaining HP, so a nearly-dead
unit gets little benefit from cover. Luck is added before mitigation, so
cover dampens lucky rolls too.

Because luck is rolled server-side, the client's pre-attack forecast shows a
*range* rather than a single number — it cannot know the roll, and a
confident figure the server then contradicts is worse than an honest bracket.

HP is stored 0–100 and shown to the player as ten pips (`ceil(hp / 10)`,
never 0 for a living unit). A defender that survives a **direct** attack
counters using the same formula with roles swapped, its post-damage HP, and
no luck roll. Indirect-fire units neither counter nor are countered, and may
not move and fire in the same turn.

## Capturing

A capturing unit adds its *displayed* HP (1–10) to the tile's progress each
turn; at 20 the tile flips. So a healthy infantry takes two turns and a
damaged one takes longer. Moving off the tile resets progress to zero.

## Win conditions

Capture the enemy HQ, or leave them with no units **and** no production
building. (Having no units is survivable if you still own a factory — you can
build your way back.)

## Maps

`shared/data/maps/*.json`, as ASCII grids with a legend, a per-tile ownership
grid and starting units. `crossing` ships as a 15×10 symmetric two-player
land map: each side starts with an HQ, two cities, a factory, an airport, two
infantry and a light tank. A river splits the map with three crossings — the
north edge, a central road bridge, and the south edge — and four neutral
cities sit in the midfield to be contested.

## Campaign (v1 scope)

Linear, 6–8 missions, one new unit or mechanic each, Crimson Alliance vs.
Umbra Syndicate. Briefing text written fresh — no reused dialogue or story
beats from reference games.

## Multiplayer

1v1 online, asynchronous — no time limit in v1. Friends join by sharing a
match code. 2v2 is not implemented; the state model uses player slots rather
than a hardcoded pair, so adding teams is additive rather than a rewrite.
