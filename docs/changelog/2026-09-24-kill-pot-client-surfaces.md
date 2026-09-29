# 2026-09-24 - Kill Pot client surfaces

## What changed

- Cash creation (`src/components/cash/CashGameCreateFlow.tsx`): on a fixed-limit
  game (FLH, FLO8) the Kill Pots control (Off, Half Kill, Full Kill; 8, 10, 12
  or 15 BB) is drawn only while the registry says
  `cash.fixed_limit.kill_pots` is available. A chosen kill is written after the
  game is created through the owner door the database honours,
  `fn_set_cash_game_kill_settings(p_game_id, p_kill_mode, p_kill_threshold_bb)`
  (migration `20260924034010`), which writes the game's
  `ruleset_snapshot.kill` and projects it onto every live table through
  `fn_cash_apply_ruleset`. The earlier draft sent `kill_mode` and
  `kill_threshold_bb` in `fn_cash_game_create`'s `p_overrides`, which that
  function drops without a word. A refused kill is said ("Game Created Without
  Kill Pots: ...") instead of reporting the game as created with it.
- Lobby Advanced Filters: the LIMIT tab's Kill Pot chip, only while the
  capability is available.
- Table, hand detail, replay and export surfaces read the kill the engine and
  `hand_history.kill_pot` publish.
- `src/config/platformCapabilities.ts`, `src/hooks/usePlatformCapability.ts`
  (`'loading' | 'available' | 'unavailable' | 'unknown'`, one shared read with a
  60 s TTL, failed reads never kept, `null` asks nothing) and
  `tests/one-capability-registry.law.test.ts` ship here, byte-identical to the
  multi-day client candidate; the registry PR is database and docs only. This
  tree does not carry the registry migration, so the law compares the mirror to
  `scripts/ci/fixtures/capability-registry/seeds.json`.

## Why

Kill-v1: nothing is advertised or sold before the engine that enforces it is
live, and a setting the owner chooses must reach the tables.

## Evidence

- `tests/unit/killPotCapabilityGate.test.tsx`: the gate on both surfaces, the
  door call (after creation, never in `p_overrides`), a refused kill, and a
  block that reads migration `20260924034010` and holds the client's call to
  the door's parameter list, thresholds and the snapshot key both table writers
  project.
- `tests/unit/killPotClientSurfaces.test.tsx`, `tests/one-capability-registry.law.test.ts`.

## Still pending

Installation of the registry (`20260924025555`) and the kill settings migration
(`20260924034010`), then the capability's move to `deployed` with evidence.
Until then no kill control is drawn.
