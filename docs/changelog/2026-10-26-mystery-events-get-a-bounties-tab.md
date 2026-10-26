# 2026-10-26 - Mystery bounty events get a Bounties tab

Dan 2026-10-25, verbatim: "CREATE ANOTHER TAB, FOR 'BOUNTIES' FOR ALL MYSTERY
BOUNTY TOURNAMENTS NEXT TO REWARDS, INSTEAD OF PLACING IT AT THE BOTTOM OF
REWARDS, WHERE ALL THE BOUNTY PRIZES AND AWARDS ARE LOCATED."

- `tabsFor(isMysteryBounty)` in `details/types.ts` inserts Bounties straight
  after Rewards for every mystery bounty event; other events keep seven tabs.
- `BountiesTab` renders the same `MysteryBountyPanel` (prizes ladder, awards,
  who pulled what) from the page's single `useMysteryBounty` fetch.
- Rewards keeps the pool totals and now points to the Bounties tab.
- `?tab=mystery` and `?tab=bounties` open it; on a non-mystery event a
  bounties link lands on Rewards.

Pinned by `tests/unit/aMysteryEventHasABountiesTab.test.tsx`.
