# 2026-09-04 - Present is not discoverable, and bars follow the footer down

Branch: `fix/search-finds-you-first-and-the-bar-locks-down`. Dan, with two
screenshots, after I had told him he was discoverable.

## 1. "I AM NOT DISCOVERABLE... WHY ARE YOU LYING TO ME?!"

He was right and I was wrong. I had verified that the roster RPC returned his
row - it did - and called that "discoverable". On the page he was **row 21 of
21**: the list kept sorting by chip balance while a search was active, his
Deep Stack balance is 0.00, and twenty horses whose _handles_ contain
"kingsley" sat above the one member whose _name_ is KingFish - under the
action bar and the footer. I confirmed it in the browser, signed in as him,
before writing a line: 21 rows, KingFish last.

Present is not discoverable. A search is a question about a name, so with a
query on, the list now ranks by how well the row matched
(`rosterMatchRank`: name over handle over member id; exact over prefix over
contains; the person searching for themselves first) and only then by the
chosen sort. With no query the chosen sort is the whole order, exactly as
before. "KING" now returns KingFish first, TheKing second, the kingsley
handles after.

## 2. "The box above it needs to snap lock to the footer when the footer disappears"

`useHideFooterOnScroll` drops the footer off the bottom edge on scroll-down,
instantly, by law. The cashier's Claim Back / Send Ticket / Send Out bar
stacked on `--bottom-nav-stack-base`, a CSS constant equal to the footer's
_designed_ height, which does not move - so the bar hung a footer's height
above the edge with rows showing through the gap.

Three other bars had the identical gap: the table-config Save/Start footer
and the club-settings unsaved and conflict bars. So the fix is at the source:

- `ClubBottomNav` publishes the height it **occupies right now** as
  `--ca-bottom-chrome-h`: measured while shown (ResizeObserver keeps it
  current), `0px` while scroll has hidden it, `0px` on unmount.
- `--bottom-nav-stack-base` **is** that number, in both stylesheets that
  define it. Every bar that stacks on the footer stacks on the base; the four
  that were on the clearance now are.
- `--bottom-nav-clearance` stays the designed height: it is what page content
  reserves, and content must not jump when the footer slides.

No transition anywhere. The footer's rule is "real time instant change" and
the bar moves on the same frame.

## Laws

- `every-member-is-discoverable-in-the-cashier` gains the rank bands, the
  21-of-21 case rebuilt from the real numbers, and the page's sort order.
- `bars-stack-on-the-footers-live-height` (new, registered): the publish,
  the live base, no `bottom: var(--bottom-nav-clearance)` on any bar in
  `src/`, and the four bars pinned to the base.

## What I did not do

I did not say "verified" about anything on this branch until it was on the
live page. Deployment is autopilot's; the browser check against production
follows the merge, and is written up below when done.
