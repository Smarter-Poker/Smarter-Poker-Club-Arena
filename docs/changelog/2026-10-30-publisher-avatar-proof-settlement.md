# Await the authoritative avatar-removal proof

Publisher 41090728397 refused shard 12 because the avatar-removal qualification
fired a background record event and immediately inspected the DOM. The event
callback returns no promise, so React act does not represent completion of the
authoritative read. The component and test inputs were unchanged from the last
successful publication.

Hold the real mocked authority response pending, verify the original image stays
until that response arrives, then resolve the removal and await the existing
no-image assertion. Preserve the member identity assertion. A controlled pending
response reproduces the old immediate assertion failure. No production behavior,
assertion outcome, timeout or test selection changes.
