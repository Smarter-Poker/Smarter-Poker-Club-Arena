# A Jsonb Containment Is Sent As Json

## What broke

Every engine release since #5213 stopped at the legacy checkpoint before it
started (run 36081290135, 2026-09-25 01:24 UTC):

    reason bank_residue_unproven, failedCheck proveBanksHeldNothing.dealtSinceRead,
    observedDetail error=22P02

The database named it at 01:24:09 UTC: `invalid input syntax for type json`,
on `hand_history.players @> $3`. #5213 asks whether the destination table has
dealt a moved player a hand, with
`.contains('players', [{ userId }])`. postgrest-js writes an ARRAY argument as a
Postgres array literal, `cs.{...}`, so an array of objects reached PostgREST as
`{[object Object]}`: invalid JSON for a jsonb column. Every such read failed, so
every release with a cash seat move in the last hour refused (the fleet moves
cash seats every few minutes).

## The fix

The containment is sent as a JSON string, `JSON.stringify([{ userId }])`, which
postgrest-js passes through verbatim. This is BUG 021's fix
(`HandHistoryService`, 2026-04-16), applied to the three callers it missed:

- `server/scripts/legacy-engine-checkpoint-guard.mjs` (the release blocker);
- `src/components/admin/StatsExport.tsx` (the admin export of your own hands);
- `src/pages/SettingsPage.tsx` (the Settings data export).

## What pins it

- `tests/legacyEngineCheckpointGuard.test.ts`: the `hand_history` fake now
  requires a JSON string; with the old guard 8 cases fail.
- `tests/unit/aJsonbContainmentIsSentAsJson.test.ts`: refuses any
  `.contains('<column>', [{ ... }])` in `src`, `server/src`, `server/scripts`
  and `scripts` (comments excepted), and fails on the old StatsExport line.

`hand_history.players` was read in production to confirm the key is `userId`.
