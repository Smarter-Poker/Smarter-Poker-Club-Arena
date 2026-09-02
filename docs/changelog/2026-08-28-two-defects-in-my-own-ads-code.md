# Two defects in my own ads code

2026-08-28

Both of these are mine, from earlier the same day. Neither was reported by
anyone; both were found by re-reading my own diff against the question "is
every new function actually called, and does every write do what it says".

---

## 1. An unknown slot silently relocated a live placement

`pages/api/club-arena/house-ads.js`

The placement routes normalised an unrecognised slot to `lobby_strip` and an
unrecognised audience to `all`. I wrote the comment justifying it too:

> Unknown values fall back rather than 400, because the panel only ever sends
> values from its own selects - a bad one is a bug in the caller, and
> defaulting is kinder than a save that fails on a field the operator cannot
> see.

That is wrong, and on `PATCH` it is dangerous. A request naming a slot the
server does not know would **move a live placement to a surface nobody named**,
answer `Saved`, and leave the panel disagreeing with the database. That is the
silent-wrong-write shape this estate keeps paying for, and I built a fresh one
while writing a comment explaining why it was fine.

The kindness argument was backwards as well. A refusal names the field and the
value. A default is discovered weeks later as an advert on the wrong screen.

**Fixed.** `normaliseSlot`/`normaliseAudience` are gone - deleted, not left
unused - and replaced by `readSlot`/`readAudience`, which return `null` for
"not acceptable". `null` cannot be written to a `NOT NULL` column by accident.
All three call sites now answer `400 Not A Known Slot: <value>`.

**One nuance kept.** On the create path, an _absent_ slot still defaults to
`lobby_strip`, because an ad with no placement runs nowhere and looks perfectly
healthy in the list. Absent means "use the default"; present-but-unknown is a
refusal.

**And the ordering matters.** That validation now runs **before** `ad_catalog`
is written. Refusing after the insert would leave a live ad row with no
placement and hand the operator a 400 for a campaign that was in fact half
created. There is a test pinning the relative order of those two lines, because
it is the kind of thing a later tidy-up moves without noticing.

---

## 2. `fn_prune_ad_events` was a permanent delete with no caller

Added by `20260828100000`, called from nowhere. Not merely dead code - a
**loaded delete** with no schedule, no preview and no route.

It could not simply be scheduled, either: `CLAUDE.md` section 11 makes Open
Claw the only sanctioned scheduler, and 11.3 fails CI on a net-new
`pages/api/cron/` file. So it belongs in the operator's hands, and an operator
is owed the blast radius **before** the button, not after it.

**Added** `fn_ad_retention_status()` (migration
`20260828164114`): policy days, cutoff, total events, prunable events, oldest
and newest. Counted server-side, because the entire reason a retention screen
exists is that the table is too big to fetch. `service_role` only - it is a
definer function over every ad event in the estate, and the post-apply block
asserts `anon` and `authenticated` cannot execute it.

**Wired** through `GET /api/club-arena/house-ads` as `retention`, and
`POST ?kind=prune` as the one and only caller of `fn_prune_ad_events`. Both sit
behind the existing platform-admin gate (lines 155-175, ahead of every method
branch - verified, not assumed).

**Surfaced** as a retention strip in the panel, with four deliberate
properties:

- the count is shown before the button **and printed on the button**, so nobody
  learns the size of a permanent delete from its result;
- **no "how many days" input.** The server reads the policy itself, so the
  number shown at render and the number used at click cannot drift apart;
- when there is nothing to prune there is **no control at all**, rather than a
  disabled one. A dead button on a destructive action invites the experimental
  click that finds out what it does;
- backing out of the confirm **disarms** it. Leaving it armed means the next
  stray click deletes.

Live reading at the time of writing: 180-day policy, 243 events stored, oldest
2026-08-27, **0 past the cutoff** - so the panel currently shows "Nothing Past
The Cutoff." and offers nothing to press. That is the correct first impression
for this control.

`.admin-panel-soft` was invented for that strip and had no CSS behind it, which
the same audit caught. It is now defined in `AdminDashboardPage.css` as a thin
status strip - `.admin-card` exists but its 24px padding is meant for a whole
section.

---

## Verification

- `npx tsc --noEmit` - exit 0.
- `npx vitest run tests/unit/houseAds.test.ts` - **85 passed**, including 5 new
  tests pinning the retention wiring and the disarm.
- `node --test __tests__/house-ads-hub-promotions.test.mjs` (World Hub) - **24
  passed**, including 2 new tests pinning the refusal at all three call sites
  and the validate-before-insert ordering.
- `fn_ad_retention_status()` read back live against production.
