# tests/an-asset-never-ships-a-white-matte.law.test.ts

A painted shell is cut out against transparency. Several were exported with
their glow rendered as WHITE instead - a smooth neutral ramp at full alpha
sitting outside the frame, with a torn dashed edge where the export clipped
it. The top of a plate looked correct because the art was cropped flush
there, so the fault only showed on the bottom and sides, and it shipped.

Four plates were cleaned by hand on 2026-09-10: `club-nav-shell` (12.7% of
its opaque pixels were matte), `wallet-row-shell` (3.0%),
`club-utility-shell` (2.8%) and `wallet-agent-wallet-square-v1` (0.6%).
Nothing stopped the next export from putting it straight back.

`scripts/art/check-asset-matte.mjs` runs on every pull request. It is a Node
port of `scripts/art/clean-shell-matte.py` - the Python remains the authority
and is what actually cleans a plate; the port exists because the gate has to
run on a CI runner, which has node and `sharp` but no numpy and no Pillow.

## It records a baseline; it does not apply a threshold

The obvious gate - fail any asset the detector wants to cut - was measured
against the corpus before it was written, and it does not work. Of 148 assets
under `public/assets`, 115 read exactly 0.0% and 142 read under 0.5%; all six
above that floor are the detector eating ARTWORK, each confirmed by opening
the before and after:

| asset                                              | reads | what cleaning it actually does                                                                                               |
| -------------------------------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------- |
| `club/club-identity-icon-club-v1.png`              | 7.8%  | slices the pediment, a column and the plinth off the silver temple; re-checking the cleaned copy reads 12.0%, so it diverges |
| `console/spade-console-v1/mid.png`                 | 4.2%  | deletes 5 whole columns of a 1000x8 tiling rail - five transparent slits once tiled                                          |
| `club/club-identity-icon-player-v1.png`            | 2.8%  | chews the head outline and the shoulder bevel. This one converges (0.1%), which is why convergence alone is not the test     |
| `plo/shark-four-bay-v1/live-dot.png`               | 0.7%  | 23 pixels of mean luminance 20 - dark glow, not white matte                                                                  |
| `wallets/mobile/wallet-union-bank-v1.webp`         | 0.6%  | 3780 bright silver pixels, none within 4px of the border - frame highlights. A matte hugs the edge                           |
| `wallets/square/wallet-promo-wallet-square-v1.png` | 0.5%  | on the floor and under the cleaner's own threshold, so nothing is written                                                    |

So the reading is not a verdict. A reading that RISES is. A plate that reads
0.0% today and 12.7% after an export has had the matte put back, and no
judgement is needed to say so. `docs/art/matte-baseline.json` records every
reading at or above the floor, with the reason it is there, and the build
fails when a reading exceeds what is recorded.

The consequences are deliberate: no false failures on the corpus as it
stands, the regression that shipped cannot return silently, and a legitimate
re-export has to run `--update`, which puts the change in the diff where a
human reads it.

## Scope

`public/assets/**` only - the #ClubArenaConsole master art, where this
happened. `public/cards` is the clearest reason not to widen it: a card face
is a large smooth neutral white rectangle, so the detector reads the seven of
diamonds at 81.6%. Those 681 files are a different pipeline and about ninety
seconds of scanning, and the gate is not for them.

## What is pinned

- the detector's four decisions: dark art is never matte, a plate that is
  nothing but matte goes to nothing, the flood stops at the first structured
  pixel, and a blue bevel is never neutral;
- the gate's arithmetic, including the real 12.7% regression;
- that every baseline entry names a file that exists and carries a reason
  saying what was looked at;
- that the Node port and the Python agree, on three real assets.
