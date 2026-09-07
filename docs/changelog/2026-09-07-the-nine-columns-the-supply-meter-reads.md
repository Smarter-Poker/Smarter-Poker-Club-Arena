# 2026-09-07 - The nine columns phase 3 did not look at, and a view grant I widened by accident

## The gap in my own phase 3

Phase 3 audited "the conservation set" - 28 columns - and gave ten of them a
scale. That set was not the set the SUPPLY METER reads. Taking every column
`fn_ca_supply_snapshot` sums and asking the catalogue for its scale found nine
still open: six UNCONSTRAINED (`clubs.chip_pool`,
`club_wallets.insurance_balance`, and four `union_wallets` wallets) and three
at scale 4 (`club_wallets.chip_balance`, both `agents` wallets).

**And one was already holding an artifact.** `clubs.chip_pool` for Club JAQK
read `12459.070000000014` - 12,459.07 with a JS double's binary expansion
behind it - which is why the hourly supply total had read
`193,120,444.190000000014` all night. Same class as the `tournament_payouts`
`55.629999999999995` phase 3 found, in a column phase 3 never checked.

All nine now carry scale 2 (`20260907035639`). Exactly one stored value
changed: the artifact rounded to 12,459.07, a correction of 1.4e-11. Every
other one of the nine was already clean.

Twelve triggers and one view name those columns, so all thirteen were captured
from the catalogue, dropped, and re-issued from their own text, each compared
character for character afterwards. Two runs were needed to learn what counts
as "used in a trigger definition": the first captured by `pg_trigger.tgattr`
and still failed, because a WHEN clause counts too and two triggers name these
columns only there.

## The regression I caused doing it, and closed four minutes later

Re-creating a view in this database picks up Supabase's
`ALTER DEFAULT PRIVILEGES` for `anon` and `authenticated`. My restore loop
re-granted what each view had held **on top of that**, which is the union, not
the original:

| view                       | before                         | after                 |
| -------------------------- | ------------------------------ | --------------------- |
| `tournament_escrow_shadow` | postgres, service_role         | + anon, authenticated |
| `club_agents`              | + anon, authenticated (SELECT) | + REFERENCES, TRIGGER |

The escrow shadow is the serious one and it is entirely mine: an operator
report, readable by the engine and nobody else, and for about four minutes any
signed-in browser could select from it. It is `security_invoker=true`, so RLS
on the underlying tables still applied - a widening, not a leak of rows a
caller could not otherwise reach - but a widening I did not intend and would
not have noticed if I had checked only that the view came back.

`20260907040146` restores both ACLs exactly, REVOKE before GRANT. The lesson is
in its header: **when you put something back, put back everything about it, and
assert the part that decides who can see it.** Both migrations' verify blocks
compared the definition and the options and stopped there, and a definition
that matches character for character tells you nothing about who may read it.
