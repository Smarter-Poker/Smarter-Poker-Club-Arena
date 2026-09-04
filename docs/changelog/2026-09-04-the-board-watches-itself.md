# The board watches itself, and two red checks get fixed

**2026-09-04.** Two of the six required checks had been failing on this branch
since `c18c8f576`, before this session picked it up, and the handoff did not
mention it. RULE 7 of the agent playbook: fix your own build.

## `check-horses-are-players` — registered, with the reason written out

The guard flagged `bodiesOnHostFrom` in `StableHandController.ts`:
`if (!isHorse(s.user_id)) continue;`.

It is the law's first sanctioned exemption — the plumbing that seats and steers
the fleet, alongside `fn_seed_horses_to_floor` — and it is now in the register
saying exactly why:

- the fleet does not seat humans, so a human in the count is a number the cap
  could never act on;
- the one place the count is read, `hostAllowsNewBody`, is bypassed **outright**
  when a human at that table needs the game rescued;
- and no horse is worse off. The cap limits how many horses the fleet CHOOSES
  to seat against Dan's curve. It never removes a seated horse, never refuses a
  horse already on the host a second table, and never touches a table a human
  is playing at.

## The Silent Revert Guard — a forward fix, not a label

The guard found `c18c8f576` undoing `95d05fbec` in two files. **That revert was
correct.** It removed a change that turned an unreadable bankroll into a
REFUSAL — the branch that kept the cash floor up for forty minutes on
2026-08-31, and two existing guards refused it at the time. Re-applying it to
turn a check green would re-arm the outage.

So this took the forward fix the guard itself recommends, which needs no label:
**the evidence comes back, the refusal does not.**

`clubsWithRolls` records which clubs the bankroll map actually holds rows for,
and the fail-open branch uses it to split one counter into two:

- `seat_fail_open_roll_unknown` — the map has no rows for that club. The
  ordinary case: 261 of 584 horses are not members of the club that owns the
  open cash tables, and the map will never have an opinion about them.
- `seat_fail_open_roll_faulty` — the map DOES cover the club and the individual
  row still would not read. A data fault. Measured 0 today, so any non-zero
  reading is worth looking at.

**Both branches still `return true`.** `maySeatWithUnknownRoll` exists and is
deliberately not consulted.

One pin moved and got stricter for it. The old one matched the literal
`rollUnknown++; bankrollEvent('seat_fail_open_roll_unknown'); return true;`,
which the split broke. What the pin was FOR is now asserted directly: whichever
counter fires, the next statement is `return true`, the branch contains no
`return false`, and it names neither refusal helper. A second pin holds
`clubsWithRolls` to exactly three mentions, so it cannot quietly gain a fourth
reader that decides something.

**`HorseBankrollTelemetry.ts` is clear of the guard now. `HorseFleetManager.ts`
is not, and cannot be** — the detector's survival test reverse-applies
`95d05fbec`'s whole diff, which includes the refusal lines that must stay gone.
That one needs the `revert-approved` label. See the note at the end.

## The Free Buy board audits itself, hourly, forever

Creating the events is not the same as their being right. Five triggers rewrite
a tournament row on the way in and one exists to force every 0-buy-in MTT's
rebuy and add-on to 1.00; the tier-aware migration says it must not touch a
scheduled Free Buy, and only a live row can show whether that is still true
after somebody edits a trigger next month.

`auditFreeBuyRow` and `auditFreeBuyBoard` are pure and are read by **both** the
one-shot `npm run freebuy:verify` and the engine's standing watch, so a manual
check and the automatic one cannot drift into two opinions about what a correct
Free Buy looks like. They check the tier prices, the add-on chips and window,
`addon_from_start`, rebuys closing with late registration, `max_rebuys` still
NULL, the `union_id` the overlay bank is chosen by, one event per host per slot
per Chicago day, and a slot that came and went with nothing published.

**Where the watch lives, and why not anywhere else.** A Claude scheduled task
belongs to one account and dies silently when Dan is on another —
`smarter-poker-cron-health` read `enabled: true` for two and a half months after
it last fired. A GitHub `schedule:` is barred for application logic. The engine
already runs this cycle every five minutes, already holds the database
connection and already has the alert path, so the watch costs one indexed read
an hour and outlives every session.

It alerts **on change**, and it does not cry wolf: a board read at 10:00 has not
had a chance to publish the 20:00 event, so only slots whose hour has actually
come round are expected to exist.

## Verified

Server typecheck clean, 5,340 tests across 370 files. Client typecheck clean,
12,792 tests. `npm run build` passes and reports `behind-main=0` after merging
`origin/main` (merged, never rebased — section 12). Both guards run clean
locally: `check-horses-are-players: OK - 11 registered exclusion(s)`.
