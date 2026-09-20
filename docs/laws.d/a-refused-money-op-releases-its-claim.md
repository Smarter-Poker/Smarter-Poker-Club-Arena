# tests/a-refused-money-op-releases-its-claim.law.test.ts

`fn_ca_mint` and `fn_ca_burn` take the idempotency claim before they do the
work, and every refusal between the claim and the finalize said no with a plain
plpgsql RETURN, which rolls nothing back - so the claim row committed with
result NULL and stayed for ever. 289 of them were sitting in `ca_op_claims` on
2026-09-19, all `fn_ca_mint`, all from the 24 hours of 2026-09-08 in which
diamond issuance ran 2,784,110 against a 2,000,000 rolling cap and the ceiling
refused every signup grant it met. None of the 289 carried money anywhere: no
register row, no journal leg, no diamond journal row. Nothing was stuck -
both doors delete an unfinalized claim and retake it - but
`check-chip-conservation.mjs` fails while any claim is open over an hour, so
the one alarm watching for a half-finished money operation was permanently red
and could never go red at anyone. All eleven refusals that sit after the claim
(four in the mint, seven in the burn, none of which had ever fired) now return
through `fn_ca_release_claim`, which releases an unfinalized claim only and
hands the refusal back untouched; the residue was removed only where no
register row, journal leg or diamond journal row exists under the op id, so a
genuinely half-finished operation stays visible and keeps the audit red. The
law's forward guard is the regression it expects: no migration after
20260919064146 may re-define either door with a refusal that returns without
releasing its claim, because a full-body replacement built from an older mirror
would restore the leak silently and the rows take days to reappear. Whether the
one refused signup grant belonging to a player who still exists is made good is
a decision about a balance, not a defect in a door, and is not taken there.
