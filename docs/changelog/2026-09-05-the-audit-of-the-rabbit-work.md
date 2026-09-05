# The audit of the Rabbit Hunt work, and the four things it found

2026-09-05. Branch `fix/rabbit-audit-followups`. An adversarial audit of the two
commits merged earlier today (`4d0403042` the rabbit window, `54bdd042f` the
mobile retime). Four real defects, two of them mine. Every pin below was run
against the pre-fix code first and failed.

## 1. HIGH: the new setting never reached a second device

`src/services/PostgresSyncHooks.ts` holds `USER_TABLE_SETTING_COLUMNS`, a
hardcoded relay allowlist, and its own comment states the rule: "the
subscription below only relays columns named in this array". `rabbit_hunt_button`
was not in it, so a player who turned the button off on their phone still saw it
on their laptop until the next full page load. That is a direct miss against Dan
2026-08-28, quoted in the hook's own header: "THEY NEED TO SAVE GLOBALLY IN REAL
TIME ON ALL TABLES, AND ALL PAGES."

Adding the one key would have fixed today and left the trap armed for the next
agent, so the pin asserts the WHOLE set: every key of
`DEFAULT_USER_TABLE_SETTINGS` must appear in the allowlist. It cannot drift
again without going red.

## 2. MEDIUM: raising the all-in gap widened Dan's own equity-spoiler bug

This one is mine, and it is the interesting one.

`ALL_IN_STREET_REVEAL_MS` exists to stop a spoiler. Dan 2026-08-28: "EQUITY
CHANGES ONLY AFTER THE FLOP IS DISPLAYED, (NOT BEFORE OR DURING)." The engine
opens its equity gate exactly that long after sending the street, and the card
profile is sized so the face is up when the gate opens.

The client's reveal is scaled by `--animation-speed`. **The server's gate is
not, and cannot be: the engine does not know any client's animation speed.** So
on Animation Speed = Slow (1.5x, a one-click preference) the card was still face
down when the winning percentages moved:

| speed | face up at | gate opens at | spoiler |
| ----- | ---------- | ------------- | ------- |
| 1.0   | 1563ms     | 1750ms        | none    |
| 1.5   | 2344ms     | 1750ms        | 594ms   |
| 3.0   | 4689ms     | 1750ms        | 2939ms  |

At 1250ms the 1.5x spoiler was 344ms; taking the gap to 1750 widened it to
594ms, about 73%. The bug predates today. Raising the number made it worse and
is what surfaced it.

The fix is not new policy. `handCompletionSpec.ts` already states it for the
run-it-twice timeline - "THE SERVER CANNOT KNOW A CLIENT'S SPEED, so the engine
holds for speed 1 and the client CLAMPS its reveal to speed <= 1 for this
timeline only" - and `TablePage.tsx` already does it twice with
`Math.min(1, getAnimationSpeed())`. The all-in card profile now carries
`serverPaced: true`, and a server-paced reveal clamps to speed <= 1.

Faster still works: a player who asked for 0.5x gets 0.5x. Only "slower than the
stopwatch the server is holding" is refused, and the animation still plays in
full, so 10.6 is untouched.

**Both sides are clamped.** The CSS multiplies the same `--animation-speed`, so
clamping only the JS window would have torn the markup out at 1750ms while the
card was still turning at 2344ms. `squeezeVars` now emits
`--animation-speed: min(1, var(--animation-speed, 1))` for a server-paced
profile. One clamp on each side, or neither is a clamp.

## 3. MEDIUM: the client/DB default guard was not extended

`tests/user-table-settings-defaults.test.ts` says in its header "Every boolean
is pinned below", but it iterates a hand-written `DB_COLUMN_DEFAULTS` map, so
omitting a key passes silently rather than failing. No live mismatch - the
column is `NOT NULL DEFAULT true` in production and the client default is `true`

- but the guard against the per-key-upsert trap that file exists to document was
  absent for this column. Added.

## 4. LOW: reduced motion crushed the cross-fade it was supposed to run

The mobile commit replaced `animation: none` with a cross-fade so the reveal
still fires `animationend`. It does. But `src/styles/reducedMotion.css` sets
`animation-duration: 1ms !important` on everything that is not
`[data-motion='keep']`, at a higher specificity, so the fade finished instantly
while the engine held the markup mounted for the reduced profile's full 150ms.
The commit message claimed it ran "on the same `--rs-flip` clock". It did not.

`data-motion="keep"` is the exemption that stylesheet publishes and the one
CLAUDE.md 10.6 names for exactly this case: "reduced-motion collapses motion but
never meaning (`data-motion="keep"` for duration-carrying animation)". This
animation carries duration by definition, because the engine is counting it. The
motion is still collapsed - it cross-fades, it does not turn.

## Also corrected

- `ServerTableEngineRunout.ts` still said "where the 1250ms comes from". It is 1750.
- `TableSettingsPanel.tsx` said "Renders all 12 table settings toggles" while
  the list held 14. It no longer claims a number; the hook owns the list.

## Measured, for the record

The audit quantified what the 1750ms rest costs, which the original commit did
not. Over 16,359 hand gaps across 607 live tables in a 45-minute window, the
median inter-hand gap was 21,325ms and the mean 29,480ms. An unconditional
+1750ms is therefore about **-7.6% hands/hour** on the median and -5.6% on the
mean. Dan asked for the pause knowing it is a pace change; this is the size of
it, written down where the next person can find it.

## Not changed, deliberately

The engine deploys on the hourly `:55` maintenance break, not on merge (Dan
2026-08-31, "THE ENGINE RESTARTS AT 7AM AND 7PM. NOT WHEN CODE MERGES", revised
to hourly 2026-09-01). So a merged engine change WAITS for a window by design.
That is not a defect and was not touched.

## Verification

`tsc --noEmit` clean on app and engine. Full vitest suite green. `vite build`
clean. Five new pins in `tests/unit/rabbitAuditFollowups.test.ts`, all five run
against the pre-fix tree first and all five failed.
