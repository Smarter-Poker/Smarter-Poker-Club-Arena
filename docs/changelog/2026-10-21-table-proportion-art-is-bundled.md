# Table Proportion Checks Use Bundled Artwork

The occupied-ring and decision-row renders in `tests/e2e/table-proportions.spec.ts`
downloaded the table avatar from smarter.poker and four toolbar icons from
Supabase storage at run time. When that request failed (a local runner, a moved
object, a slow origin), 17 layout cases failed before measuring anything.

The five images are now copied byte for byte into
`tests/e2e/fixtures/table-art/` and read from disk. Every geometry assertion is
unchanged. The Inter font is still read from Club Arena's own static origin on
purpose, so the renders keep matching production typography.

Validation: 34 of 34 table proportion cases pass in Chromium and WebKit on the
Mac, including the 17 that previously failed on the avatar download.
