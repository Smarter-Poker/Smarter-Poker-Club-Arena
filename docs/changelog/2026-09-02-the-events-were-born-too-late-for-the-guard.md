# The events were born too late for the guard to fill them

Date: 2026-09-02
Branch: `fix/guaranteed-restarts-get-their-overlay-window`

## The number

Every guaranteed tournament on this platform has been running an overlay.
Not most of them. Measured against `tournaments` directly:

| Day        | Guaranteed events | With overlay | Overlay (chips) | Avg entries |
| ---------- | ----------------- | ------------ | --------------- | ----------- |
| 2026-09-02 | 49                | 49           | 13,186          | 1.8         |
| 2026-09-01 | 63                | 63           | 9,083           | 4.9         |
| 2026-08-31 | 84                | 84           | 30,262          | 2.1         |
| 2026-08-30 | 99                | 99           | 45,460          | 2.4         |
| 2026-08-29 | 50                | 50           | 22,290          | 2.2         |
| 2026-08-28 | 22                | 22           | 9,795           | 2.1         |
| 2026-08-27 | 95                | 95           | 24,123          | 1.6         |
| 2026-08-26 | 92                | 91           | 24,163          | 1.3         |

554 events in eight days, 553 with an overlay, about 22,300 chips a day.

## What it was not

It was not `HorseOverlayGuard`, which is the obvious suspect and was the first
place I looked. That file is correct: it polls `fn_overlay_at_risk` every two
minutes, tops each short event up through `topUpWithHorses`, respects the
four-table cap, and warns loudly on a cycle that adds nobody.

It was not the guard's scope either. 294 of the 296 overlaying events in the
last three days belong to Midway Union, which is exactly the union the guard
watches.

And `fn_overlay_at_risk` looks three hours ahead, which is far more window than
the guard needs.

## What it was

Asked live, `fn_overlay_at_risk` returned **zero** at-risk events on a day that
had already overlaid 49 of them. The events were not being missed. They did not
exist yet.

```sql
select round(extract(epoch from (start_time - created_at))/60.0,1) as lead_min,
       count(*), round(sum(greatest(0, guaranteed_prize
         - current_players*buy_in_amount)),2) as overlay
from tournaments
where coalesce(guaranteed_prize,0) > 0 and started_at >= current_date - 2
  and status = 'COMPLETED' group by 1 order by 1;
```

| Lead before start           | Events | Overlay |
| --------------------------- | ------ | ------- |
| 0.8 - 1.0 min               | 145    | 22,036  |
| 4.8 - 5.0 min               | 20     | 14,015  |
| ~30 min (the intended lead) | 4      | 1,833   |

**165 of about 195 guaranteed events - 85 percent - were published between
0.8 and 5.0 minutes before the gun.** The overlay guard cycles every two
minutes and `MttPrestartRamp` ticks every 45 seconds. An event that exists for
sixty seconds gets at most one attempt to fill and usually gets none.

`MTT_PUBLISH_LEAD_MS` is 30 minutes and its own comment explains why: "40 ticks
= 240 entrants of headroom", and "an event that appears 60 seconds before it
starts cannot be joined by a human who is not already staring at the board."

`ScheduledTournamentService.restart` never consulted it.

```ts
const startTime = new Date(
  Math.max(Date.now() + 2 * 60 * 1000, endedAt.getTime() + restartMinutes * 60 * 1000)
);
```

`guaranteed_prize` is in `RESTART_COPY_COLUMNS`, so every restarted clone
inherits the guarantee, and this line published it two minutes out. The
scheduled creation path honours the 30-minute lead; the restart path is the
one that produces almost all of the volume, and it had a two-minute floor.

Both guards were working the whole time. They were being handed an event that
was no longer in the future by the time they looked at it.

## The change

`restartLeadMsFor(guaranteedPrize)` - one exported pure function:

- a clone carrying a guarantee gets `MTT_PUBLISH_LEAD_MS`, the same lead a
  scheduled event gets, which is the window both guards were built against;
- a clone with no guarantee keeps the two-minute floor. It cannot overlay, and
  a fast restart is what keeps the board from going quiet.

Pinned by `server/src/services/GuaranteedRestartLead.test.ts`, including an
assertion that the lead is longer than **two** overlay-guard cycles rather than
one - one cycle is what shipped, and one cycle is not enough to observe an
event and complete a registration round trip.

## What this does not do

It does not change a single guarantee, price or payout structure. Those are
Dan's under CLAUDE.md 10.9 and nothing here touches them. It gives the
machinery that was already built to erase overlays the time it was designed to
have.

It also does not back-pay anything. The overlay was paid correctly to the
players who won it; the defect is prospective, and correcting it forward is
the whole fix.

## Verify it worked

After this is live, the same lead-time query should move the mass from the
0.8-5.0 minute rows to the 30-minute row, and `fn_audit_overlays` should stop
raising `tournament_overlay` findings on restarted events. If overlays persist
at a 30-minute lead, the next suspect is the events/both lane pool being
genuinely exhausted, and `HorseOverlayGuard`'s "added NONE" warning is the line
that will say so.
