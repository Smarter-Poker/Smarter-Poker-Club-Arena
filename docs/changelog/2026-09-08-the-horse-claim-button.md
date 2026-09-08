# A horse's claim button

2026-09-08. Migration `20260908152950_the_horse_claim_button.sql`.

This is the root fix for the 759 expiring rewards settled earlier the same day.

## The cause

The horse claim lived inside `record_daily_challenge_event`, in an
`IF ... is_horse THEN` block that ran when an event arrived for that horse:

```
something happens -> enqueue_daily_challenge_event -> outbox
outbox -> fn_drain_daily_challenge_event_outbox (pg_cron, every minute, 4 shards)
       -> record_daily_challenge_event -> the claim loop
```

So the claim was keyed to a horse **doing** something. A horse that stops playing
stops claiming, and its earned rewards sit until the seven-day window closes on
them. The 23 horses in the backlog had reported no event since 05:07.

A human who stops playing keeps a claim button for the whole seven days. Same
reward, same window, different outcome — decided entirely by the fact that a
horse has no browser. That is what CLAUDE.md 10.5 forbids, and the comment
already in that block said so: it had been written to give a horse the whole
still-claimable set rather than only what one transaction completed. It fixed the
**width** of the claim and left its **trigger** attached to activity.

## A correction to my own changelog

The settlement's header said this fix was engine-side TypeScript in HorseLogic.
**It was not.** The claim already ran server-side on a minute cadence; nothing
needed building in the engine. What was wrong was which question the cadence
asked — "who just acted" rather than "who is owed". Everything needed was already
here, one layer away from where I was looking.

## What changed

`fn_ca_horse_claim_due(limit)` finds horses owed a completed, unclaimed,
in-window reward, oldest first, and claims each through
`claim_daily_challenge_serialized_body` — the same body a human's click reaches.
Scheduled `ca-horse-claim-due-minute`, matching the outbox drain's cadence.
Advisory-locked so overlapping ticks do not fight, silent on the per-user daily
cap (a thousand horses meet it daily; filing that would be an always-on alarm),
and filing an incident on anything else.

**Why this is not a band-aid**, since it is a scheduled job that pays people and
10.12 refuses exactly that shape: it repairs nothing and compensates for nothing.
It **is** the button. A human presses one; a horse has no browser, so the engine
presses it — the same legitimate horse branch as HorseLogic choosing actions,
`scheduleHorseAction` submitting them inside the same turn timer, and the
synthetic heartbeat keeping the seat alive. A repair job would be one that
noticed the claim had _failed_ and re-ran it.

**The duplication ends in the same edit.** The loop existed in two copies with a
normaliser pinning them character-for-character, because merging them the same
afternoon 759 rewards came back through that path was too risky. Moving the claim
out of the event path removes both. There is now one claim, in one place.

**The health row was wrong and is fixed.** It reported "19 earned reward(s) are
unclaimed and will expire" and blamed the horse mechanism. All 19 belong to two
**humans**. A human with an unclaimed reward has a button and has not pressed it
— not a defect, and it must not be amber. Counting the two together and
attributing both to a cause I had checked for only one of them is the same error
this whole day has been about. `horse claims` now separates them, and
`horse claim button` watches the cron so a dead sweep is visible.

## Four things the edit got wrong before it was right

Each is worth recording, because each was a _difference between the two copies_
that only an assertion on the finished text found:

1. The anchor regex matched only one copy — the 6-argument function wraps its
   loop in an extra `BEGIN/END`, so it closes `END LOOP; END; END IF;` while the
   body closes `END LOOP; END IF;`.
2. `[\s\S]*?` is a Perl idiom; in a Postgres regular expression `.` already spans
   newlines, and the Perl form matched nothing.
3. One copy also declared `v_claim record;` and the other did not. An orphaned
   declaration compiles perfectly and would have left the next reader thinking
   the claim was still there.
4. The assertion counting event functions expected two. There are **three** —
   `record_daily_challenge_event` has a 5-argument and a 6-argument overload, and
   only the 6-argument one ever carried the claim.

And a fifth, of a kind this programme has now hit three times: the assertion
searching for `FOR v_claim IN` matched `fn_ca_normalise_claim_loop`, which
carries that string as the needle it searches _for_. A guard matching its own
text.

## Verified live

A rolled-back probe (CLAUDE.md 11.5) created one owed reward for a horse and one
for a human, ran the sweep, and checked both:

```
PROBE OK - horse claimed=t, human claimed=f, sweep paid 1, 42 diamonds moved. Rolled back.
```

And the health report, thirteen areas:

```
rule arming           ok    ca-diamond-rule-flip-daily scheduled and active
rules overdue         ok    No rule past its arming date and still stuck
money identity        ok    players + float = register, exactly
deploy gate           ok    The snapshot explains every movement it can see
trial balance         ok    Every reconciling account balances
per-user caps         ok    No user-day in fourteen days exceeds its cap
VIP caps              ok    No cap gives a VIP less than a standard player
horse claims          ok    No horse owed a reward it cannot claim; 19 human, not a defect
horse claim button    ok    ca-horse-claim-due-minute scheduled and active
horses are players    ok    No horse classified as test equipment
budget plans          attention  3 lines are fiction (Dan's to set, ruling 21)
unreachable money     ok    Nothing stranded
evaluation coverage   attention  5,861 in 24h, none for 02:56; cause appears fixed
```

All three `record_daily_challenge_event*` overloads intact, none of them
claiming.
