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

## Sound is one switch (Dan, binding)

Dan, verbatim: **"a simple switch, sounds on / off is all thats needed."**

That settles the item this sweep had left open, and the answer is DELETE, not
document. `SoundService.restoreStoredConfig` hydrated five per-category gates
and an effects volume from `sp_sound_settings` — a key whose only writer,
`SoundSettings.tsx`, was deleted in #1316 ("delete the unreachable settings
UI") THE DAY BEFORE that read was added. It could only ever return null.

Removed: the hydrate and its constructor call, the `categoryEnabled` map, the
category gate inside `shouldPlay`, the stray `categoryEnabled['win']` check on
the pot sweep, and the two setters (`setCategoryEnabled`, `setCategoryStates`)
that had zero callers. Five gates that can only ever be `true` are five ways
for a later change to silence something by accident, for a feature nobody
asked for. It also removes a boot-time localStorage read and the last caller
of `setEffectsVolume`, so the effects gain simply IS its default of 1.0 — the
exact value the dead hydrate always left it at, so nothing a player hears
changes.

`SoundCategory` itself stays: 50 call sites pass it and it still names what a
cue is. What remains is the whole feature — one master switch owned by
`soundGate` (`club_arena_sounds` + `ca_sound_enabled`, either one off silences
everything), consulted by `shouldPlay` on every call, plus the master volume
slider. Earlier today that switch was also made to actually work from
/settings (#1622); before that it saved and lied.

## Pinned by

`tests/unit/theAppDoesNotLieToPlayers.test.ts` (7) — the FAQ claim against the
MFA implementation that backs it, the absent member count, the settlement
feedback branch (and that the real success path survives), the deleted module,
and — replacing the assertions that guarded the old "kept, pending a UI decision" stance — that the dead read, the gates and the zero-caller setters are gone while the one master switch still gates every cue on both keys.
