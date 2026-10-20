# Manual Time Bank In A Lightning Room

Before: `handlers/timebank.ts` resolves only the physical table engine;
`LightningSeatProxy` and `LightningHandHost` expose no manual activation.
The normal browser sends only its displayed pool ID, so a Lightning manual
request cannot reach the active hand's existing bank.

The necessary correction routes the authenticated pool through its current
own host, names the exact hand and decision, and uses the existing
TimeBankEngine arm/activation/expiry and durable ledger owners. A pending
request cannot buy time in a later decision. An early press only arms;
exhaustion grants the bank's existing countdown and cancels the obsolete
primary deadline. Ordinary table routing and automatic-turn behavior remain
with their existing owners. No entitlement purchase, actor operation, timer,
poll, sweep or new funding/charging path is introduced.

Real-time law: triggered by the existing TimeBankEngine discrete WS events,
no snapshot diff. Local regression, compiler, normal hooks, protected checks,
merge and actual containing release remain separate verification stages.

## Change 1 — Route the authenticated current decision

Files before: `server/src/handlers/timebank.ts:54` called physical-only
`getTableEngine`; `GameServer.ts:12287` already exposed the established room
resolver for actions. `LightningSeatProxy.ts:40` and
`LightningHandHost.ts:1367` had no manual Time Bank door.
The handler now chooses the dedicated physical-or-current-room resolver. The
proxy requires the authenticated caller's own room. The host checks exact
hand/action-context/current turn before and after asynchronous cached Lifetime
revalidation, then uses original `arm` or atomic `tryActivate`. The latter
starts its existing bank countdown and cancels the obsolete primary deadline.
Finite paid seconds, shared bank seeding and fold/finish debit remain with the
original ledger owner; no finite rebase or purchase is introduced. An active
bank wins over a concurrent manual request. Unknown Lifetime eligibility does
not refill a finite bank. Verified by rereading actual changed files.

## Change 2 — Bind both browser requests and replies

Before, `GameServerAPI.ts:722` sent only the room ID and both TablePage paths
(22804/22858) could apply a reply to a different decision. The optional API
argument now forwards the exact server hand/context only for Lightning.
`lightningTimeBankRequest` copies the captured identity, refuses missing
Lightning context, and fences replies by mounted pool/player/hand/context.
Both actual request sites use it. Ordinary request JSON remains `{tableId}`.
The existing ordinary optimistic timeout presentation remains; Lightning
uses the authoritative activation event. Verified by rereading the API,
helper, both request sites and their existing presentation consumers.

## Change 3 — Preserve actual allocation in the named event

The existing Host event narrowing at 1386 omitted `secondsGranted` and
`unlimitedActivations`, causing a partial allocation to use the browser's
20-second fallback. The same named frame now carries those original engine
fields. A real host regression requires all four recipient room events to
carry a seven-second grant exactly. No event, timer or automatic grant owner
was added.

## Verification status

The original real HTTP/host/proxy regression failed seven times before the
source correction (404 and absent proxy method), retained externally.
After: 12 real server tests and 46 client/API/presentation/event tests pass.
Both TypeScript compilers pass on the clean transplant onto protected main.
Normal delivery checks remain pending. The existing seat-feedback source test now locates the same
automatic callback with its new context argument; all refusal and no-client-fold
assertions remain intact. No production actor, money or entitlement action was
performed. Protected merge, installation/publication and affected live proof
remain required and are not claimed by these results.

The first normal pre-push also caught the expired-turn contract's old two-argument
call locator. Its same no-client-fold/refusal/engine-authority assertions are
preserved, the locator now names the decision argument, and a new assertion
requires the stale-response fence. All five contract tests pass. The original
failed hook result is retained; it is not passing delivery evidence.
