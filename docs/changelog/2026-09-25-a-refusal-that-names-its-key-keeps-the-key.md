# A refusal that names its key keeps the key (2026-09-25)

Run 36095932476 (the 04:55 UTC recovery window, on #5228) is the furthest an
engine release has reached since 2026-09-22: every capture refusal cleared,
every row proof passed, 45 tables written and verified, the eleven dead
generations' rows proved, the one in-window cash seat move proved dealt, the
FIRST retained manager (5a387a75) observed clean - its seven never-reserved
epochs witnessed by their absence - and then the second (615783bf) refused in
`smarter_private.f06_retired_origin_transfer`. The receipt said:

```
failedCheck=rpc.transport failedTable=615783bf-... sqlstate=P0001 refusal=string(44)
```

The Postgres log said `F06_RETIRED_CANONICAL_CHANGED: registrations`. The
guard's `refusalToken` carries only a bare upper-case token and reduces
anything else to its length, and this function names the key it refused on
after a colon - which is the whole finding. The token rule now admits one
token naming one lower-case key (`TOKEN: key`); every other string is still
reduced to its length, so nothing that is not a refusal token can reach a log.
Nothing was committed: the two-phase observe-then-commit from #5218 held, and
`f06_manager_custody_transfers` has no row for either manager.

The refusal itself is the one decided in this session's changelog for #5218:
a bust recorded after the origin was attested (user 62ec986d, seat left with
stack 0 on 2026-09-18, attested 2026-09-21). Clearing it is a change to a
custody comparison that waits on Dan's word; this entry only makes the
receipt say so.
