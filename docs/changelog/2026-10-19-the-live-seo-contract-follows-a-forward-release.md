# The live SEO contract follows a forward release

During the 2026-10-19 GitHub Actions incident, "The Live SEO Contract Holds"
started 16 to 20 minutes after its publication gate. By then a newer publisher
had already replaced the client it was told to wait for. Runs 39307277919 and
39313288388 read `fd6a602c2e` from build-info.json for three minutes while
waiting for `a6af2a2425`, its ancestor on main, and then went red without
reading a single page. The browser lanes already re-target onto a forward
release (the `descendant` branch in `post-deploy-e2e.yml`); this check did not.

`scripts/ci/check-live-seo-contract.mjs` now accepts a served commit that
descends from the expected one and is on protected main, and checks the
contract against what crawlers actually get. A rollback, an off-lineage SHA or
an unresolvable commit still waits and then fails. The job checks out the full
commit graph (no blobs) so it can prove that lineage. Tested live against a
superseded SHA: the checker followed the forward release and reported "live SEO
contract: OK". The cases are pinned in
`tests/the-live-seo-contract-reads-the-site-not-the-source.law.test.ts`.
