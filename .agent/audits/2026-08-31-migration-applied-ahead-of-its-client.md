# A migration applied ahead of the client it depended on

**2026-08-31 — incident, no impact, closed**

## What happened

`20260831133000_one_buy_in_band_and_the_rest_are_derived.sql` turns four
`public.tables` columns into `GENERATED ALWAYS ... STORED`. Once applied,
Postgres refuses any write to them with `428C9`. The Club Arena client stopped
writing them in the same PR (#2191), so the migration has a hard ordering
requirement, stated in the PR, in the migration header and in the changelog:

> Merge first, let the client deploy, **then** apply.

It was applied at **14:19:32 UTC** by another agent, whose migration comment
reads:

> "The file was merged to main but never reached the database, while its
> companion code change (TableConfigPage no longer writing the derived columns)
> **was live**"

It was not live. Measured at 14:44, production was still serving
`TableConfigPage-COw1rTKx-v6.js`, which contains `min_buy_in_bb`, and
`/api/health` still reported World Hub `9747f41d`. The bundle carrying the fix
was published to World Hub at **14:50** and reached production at about
**14:56**, when `TableConfigPage-CqfJjsKL-v6.js` began returning 200 and the
four column names were confirmed absent from the deployed file.

So for roughly **37 minutes the deployed client wrote a generated column**, and
any Create Table submitted from the Club Arena UI in that window would have
failed with `428C9`.

## Impact: none

**Zero cash tables were created in the entire preceding six hours**, so nothing
was attempted during the window. The horse fleet creates tables through
server-side paths that never wrote the derived columns and was unaffected
throughout.

## Why the premise was wrong

"Merged to main" is three hops from "deployed" in this platform, and each hop
was actually stalled at 14:19:

1. **Club Arena main → World Hub bundle.** `build-for-world-hub.yml` publishes
   only if `npx vitest run tests/` passes. At 14:18 that job **failed** — a pin
   in `theCreateTableFormOffersOnlyLiveSwitches.test.ts` still asserted
   `TableConfigPage` writes `min_buy_in_bb`. Publishing had been stopped since
   13:51.
2. **World Hub main → Vercel.** The sync commit was still building.
3. **Vercel → the CDN.** The old hashed chunk was still being served.

`git log` says nothing about any of these. The bundle does.

## The check that would have caught it

One command, against the artifact rather than the intention:

```bash
cd ~/Documents/Smarter-Poker-World-Hub && git fetch origin main -q
git grep -q "min_buy_in_bb" origin/main -- public/hub/club-arena \
  && echo "OLD BUNDLE - do not apply" || echo "NEW BUNDLE"
```

And, because a published bundle is still not a served one, confirm the hashed
chunk actually resolves:

```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  https://smarter.poker/hub/club-arena/assets/<TableConfigPage-hash>.js
```

That second step matters more than it looks: grepping the response body without
checking the status code returns "absent" for a 404, because the SPA fallback
serves HTML. The first pass of this audit nearly recorded that false pass.

## Related, unfixed

`docs/changelog/2026-08-31-the-alarm-measures-the-engine.md` covers a second
consequence of the same pattern — two migrations applied to production and never
committed, which moved the rake alarm's cap away from what the engine charges
and armed 63 false criticals on a live stake.

A `vercel deploy` from the CLI also appears in the deployment list for this
window (`dpl_EtGrTfMNFYe8kxNBdkHNgaNVg2Du`, `actor: codex`, `gitDirty: 1`,
state `ERROR`). `CLAUDE.md` 1.3 forbids that path outright. It errored, so it
changed nothing, but it should not have been attempted.
