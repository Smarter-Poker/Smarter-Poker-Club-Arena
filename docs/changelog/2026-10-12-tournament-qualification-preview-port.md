# Tournament qualification previews use Fetch-readable ports

PR 6773 production-build job 114896465500 compiled and passed route performance, then failed accessibility preview readiness. Runner GitHub Actions 1000289766 selected port 6697: a native HTTP listener bound successfully, but the readiness Fetch refused that restricted port. Comparable successful job 114881915896 selected ports 5983/5987 with the unchanged helper.

`scripts/ci/e2e-port.mjs` now skips restricted ten-port blocks during finite allocation, retaining distinct surface digits and adjacent development ports. Strict binding, server isolation and readiness assertions remain enforced. No runtime engine or financial behavior changes.

The existing port law executes the exact failed runner through native HTTP/Fetch and independently checks every configured preview surface across all 300 offsets. Before: two failures including native bad-port refusal. After: 27 focused tests pass; TypeScript and formatting pass. The actual local production build also succeeds. Hosted checks and protected integration remain required; local results do not certify publication.

Source and callers reread after editing. This supporting change resolves a demonstrated blocker to retained tournament qualification enforcement.
