# Daily Missions Artwork Remains Observable After The Browser Timeline Fills

The production certification of client ad23d835 failed because its cold-load resource inventory contained the casino hero but omitted the diamond image. The browser timeline retains only 250 resource entries. The same run recorded 280 resources on the leaderboard, and a credential-free Chromium reproduction with the real mission images reproduces the exact incomplete inventory while the diamond decodes at 96 pixels. Both production origins serve that diamond with the exact source hash.

The Daily Missions certification now records its artwork through a resource PerformanceObserver installed before navigation, which continues receiving completed resources after the timeline fills. It also checks the mounted hero and diamond decode, allows their actual paint to complete, and records resource count and overflow evidence before the performance assertions. All original request-count, timing, layout-shift and 180KB art budgets remain intact.

Two maintained browser cases run through the existing post-deploy routes suite. They fill the real Chromium timeline, prove the old inventory loses the diamond, and verify the new observer retains exact image bytes. A successful HTTP response with invalid image data must still fail the mounted image gate. These fixtures use only their own localhost server, with no credentials or production writes.

Application code, approved artwork, styles, rewards, financial requests and the certification's economy/cleanup journey are unchanged. Local checks and protected publication are recorded separately from actual signed-in production acceptance.
