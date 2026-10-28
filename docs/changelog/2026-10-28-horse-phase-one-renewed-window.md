# Renewed bounded Phase 1 activation window

After the original window expired, the owner explicitly selected “Continue tonight with a new bounded activation window”. A separate entry anchors one certified activation to protected Phase 1 PR #8389 merge `211ebe5d8ce3fe3c1e8845976925f436dcbf3895`, from 03:17 through 08:50 UTC on October 28. The expired entry remains unchanged. The release target must contain this new entry itself; older targets cannot borrow its authority.

Only the original Pineapple migration is named, confirmed uninstalled at 03:16:45 UTC; the existing installer must recheck history and never replay it. The complete two-minute notice and five-minute pause must fit by expiry, requiring reservation by 08:43 UTC and preserving the full 285-second reserve, hand drain, durable freeze, certificate, rollback, rolling-hour seal and v3 thaw. Expiry precedes the daily 03:58 Chicago notice.

This changes no runtime strategy, feature flags or qualification. Protected merge, certified activation and natural live verification remain separate requirements; this entry is not proof that all 1,000 horses are qualified or upgraded.

Protected-main integration preserves the independently authorized MTT add-on window from PR #8410 alongside this entry. Its existing release operation retains ownership; no duplicate cutover is requested. The Pineapple migration remains a separate uninstalled obligation until its original certified installer and readback prove completion.
