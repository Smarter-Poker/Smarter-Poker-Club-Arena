# 2026-08-28 — The app does not tell players things that are not true

Same sweep that found the mocked reroll. Four items, all of them the app
stating something false or carrying something that could never work.

## The Help FAQ said 2FA was "Coming Soon". It shipped.

`SettingsPage` implements enrol / challenge / verify / unenrol against
Supabase MFA, with a QR modal, two taps from where the FAQ said the feature
did not exist yet. Telling a player a SECURITY feature is unavailable while
it sits in their settings is worse than a stale doc. The answer now says
where it is and what the steps are.

(The orphaned `src/components/security/TwoFactorSetup.tsx` is a duplicate of
that shipped flow with zero render sites. Left in place here — deleting
components is a separate, wider sweep, and it is inert.)

## The lobby's featured card invented a member count

The Shark Club card was injected with a hard-coded `member_count: 580` — a
number nobody measured — and the sort immediately below it ranks by member
count, so the fabricated figure outranked real clubs with real members. The
seed is gone; the per-club stats fetch already resolves the true count for
every id in the list, and until it lands unknown sorts as unknown.

## A money button that could not pay, and did not say so

The settlement screen's "Execute Payouts" calls `executeMondayPayouts`, a
RETIRED NO-OP since 2026-07-21 (it read two tables deliberately removed from
the schema). Its success branch is gated on `agentsPaid > 0 ||
playersWithRakeback > 0`, which can never be true — so the button spun, moved
nothing, and showed NO toast at all: no success, no error, no explanation, on
a money screen. It now says where payouts actually happen (agent commissions
through credit_invoices, player rakeback through the engine's settler
daemon). The success branch is untouched, so a future implementation that
returns real numbers still works.

## A typo-proof constants map that was full of typos

`src/constants/busEvents.ts` declared 49 event names for MasterBus. TWENTY-ONE
of them do not exist in `BusEventType` at all (CLUB_DELETED, WALLET_UPDATED,
LEVEL_UP, XP_EARNED, PRESENCE_CHANGED, ...) — and NOTHING in the repo
imported the file. Anyone following its own usage docstring with one of those
names would have written a subscription that could never fire. Deleted;
`BusEventType` already gives compile-time safety at every real call site.

## Deferred item closed: the sound-category hydrate

`SoundService.restoreStoredConfig` reads `sp_sound_settings`, and its comment
named `SoundSettings.tsx` as the writer. That file was deleted THE DAY BEFORE
this function was written (#1316, "delete the unreachable settings UI"), so
the read was born pointing at a key nothing writes.

KEPT, deliberately, and now documented as what it is: the category GATE is
live and correct (all 50 categorised `shouldPlay` sites consult it), the
shape is the contract any future UI must write, and a hydrate of an unwritten
key costs one boot-time read and cannot misbehave. What is missing is a UI —
today the app offers a master on/off and a master volume in three places, and
nothing for the five categories or the effects volume. Which of those are
worth exposing, and where, is a product decision, not something to invent in
a service.

## Pinned by

`tests/unit/theAppDoesNotLieToPlayers.test.ts` (7) — the FAQ claim against the
MFA implementation that backs it, the absent member count, the settlement
feedback branch (and that the real success path survives), the deleted module,
and the sound contract.
