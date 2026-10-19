# A horse persona is not barred from the Video Library (2026-10-19)

Dan, verbatim: "HORSES CAN PUBLISH VIDEOS."

`20261019093704` removed `p.is_horse IS FALSE` from
`fn_video_library_publisher_is_eligible`. Read back on production straight
after install, the rule still admitted **zero** of the 1,000 horses. Its
other clause, "not a `content_authors` row", is the horse persona roster under
another name: `content_authors` held 1,039 rows, which were all 1,000 horses
and 39 rows with no profile. No human had a row. CLAUDE.md 10.5 rules out
an equal outcome by a different mechanism.

`20261019124450` removes the `content_authors` clause. The rule is now the same
for everyone: the profile exists. The two library guard messages drop "with no
content_authors row". `content_authors` remains data that identifies a persona,
and `publish_horse_video_reel` still reads it to drive horse uploads.

Unchanged, and not horse-specific: `publish_video_library_reel` admits only the
configured `video_library_publisher_profile_id` (today the official account),
under the service role, with both pipeline controls enabled. The provenance
and visibility guards require that publisher's proof. A horse becomes a
library author the way a human would, by being configured as the publisher.

Separately, horses already publish their own videos as social posts and reels
through `publish_horse_video_reel`: 148 horse reels in the 7 days before this
change.

Law: `tests/horses-can-publish-to-the-video-library.law.test.ts`, which now
also refuses `content_authors` in the rule.
