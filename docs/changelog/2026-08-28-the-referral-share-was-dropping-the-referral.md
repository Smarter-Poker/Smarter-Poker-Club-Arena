# The referral share was dropping the referral

**2026-08-28.** `referral_invite` is one of the six house campaigns. It points
players at a share flow that was losing the thing being shared.

`ReferralDashboard.handleShare` handed `navigator.share` the bare homepage:

```js
const shareText = `Join me on Club Arena! Use my referral code ${stats.code} ... https://smarter.poker`;
navigator.share({ title: 'Join Club Arena', text: shareText, url: 'https://smarter.poker' });
```

The code lived **only in `text`**. A share target is free to ignore `text` and
use `url` alone, and most do — every sheet that renders a link preview, and
several that post the URL and drop the caption entirely. So the commonest way
to share a referral was also the way that silently dropped it: the friend
arrives at the homepage, signs up unattributed, and the referrer is never
credited for a referral they actually made.

Nothing anywhere reported this. There is no error to see — the share succeeds,
the friend joins, and one row simply never appears in `referrals`.

## It was the odd one out, not the pattern

The other two referral flows in this app already embed the code in the URL:

```
PromotionsPage   ${origin}/hub/club-arena/invite/${clubId}?ref=${referralCode}
InvitePage       ${baseUrl}?ref=${refCode}
```

So this was one flow drifting from a convention the codebase already had, which
is why it survived a year of nobody noticing.

## The fix

`referralUrl()` builds `${origin}/hub/club-arena/invite?ref=<code>` and that is
what goes in `url`. A target that keeps only the URL now still credits the
referrer.

`window.location.origin` rather than a hardcoded host: this SPA serves from
smarter.poker in production and from a preview host otherwise, and a hardcoded
link in a preview build sends testers to production. The clipboard fallback
gets the pitch and the link, in the order somebody would paste them.

## Why this belongs with the ads work

The house ad system spent today learning to measure whether a promotion worked.
`fn_ad_conversions` counts a `referral_invite` click as having followed through
when somebody uses the referrer's code — and until this fix, a player could
click the advert, share enthusiastically, bring a friend, and the campaign would
still score zero, because the credit never reached the database.

Measuring a funnel with a hole in it produces confident numbers about the wrong
thing. This was flagged in the Phase 2 handoff on 2026-08-27 and was still live
a day later.

## Verification

```
npx tsc --noEmit     clean
npx vitest run       504 files, 7961 tests, 0 failures
```

Four new source-pinned tests, including one that fails if the bare homepage
ever comes back as the share destination.
