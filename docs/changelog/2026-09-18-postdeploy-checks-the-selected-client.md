# Post-deploy checks the publisher's selected client

The publisher may select a newer protected main revision than the merge that
triggered it. The SEO job previously checked out and awaited the trigger revision,
so publisher `35288647065` successfully served `414c12e1654f` while its post-deploy
job waited for `4dc07c7f6618` and failed before checking any SEO assertions.

The existing publication gate now resolves the selected revision from that
publisher run's unique client artifact. It requires the exact run, trigger,
main branch and repository identities, a complete artifact response, and an
unexpired artifact with a full revision. The SEO checkout and live expectation
both use that result. Missing, ambiguous or foreign artifacts fail closed;
neither the trigger nor an arbitrary newer live revision is a fallback. The
origin publication verdict and exact live comparison remain required.

The connected regression failed against the original source (4 failures), then
all 91 focused provenance, SEO, publication and concurrency checks passed. The
source repair does not itself certify the live SEO assertions, browser suite or
any engine behavior; those remain the normal post-deployment results.
