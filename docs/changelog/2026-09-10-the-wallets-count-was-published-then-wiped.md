# The wallets count was published, then wiped, in the same commit

The third and last layer of the MY WALLETS defect Dan photographed on
2026-09-09, found on 2026-09-10 by reading the deployed lobby instead of a
fixture of its stylesheet. It corrects the two earlier notes on this plate
(`2026-09-09-three-mobile-lobby-bugs.md` and
`2026-09-09-the-wallets-line-was-clipped-not-misaligned.md`) on one point:
the placeholder in the photograph was not a slow load.

## What was measured

Production, signed in, `clubs/<club>` on an iPhone 13 profile, the text of
`.lobby-wallets-trigger__copy small` sampled every 25ms for fifteen seconds:

| load                 | at mount | at 15s |
| -------------------- | -------- | ------ |
| cold                 | `""`     | `""`   |
| warm reload          | `""`     | `""`   |
| client-side re-entry | `""`     | `""`   |

The count never printed. Before #4003 the same plate printed "Loading Balances"
in the same way, from the day the count shipped (#2050, 2026-08-31).

## Why

`ClubHomePage` holds the count in state and hands `setVisibleWalletCount` to
`DynamicWallet`, which publishes the role-derived count from an effect. The
page also ran

```ts
useEffect(() => {
  setWalletsExpanded(false);
  setVisibleWalletCount(0);
}, [resolvedClubId]);
```

Both effects belong to the commit in which the wallet mounts. React runs a
child's effects before its parent's, so the reset always ran after the
publish and erased it; nothing re-published until the wallet's row set changed,
which for most viewers it never does. Moving the publish to a layout effect
(#4003) changed the order of the two writes within the frame, not which one
won: the layout publish is a sync update, the passive reset a default-lane
update queued behind it, and the last write to the queue is the state.

`tests/unit/theWalletsCountSurvivesTheClubReset.test.tsx` shows all three
shapes against React 19: layout publish + reset prints nothing, passive
publish + reset prints nothing, publish without reset prints "5 Balances".

## What changed

- `src/pages/ClubHomePage.tsx`: the club-change effect still collapses the
  wallet list; it no longer touches the count. The wallet is the only writer.
- `tests/the-mobile-lobby-chrome-stays-fixed.law.test.ts`: the page may not
  call `setVisibleWalletCount` at all; only the state hook and the prop that
  hands the setter to the wallet may name it. Red against main's page, green
  against this one.
- `tests/unit/theWalletsCountSurvivesTheClubReset.test.tsx`: the mechanism.
- `tests/e2e/production-mobile-lobby-chrome.spec.ts`, wired into the
  post-deploy sweep: the deployed lobby, signed in, on a phone profile, must
  print `N Balance(s)`, still be printing it four seconds later, centred on the
  painted title and unclipped; the filter row must lock under Find Your Game at
  the bottom of the scroll; the footer frame must sit on the bottom edge. Run
  against production before this change it fails the first test and passes the
  other two, which is the shape of the defect.

## What this does not change

The zone geometry, the empty-string fallback and the layout-effect publish
from #4003 and #4053 all stand; each was a real part of the picture. What was
wrong was the claim that the bay would be empty "for one frame". It was empty
for good.
