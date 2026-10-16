# Header Portrait: One Pixel Invisible Edge

The owner clarified on October 16 that the profile photo must have a very thin one-pixel invisible frame. The shared Club Arena header now declares one 1px near-black border around the circular photo. The opaque mask continues to hide the decorative chrome ring at every width, including keyboard focus. Header artwork, layout, photo source and navigation remain unchanged.

Existing source and rendered-pixel contracts retain the ring masking and intact-portrait checks and now require the exact one-pixel edge. This is a client-only correction using the normal protected merge and static publication route.

## Required Check Recovery

The hosted migration-ledger check failed because installed migrations 20261015101106 and 20261015102509 had aged past its 24-hour source-recording grace. Their existing feature PRs are #6981 and #6949. This follow-up records only the exact SQL from production history, with digest-bound recording entries; it does not execute either migration, modify either feature branch, or supersede the feature work. Read-only checks confirmed the money-board postimage and registry state and the affected functions' owner, security, search paths and grants. The task archive retains the exact recovery bytes and provider failure.
