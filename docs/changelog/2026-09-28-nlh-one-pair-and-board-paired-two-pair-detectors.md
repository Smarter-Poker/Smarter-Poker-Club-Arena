# 2026-09-28 - Three stack-off shapes get names

The 2026-09-27 audit counted 647 NLH showdown losses worse than -100bb. Of
those, 209 carried only outcome tags and 247 carried none: about 70% had no
decision-quality verdict, against 15-25% in PLO. The biggest untagged shapes
now have tags. All three are MEASUREMENT ONLY: none is in a brain leak-load
list, so no dial reads them until a league matchup says one should.

| tag                              | shape                                                                                                                                                                  | audit hands                            |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| `one_pair_river_stackoff`        | NLH, one pair of hero's own (an overpair, or one hole card pairing the board with a kicker above nine) committed on the river, unpaired board, not three-suited, 40bb+ | 736266, 752381, 738151, 743300, 753294 |
| `board_paired_two_pair_stackoff` | NLH, two pair where one pair is the board's, 40bb+                                                                                                                     | 740479, 737195, 745046, 746040         |
| `plo_paired_board_nut_stackoff`  | Omaha nut flush or nut straight lost at showdown on a paired board                                                                                                     | 756309, 755841                         |

## Where the shapes differ from the handoff

The handoff's rule for two pair ("both hole cards match two distinct board
ranks") did not match its own examples: 740479 and 737195 match one hole card
each. The shape those hands share is two pair where one pair is the board's,
which is what the tag records. 748012 (bottom two pair on an unpaired board) is
a different shape and stays untagged here.

A rag-kicker top pair (nine or worse) stays with V24's
`top_pair_weak_kicker_stackoff`. 741432 went in on a three-spade board and is
left to the flush-aware tags.

Pinned by `server/src/services/HorseLeakDetectorsNlhPairs.test.ts`.
