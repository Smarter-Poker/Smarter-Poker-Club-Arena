# Retain a proven frontend artifact for narrow engine-control changes

The static publisher previously rebuilt and relabeled the frontend for every
main commit, including engine controls. A running browser certificate could
then lose its exact frontend identity even when the application inputs had
not changed.

The publisher can now retain its existing immutable frontend only when the
complete source delta modifies ordinary 0644 files among the six reviewed
engine controls exported by PR 4333's unchanged shared classifier. The actual
control checkout and separate target checkout are verified. Unknown paths,
missing history, additions/deletions, mode changes, symlinks, shared browser
inputs under `server/`, and copied test/build inputs take the normal build
path. The full 07f20782 delta includes a companion unit-test file outside the
six controls, so it conservatively rebuilds; no broad tests exclusion exists.

For an eligible delta, fresh origin/public build and provenance documents
must match a read-only native proof of the existing artifact. The proof opens
the existing static `.publish.lock` read-only and takes a bounded shared
flock, checks exact source/publisher provenance, verifies every file against
the complete existing manifest, rejects symlinks/special files, and rechecks
identities. It never creates a lock, backfills a manifest, or changes assets.
The original trusted publisher's successful origin proof is also required;
an optional downstream failure cannot hide that original success.

The publication job repeats the source and native/public proofs against the
saved preview before emitting a retained-artifact receipt. A mismatch fails
closed. It retains the original frontend SHA and manifest identity; it never
stamps the newer target onto old bytes. Build skipping requires a successful
artifact proof, and all existing client gates remain in force.

Every browser trigger and all eleven report groups remain active. The browser
job, cleanup, and final unchanged proof are byte-identical to accepted a8.
This bridge prevents narrowly proven unnecessary static mutations; it does
not serialize real frontend changes with older certificates. The executable
controller integration handoff is
[`frontend-controller-follow-up.md`](../operations/frontend-controller-follow-up.md).

Dependency: exact PR 4333 head `8c556505bf306aadfe1cd8052675954b18b2fe05`,
composed into the isolated a8 base without editing the shared classifier.
This held draft must follow that dependency. No current request, host, setting,
or production artifact was changed while preparing it.

The owned 18:42:48Z read-only static probe observed source
`a8be599ec0e3a53affbb6b14c7efe902c8729f14`, publisher run `34631421377`,
1,797 exactly manifested files, and manifest SHA256
`b4669709d8900b1a98664f4b30054c9b3ec35a2f5cb2348d210090a0bfde39bf`.
The existing publisher lock was uid/gid 1000, mode 0664, device 2049, inode 2987241. Only that fixed lock permits matching-publisher-group write mode;
artifact files and directories retain strict ownership/mode checks.

Validation: 165 focused Vitest tests passed across 14 files, including a real
Python subprocess that passes 11 native filesystem tests. TypeScript, ESLint,
formatting, and actionlint workflow validation passed. Full shellcheck reports
the same 12 normalized existing diagnostics as the pre-bridge baseline; none
were introduced by this change. The new public reader fetched both exact
build/provenance documents with cache bypass and matched the owned native
receipt; the original publisher API proof resolved run 34631421377, attempt 1,
origin job 103370709020. The production owner then ran the exact native reader via stdin at 18:53:52Z
and verified the same 1,797-file manifest, release inode 2991006, and publisher
lock inode 2987241, without installing code or writing production files. The
reader SHA256 was
`57f33cade93a8e58dceb4ada4d89d41b06f56034cba6431d3d742901e76be421`.

Coverage includes native temporary Git provenance/config isolation,
source/control confusion, mixed/unknown inputs, real filesystem manifest and
lock tests, concurrent corruption and inode replacement refusals, actual
workflow predicates and browser-gate execution, TypeScript, and
[actionlint v1.7.7](https://github.com/rhysd/actionlint/releases/tag/v1.7.7).
These are source/native rehearsal proofs, not a production activation claim.
