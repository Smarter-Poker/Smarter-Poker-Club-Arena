# The Console Zones That Sat On Each Other

2026-09-22. `src/components/console/SpadeConsole.tsx`,
`tests/painted-zones-never-overlap.law.test.ts`.

Two of the three approved console families declared head zones that overlap,
and both also gave their subtitle a band shorter than the line it holds. A
console handed a title and a subtitle printed the second through the bottom of
the first and cut the letters off underneath. Fixed by re-measuring every band
against the master art, and pinned by a law that computes the intersection for
every family and every shape of head content.

## The defect, in master pixels

| family  | title band | subtitle band | rectangles share | subtitle ink printed |
| ------- | ---------- | ------------- | ---------------- | -------------------- |
| shark   | y 76-142   | y 126-148     | 440 x 16         | 10.3 of 15.9 rows    |
| riveted | y 100-172  | y 168-192     | 350 x 4          | 13.9 of 15.7 rows    |
| spade   | y 166-252  | y 262-304     | none             | whole line           |

The shark head is 154 rows tall and its header glass runs y 47 to y 149,
closed by a hairline at y 150: 102 rows to print in. The spade head has 219 on
a wider master. Both print at the same `cqw` type, which is a fraction of the
console's WIDTH, so a head that is proportionally shorter spends more of
itself on every line: the shark 1.66x the spade, the riveted 1.21x. The
overlap is almost exactly proportional to that ratio, which is what says this
was never three separate mistakes. It is one: three zone tables were written
from the spade's numbers onto heads with different amounts of room.

Nobody ever saw it. Neither shark caller (`WaitListModal`, and the two shark
sections of `ClubAdvertisePage` from #5083) passes a subtitle, and neither do
the three riveted ones (`CashierModal`, `TimeBankStoreModal`,
`UnionWalletModal`). The agent who rebuilt `ClubAdvertisePage` met it, dropped
the subtitle and recorded it in
[`2026-09-22-advertise-on-the-console.md`](./2026-09-22-advertise-on-the-console.md)
rather than editing a shared file while other agents were in the tree.

## What a band actually has to hold

The zone is not the text. `.sc-zone` sets `overflow: hidden`, and the measured
behaviour at 393px is that the line sits from the TOP of its zone as soon as
its line box is taller than the zone, and is centred otherwise. So a band
shorter than the ink cuts the letters, and shrinking a band whose line box
already fits moves the text unless the band's CENTRE is kept.

Measured on the rendered page, the ink of one line reaches this far below the
band's top, as a multiple of the font size:

| line     | line-height | ink reaches | why                                        |
| -------- | ----------- | ----------- | ------------------------------------------ |
| title    | 1.2         | 0.98        | caps plus the engraved bevel under them    |
| eyebrow  | 1.6         | 1.05        | half a line of leading sits above the caps |
| subtitle | 1.6         | 1.10        | same, at a smaller size                    |
| pill     | 1.6         | 1.10        | same                                       |

The shark's 22-row subtitle band needed 25.8 and the riveted's 24 needed 25.7.
That is the second half of the defect, and the reason "move the band down" was
not on its own a fix.

## What changed

Each family now has a two-line head and a three-line head, chosen the same way
the title already steps aside for a pill. **Without a subtitle nothing moved:
the `eyebrow` and `title` bands every live surface renders in are byte for
byte what they were.** With a subtitle, all three lines go to bands measured
against the glass and the stack is centred in it.

```
SHARK      glass y 47-149            RIVETED    glass y 67-190
  two line   eyebrow  y 50  h 26       two line   eyebrow  y 72  h 26
             title    y 76  h 66                  title    y 100 h 72
  three line eyebrow  y 46  h 21       three line eyebrow  y 76  h 21
             title    y 67  h 51                  title    y 97  h 51
             subtitle y 118 h 31                  subtitle y 148 h 31
```

Rendered ink, measured off the screenshots in master pixels:

| head            | eyebrow   | title       | subtitle            |
| --------------- | --------- | ----------- | ------------------- |
| shark, before   | 56.9-69.9 | 89.5-127.8  | 136.2-146.4 (cut)   |
| shark, after    | 53.2-66.2 | 78.3-116.6  | 126.8-142.7 (whole) |
| riveted, before | 78.8-91.8 | 115.9-151.2 | 176.2-190.1 (cut)   |
| riveted, after  | 82.5-95.5 | 104.8-140.0 | 155.8-172.5 (whole) |

The shark stack now sits at y 53.2 to 142.7, centred on 98.0 against a glass
centred on 98.0, with 6.2 rows of air above and 6.3 below and about 11 rows of
leading between lines. The riveted stack sits at y 82.5 to 172.5 against a
glass centred on 128.5.

The spade needed nothing: its head has the room, its bands already hold their
ink, and none of its rectangles intersect.

## One place decides which rectangles a head paints

Most zones in a table are alternatives. `title` is wider than
`titleBesidePill` and deliberately runs under the pill slot, because it is only
ever used when there is no pill. "Do these two rectangles overlap" is therefore
meaningless asked of the raw table and exact asked of the set a head really
paints, so `consoleHeadZones(family, { eyebrow, subtitle, pill })` returns that
set, the component prints from it, and the law reads the same function. A
selector the test derived for itself would have gone on agreeing with the
broken table for as long as nobody rendered the case, which is the whole
history of this defect.

## Proof

Rendered headless at 393px, before and after, from the kit's own harness:

- [the two broken heads, fixed](./shots/2026-09-22-console-zones-shark-riveted.jpg)
- [the callers that must not move](./shots/2026-09-22-console-zones-unchanged-callers.jpg)

Every live caller is **byte identical**, 0 changed pixels out of 786 x 1704:
`WaitListModal` with its real props, both of `ClubAdvertisePage`'s shark
sections, a riveted two-line head with `TimeBankStoreModal`'s props, and a
spade head with a subtitle. The only images that differ are the two shark
heads and the one riveted head that are given a subtitle, which is the case
being repaired.

`tests/painted-zones-never-overlap.law.test.ts` checks 3 families x 8 shapes of
head content for rectangle intersection, for bands too short for their type
(reading the sizes out of `SpadeConsole.css` rather than restating them), for
zones that run off their own slice, for the painted plates in every foot, and
for the component still printing through the selector. Mutation tested, five
ways, each restored afterwards:

| put back                                    | what the law said                                           |
| ------------------------------------------- | ----------------------------------------------------------- |
| shark subtitle y 126 h 22                   | `title ... and subtitle ... share 440 x 16 master pixels`   |
| riveted title y 100 h 72, subtitle h 24     | `... share 350 x 4 master pixels`                           |
| shark subtitle h 25, nothing overlapping    | `subtitle is 25 rows tall and its ink reaches 25.8 rows`    |
| shark subtitle y 130, running off the head  | `subtitle x 70-510 y 130-161 (head is 733 x 154)`           |
| the old inline zone choice in the component | `the head stopped printing head.title through the selector` |

## Left alone, deliberately

`RewardsSurfaceHeader` prints into `SPADE_CONSOLE_ZONES` itself instead of
through the console, using `title` (the wide one) beside a `pill`. On the
spade those two do not intersect (x 100-640 against x 673-870), so it is not a
defect, and routing it through the component is a redesign rather than a
repair.

The riveted two-line `title` band still claims 72 rows for ink that reaches 50. It is correct, it is live, and narrowing it would move nothing; the band
that needed the rows back was the three-line one, and that is the one that got
them.
