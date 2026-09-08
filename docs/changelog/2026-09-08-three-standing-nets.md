# Three standing nets over the diamond economy

2026-09-08. `supabase/migrations/20260908050418_three_standing_nets_over_the_diamond_economy.sql`.

The diamond economy had a report (`fn_ca_diamond_economy`) and no alarm. Three
nets were added, all read-only over the same definitions the report uses, so a
number can never mean one thing in the report and another in the alarm.

## 1. Concentration

`fn_ca_diamond_economy_watch` files an incident when one human account holds more
than 60 percent of all human-held diamonds. Measured 2026-09-08: one account held
494,445 of 566,246 - 87.3 percent - with the next largest at 11,571. That is not
a defect; it is a fact about the economy that somebody should see.

## 2. Velocity

The same function files when issuance outruns what players spend PLAYING by more
than the band. The levers if it fires are the per-user daily caps and what
diamonds can be spent on, and both are Dan's.

## 3. Reachability

`fn_ca_diamond_unreachable_money` looks for money paths that nothing can reach -
a rule with no enforcement, a door with no caller, a mode nothing consults - and
returns a row per finding. It is the answer to the estate's real failure mode
(CLAUDE.md 10.86): not a missing detector, but a detector that answers
confidently when it cannot tell.

## Retention

`fn_ca_diamond_prune_history` keeps the incident table from becoming a place
nobody reads. It only removes RESOLVED info and warning rows; a critical or an
unresolved incident is never pruned by age.

## The honest caveat, added the same night

Two of these shipped with defects of exactly the kind they exist to catch: the
concentration alarm filed on EVERY call, and the reachability detector's rule arm
was satisfied by a body that merely mentioned the rule's name. Both are fixed in
`2026-09-08-what-the-second-review-found.md`. A net that cries every minute and a
net that passes anything are the same net.
