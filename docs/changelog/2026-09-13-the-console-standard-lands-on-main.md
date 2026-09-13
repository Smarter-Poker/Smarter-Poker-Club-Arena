# The console standard lands on main, and the chassis gets two fixes

2026-09-13. Branch `feat/club-arena-console-standard`.

## The standard was never on main

`#ClubArenaConsole` - the document every agent is told to read before touching
a Club Arena surface, plus its scanner (`find-generic-surfaces.mjs`), its art
surgery library (`master_surgery.py`) and its render harness - existed only as
UNTRACKED files on Dan's Mac, in a clone sitting on a branch from 2026-09-03.
On no branch, on no remote. The `CLAUDE.md` pointer that names it was in that
same clone and not on main either. The kit (`SpadeConsole.tsx`, the crest
seating script, the crest recipe) HAD shipped, so main carried the parts and
not the rules for using them.

This commit puts the standard in `.claude/skills/club-arena-console/` and the
pointer in `CLAUDE.md`, at v1.1.0 with today's rulings written in.

## Two defects in the shared chassis

**Plate labels ran past their painted face.** `useFitText` shrank a label by a
ratio from one measurement; rendered width is not proportional to font-size, so
"Save Changes" on an 82.8px face rendered 87.09px and its last letter sat on
the chrome rim. It had been hit once on the header and patched there with a
per-caller `headroom` fudge that `PlateButton` never got. The hook now applies,
re-measures and corrects; the fudges are removed. Every plate on every console
surface, the lobby cards, the identity card and the masthead inherit it.

**Desktop was never built.** The chassis sizes in `cqw` with no ceiling, so a
1440px monitor got the phone card at 3.7x with the 1000px master stretched
soft. Dan's ruling: stop at the master's own width and centre. `--sc-max`.

## Rulings recorded (all 2026-09-13)

Desktop ceiling at native width. The 36 finished surfaces are audited, not
rebuilt. Rates keep one decimal. Brass `#d6ad52` is the warm accent, brand gold
`#ffd700` is for gold things, and every colour is a schema token - a darkened
copy of a brown is still not a schema colour and was reverted on sight. Frame
families may be cut from the master; every crest must match the spade's
quality, and the club, diamond and crown do not.

## The audit

`docs/audits/2026-09-13-club-arena-console-sweep.md`: 217 surfaces, 36
finished, 181 generic, 11 dead. Of the 36, sixteen carry a brown and two a
mauve, four show decimal rates. The invite page still carries the exact gold
ramp the standard recorded as replaced on 2026-09-09 - the standard was wrong
about the code. The proposed schema mapping is in §7 and is NOT applied here.

## Not in this commit

Repainting the three crests needs an OpenAI image key on the Mac (none present).
The schema colour mapping for the 16, new frame families, and the 181-surface
sweep follow on their own branches, each rendered before and after first.

## Found on the way

`check-chip-conservation` fails on live data: 289 op-id claims stranded
unfinalized over an hour. Money, not paint; nothing here touched it.
