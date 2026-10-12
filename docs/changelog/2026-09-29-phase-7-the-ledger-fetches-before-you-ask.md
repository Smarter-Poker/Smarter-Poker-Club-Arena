# Phase 7 of 8 (Club Arena half): the ledger fetches its next page before the player asks

2026-09-29

## What a player sees

The two diamond panes in the wallet (Receive and Send) page 25 rows at a time.
Until today the only route to page two was to scroll to the bottom of the list,
find a button, press it, and wait. The longest ledger in production is 390
credits, so that player pressed the button fifteen times and waited fifteen
times.

Now the next page is already on its way. An invisible sentinel sits at the foot
of the list, and when it comes within about a screenful of the viewport the
read starts, so by the time the last visible row has been read the rows behind
it are usually there.

Nothing was taken away. The Load Older control is still on screen, still
pressable, still reachable with a keyboard, and it is still what answers when
a prefetch fails.

## Where it lives

`src/components/wallet/DiamondLedgerMore.tsx`, one component used by both
panes. It carries the four affordances the tail of a paged ledger needs, and
all four were previously written out twice in `PlayerWalletPage.tsx`:

- the prefetch sentinel,
- the retry after a later page failed,
- the manual Load Older control,
- the line that says the ledger has ended.

Two copies of a control is how one of them quietly stops matching the other,
and the Receive copy and the Send copy had already drifted in their comments.
The page now renders `<DiamondLedgerMore>` twice with its own copy strings, and
no longer imports `DIAMOND_LEDGER_PAGE` at all, because the end line that reads
it moved too.

## The runway is the guard, and it is deliberately short

`rootMargin` grows the observer's viewport downward, so the fetch starts while
the sentinel is still that far below the fold. The obvious number is "a page of
runway", and that is the bug.

A landed page is 25 rows: at least 25 x ~54px of row plus 24 x 8px of gap, so
about 1,540px. If the runway were a page tall, every landed page would push the
sentinel by a distance the margin still covers, the sentinel would re-arm
immediately, and the ledger would walk itself to the end in a chain of
`.range()` calls nobody asked for. That is the failure this could not have.

`LEDGER_PREFETCH_RUNWAY_PX` is therefore 480: roughly one phone screen and
eight rows, which is enough that the read is in flight before the last row is
reached, and short enough that one landed page ALWAYS carries the sentinel
clear of the margin. The arithmetic is written beside the constant so the next
person who wants to raise it can see what it is holding up.

## The other three guards

**One page at a time, latched on a ref.** `loadingMore` is state, so it is
still `false` inside the observer callback that just asked for a page. A second
intersection in the same tick would ask again. `firedRef` closes that window
and is cleared only once the read has settled.

**A failed prefetch stops prefetching.** `error` disarms the sentinel and
unmounts it, so a page that failed is retried by the player on the control and
never by an observer spinning on it. The pages already on screen stay, which is
rule 4 of `useDiamondLedger` and is unchanged.

**A refresh cannot trip it.** `load('refresh')` prepends arriving rows above the
list, which pushes the sentinel further DOWN and away from the viewport. It is
not `'more'`, so it never sets `loadingMore` and never re-arms the latch early.
The merge-not-reset behaviour from phase 1 of this pane is untouched.

**No leaked observers.** The sentinel is attached with a callback ref, so React
handing it `null` on unmount disconnects; the same happens when `hasMore` goes
false and the sentinel is removed, and again in an unmount effect.

## Where there is no IntersectionObserver

The hook checks for it and, finding nothing, simply does not observe. The
button below is the route, unchanged. A browser without the API is not an error
state and is not told it is in one.

## Tests

`tests/unit/theLedgerFetchesBeforeYouAsk.test.tsx`, ten pins with a mocked
`IntersectionObserver`: it fires once when the sentinel enters the runway, it
does not fire twice for one page (both before and after `loadingMore` commits),
it asks again only after the page it asked for lands, it stops and disconnects
at the end of the ledger, it stops and disconnects on a failure and puts the
retry on a control, the manual button stays enabled and pressable, the whole
thing still works with no `IntersectionObserver` at all, it disconnects on
unmount, and an empty ledger renders no tail and observes nothing.

Not a `*.law.test.*`: this is behaviour this phase chose, not a rule Dan
stated (CLAUDE.md 10.8).

`tests/wallet-casino-realism.test.ts` was updated in the same commit. Its two
existing pins on `Load Older Diamonds` / `Could Not Load Older Sends` still
passed after the move, but they were passing on a prop string rather than on a
rendered control, which is a pin that no longer proves what it claims. They now
read the new component for the control and the page only for its copy, and
assert both panes take the tail from one component. One new pin covers the
prefetch: the observer exists, the runway is under 1,000px, the ref latch is
there, the observer is disconnected, the sentinel is `aria-hidden`.

## Not in this change

The World Hub half of phase 7 (Stats breakdowns summed in SQL rather than over
one page) is a separate task in a separate repo. Nothing here touches the
engine, a migration, the ledger query itself, or any scheduled job.
