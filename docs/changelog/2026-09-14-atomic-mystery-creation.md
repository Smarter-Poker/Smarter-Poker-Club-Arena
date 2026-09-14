# Mystery choices commit with tournament creation

The manual creator previously published an event and applied its mystery settings in a second request. Refusal only logged a warning; the event ran on defaults. Its shared request builder also omitted selected profile, activation and pool/top percentages, so saved schedules lost these choices. Scheduled and both recurring engine constructors omitted the six canonical columns, and the repeat copier omitted them too.

The shared engine domain decoder now validates the selected choices and supplies the same explicit defaults to all creation paths. Manual creation includes the choices in `fn_create_tournament`; the existing authenticated transaction validates them before delegated creation, persists them and reads the exact row after all triggers before returning `mystery_config`. Any failed, skipped or changed write rolls back creation. The client validates that receipt and performs no second settings request. If an older or inconsistent response lacks the receipt, the message explicitly says the event was created and asks the operator to refresh before creating another.

Scheduled, recurring and union constructors include the canonical columns in their initial insert. Repeat creation retains the original published values. Existing public tournament reads include the same metadata. Profiles remain balanced/classic/jackpot; activation remains at the money, percentage of entrants, or an integer player count. Pool percentages must be actual numbers between 0 and 100 with at most two decimal places, and the regular complement totals exactly 100. Default choices remain classic, at the money, 50/50 and 20% top bounty. Bounty funding, entry costs, inventory construction and payout formulas are unchanged.

The new database row guard validates new mystery contracts and changed pending settings. Once activation owns the row, neither selected terms nor the mystery format flag can change. Unchanged historical terms and ordinary runtime progress remain writable; existing registration guards continue to protect entered contracts. The existing setter is retained unchanged, with the common trigger closing its read-before-lock race.

## Files and original lines

- `src/services/TournamentService.ts`: request builder at 1018, old follow-up request at 1287–1320, public metadata projections at 708/835/902/1290.
- `server/src/services/ScheduledTournamentService.ts`: constructor at 1200, repeat-copy whitelist at 1382.
- `server/src/services/TournamentRecurringService.ts`: the two constructors at 3874 and 4110; configuration interfaces at 104/175.
- `server/src/domain/mysteryBountyCreation.ts`: new shared decoder and canonical-column projection.
- `supabase/migrations/20260914102150_mystery_options_commit_with_tournament_creation.sql`: one transaction, five-second lock timeout, declared trigger, source-guarded creator replacement and unchanged authorization grants.
- `server/src/tournament/MysteryCreationOptions.test.ts`, `tests/unit/mysteryCreationPayload.test.ts`, native fixture and runner: actual callers, receipt behavior and database concurrency evidence.

## Verification and limits

The initial actual-caller tests reproduced 23 failures. All **5,614 engine tests across 363 files**, **167 client tests across seven files**, and server TypeScript now pass. The private PostgreSQL 17 run passes **11 groups**, including a real two-session activation race and the captured registered/lifecycle guards. Its owned database directory is removed after the run. The fixture has explicit authentication and delegated-creation stand-ins; it does not certify the full funded ledger or production trigger graph.

An intermediate receipt test incorrectly retained the shared setup mock's call history across cases. It now clears history before each test and still requires exactly one creator call and zero separate settings calls. The product behavior did not change to satisfy that harness correction.

Local full application TypeScript is blocked by missing native mobile dependencies in the shared dependency installation. Required clean CI remains the build gate. Production schema installation must precede publication of the new client receipt contract, outside the prohibited hourly :50–:03 UTC DDL window. No production installation, merge, deployment or complete MTT acceptance is claimed by these local results.
