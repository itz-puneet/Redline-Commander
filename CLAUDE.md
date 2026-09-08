# CLAUDE.md — Project Instructions for Claude Code

This file is read automatically by Claude Code at the start of sessions in this repo.

## Project

**Redline Commander** is an original turn-based tactical strategy game for Android,
built for playing online with friends. It is inspired by the *genre* of grid-based
tactics games (unit types with rock-paper-scissors matchups, terrain-based defense
bonuses, capturing bases, fog of war) — it is NOT a clone, port, or derivative work
of any specific commercial title.

## Hard rule: no copyrighted material from other games

Never introduce, reference, copy, or closely paraphrase, from Advance Wars or any
other existing commercial game:
- Faction/character/Commanding-Officer names, portraits, or dialogue
- Unit sprite art, map tile art, music, or sound effects
- Exact stat tables, map layouts, or mission/campaign text
- Box art, logos, or marketing copy

Generic military terminology (Infantry, Tank, Artillery, Anti-Air, Recon, APC,
etc.) and generic tactics-game mechanics (grid movement, terrain defense bonus,
fog of war, capturing buildings) are fine to use — these aren't anyone's IP.
All names, art, and specific numbers in `shared/data/` and `docs/GAME_DESIGN.md`
are original; extend them in the same spirit rather than pulling from reference
games.

## Tech stack

- **Client:** Godot 4.3+, GDScript, exports to Android (APK/AAB)
- **Server:** Node.js 22+ / TypeScript, plain WebSocket + JSON
- **Multiplayer model:** online, turn-based, authoritative server. The client
  sends **one action at a time**; the server validates it, applies it, and
  sends each player their own fog-filtered view (see `docs/ARCHITECTURE.md`).

## Architectural rules — do not break these

These are the things that are expensive to retrofit. They are enforced by the
layout of the code, so keep them that way.

1. **One source of truth for data.** Unit stats, terrain, damage numbers and
   faction traits live in `shared/data/*.json` and nowhere else. The server
   reads them directly; `client/data/` is a generated copy
   (`tools/sync-shared-data.sh`, checked by `npm run verify:data`). Never
   hardcode a stat in `.ts` or `.gd`, and never edit `client/data/` by hand.

2. **The rules engine is pure.** Everything in `server/src/game/` takes state
   in and returns new state out. No sockets, no filesystem, no `Math.random()`
   (use the seeded RNG in `game/rng.ts`), no mutation of its arguments. This
   is what makes `server/test/engine.test.ts` possible — a rule you cannot
   test without a socket is in the wrong file.

3. **The server never sends a player what they cannot see.** Fog of war is
   enforced by building a *separate payload per player* in `game/view.ts`.
   Do not add a broadcast path that sends full state to everyone; a modified
   client would read straight through the fog.

4. **The client is never authoritative.** `MovementPreview` and any other
   client-side rule code exists only to draw overlays. The server re-validates
   everything. If they disagree, the client is the bug.

5. **A match is a persisted record, not a live connection.** Players drop,
   background the app, and take their turn hours later. Committed turns are
   written through `MatchStore` before being acknowledged, and a seat is keyed
   to a stable `playerId`, never a socket id.

## Current status

Scaffold with a working, tested rules engine and network layer; no rendering or
UI yet. See `docs/ROADMAP.md` for what's implemented vs. what's next.

## Where to start

1. `docs/ARCHITECTURE.md` — layering, message flow, and *why* it is shaped this way.
2. `docs/GAME_DESIGN.md` — factions, units, terrain, combat rules.
3. `docs/PROTOCOL.md` — the exact client/server wire contract.
4. `docs/ROADMAP.md` — pick up the next unchecked item.

## Commands

```bash
cd server
npm install
npm run dev          # ts-node-dev, ws://localhost:2567/play
npm test             # typecheck + rules engine tests
npm run smoke        # end-to-end protocol check (server must be running)
npm run verify:data  # fail if client/data has drifted from shared/data
```
