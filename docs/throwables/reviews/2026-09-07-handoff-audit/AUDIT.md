# Throwable handoff audit, 2026-09-07

Status: INCOMPLETE. Artwork revisions are not final acceptance of the entire set.

Source inventory: 48 catalogue IDs, 18 registered rigs, 30 legacy items. The handoff counted 47/29 because it omitted `magic_8_ball`. The service header also says 49; neither prose count is the inventory. This audit uses actual T(...) calls and registry entries.

The current requirement covers the picker, flight, impact, residue and fallback surfaces. All 48 picker entries still use the old ThrowableImage pipeline. Its final fallback is a generic glyph. None of the rows below means that every surface has been replaced.

| ID                      | Playback | Artwork revision evidence                             | Picker replacement |
| ----------------------- | -------- | ----------------------------------------------------- | ------------------ |
| `thumbs_up`             | Legacy   | Pending bespoke replacement                           | Pending            |
| `thumbs_down`           | Legacy   | Pending bespoke replacement                           | Pending            |
| `laughing_emoji`        | Legacy   | Pending bespoke replacement                           | Pending            |
| `crying_emoji`          | Legacy   | Pending bespoke replacement                           | Pending            |
| `angry_emoji`           | Legacy   | Pending bespoke replacement                           | Pending            |
| `cool_sunglasses_emoji` | Legacy   | Pending bespoke replacement                           | Pending            |
| `heart`                 | Legacy   | Pending bespoke replacement                           | Pending            |
| `star`                  | Legacy   | Pending bespoke replacement                           | Pending            |
| `tomato`                | Rig      | Pending material revision                             | Pending            |
| `cracked_egg`           | Rig      | Pending material revision                             | Pending            |
| `banana_peel`           | Rig      | Pending material revision                             | Pending            |
| `pizza_slice`           | Legacy   | Pending bespoke replacement                           | Pending            |
| `cake`                  | Rig      | This patch: 24 combined beat/size frames, zoom review | Pending            |
| `poop`                  | Rig      | Pending material revision                             | Pending            |
| `water_gun`             | Rig      | Pending material revision                             | Pending            |
| `boxing_glove`          | Legacy   | Pending bespoke replacement                           | Pending            |
| `anvil`                 | Legacy   | Pending bespoke replacement                           | Pending            |
| `trash_can`             | Rig      | Pending material revision                             | Pending            |
| `snowman`               | Rig      | Pending material revision                             | Pending            |
| `magnet`                | Legacy   | Pending bespoke replacement                           | Pending            |
| `basketball`            | Legacy   | Pending bespoke replacement                           | Pending            |
| `football`              | Legacy   | Pending bespoke replacement                           | Pending            |
| `tennis_ball`           | Legacy   | Pending bespoke replacement                           | Pending            |
| `bowling_ball`          | Legacy   | Pending bespoke replacement                           | Pending            |
| `horseshoe`             | Rig      | Pending material revision                             | Pending            |
| `dice`                  | Rig      | Second material pass, PR #3494                        | Pending            |
| `magic_8_ball`          | Legacy   | Pending bespoke replacement                           | Pending            |
| `beer`                  | Rig      | First material pass, PR #3490                         | Pending            |
| `champagne`             | Rig      | Pending material revision                             | Pending            |
| `coffee`                | Legacy   | Pending bespoke replacement                           | Pending            |
| `cash_stack`            | Rig      | This patch: 24 combined beat/size frames, zoom review | Pending            |
| `diamond`               | Legacy   | Pending bespoke replacement                           | Pending            |
| `rose`                  | Rig      | Second material pass, PR #3494                        | Pending            |
| `trophy`                | Rig      | First material pass, PR #3490                         | Pending            |
| `fireworks`             | Rig      | Pending material revision                             | Pending            |
| `bomb`                  | Rig      | Second material pass, PR #3494                        | Pending            |
| `rocket`                | Rig      | First material pass, PR #3490                         | Pending            |
| `ufo`                   | Legacy   | Pending bespoke replacement                           | Pending            |
| `alien`                 | Legacy   | Pending bespoke replacement                           | Pending            |
| `robot`                 | Legacy   | Pending bespoke replacement                           | Pending            |
| `ghost`                 | Legacy   | Pending bespoke replacement                           | Pending            |
| `skull`                 | Legacy   | Pending bespoke replacement                           | Pending            |
| `lightning_bolt`        | Legacy   | Pending bespoke replacement                           | Pending            |
| `doge`                  | Legacy   | Pending bespoke replacement                           | Pending            |
| `shark`                 | Legacy   | Pending bespoke replacement                           | Pending            |
| `bear`                  | Legacy   | Pending bespoke replacement                           | Pending            |
| `chicken`               | Legacy   | Pending bespoke replacement                           | Pending            |
| `rubber_duck`           | Legacy   | Pending bespoke replacement                           | Pending            |

## Handoff requirements

| Requirement                              | Verified result / remaining work                                                                                                                                                                                                                                                                                                 |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Original 18 rigs wired                   | Registry resolves all 18. No new rigs added in these material passes.                                                                                                                                                                                                                                                            |
| Art upgrade for all original rigs        | Eight revised; ten still need the new material pass. All picker artwork remains pending. Renders are dimensional SVG, not actual 3D models.                                                                                                                                                                                      |
| Remove all legacy representations        | Pending for 30 IDs above. Legacy engine and signatures must remain until their replacements are working.                                                                                                                                                                                                                         |
| Phase 3                                  | Character/face rig and reference performances are pending. The old plan says 14 emoticons but lists 15 table rows, including six existing IDs. Use the explicit names, not stale totals.                                                                                                                                         |
| Phase 4                                  | Remaining object rigs, including magic_8_ball, and retirement of legacy engine are pending.                                                                                                                                                                                                                                      |
| Phase 5                                  | Current 500/month active VIP, Lifetime unlimited, credit-first and one-diamond usage rules were checked in rollback database probes (separate live-verification changelog). The planned new ownership catalogue, item-specific VIP/premium gates, store shelf, purchases and seasonal items are NOT implemented by those probes. |
| Browser commerce                         | Authenticated purchase -> inventory -> throw -> remote recipient playback is pending. Lost-response request identity, 500/501 boundary and multi-client race/browser checks remain pending.                                                                                                                                      |
| Phase 6                                  | 44 existing cues / 88 codec files downloaded and probed. That does not cover future characters, voices, final loudness/listening or real-device performance.                                                                                                                                                                     |
| voice_good_luck                          | Missing recorded voice source. Not added as a nonexistent cue. Other planned voice lines also remain pending.                                                                                                                                                                                                                    |
| Cue builder --only credits bug           | Fixed here: attribution comes from the entire manifest; selection only limits encoding. Four isolated CLI tests cover retention and invalid selections.                                                                                                                                                                          |
| Darkroom CLI and sound cancellation      | Fixed in PR #3494. CSS/audio/player speed captured together; cancellation and AAC fallback have tests.                                                                                                                                                                                                                           |
| New Cash Stack defects                   | Fixed here: invisible landing bundle and premature bill emission. Browser assertions cover landing/settle, burst, cut and reduced motion.                                                                                                                                                                                        |
| Trophy frame 2602/2603                   | Known 33 ms reference ambiguity remains documented; not silently clamped to change the flight floor.                                                                                                                                                                                                                             |
| Sentry                                   | Direct reporting removed from throwable entry points in merged PR #3490; no new reporting added.                                                                                                                                                                                                                                 |
| Historical Mac ffmpeg/disk/Linux defects | This environment is a Linux partial source snapshot, not the old Mac worktree. Those machine-specific problems are not claimed repaired. ffprobe and Chromium run here.                                                                                                                                                          |
| Publication                              | PR #3494 merged as f53c1a4763bb035f62e2a29c55a2db0d29ccec4d; all its PR workflows passed. Production read during this audit returned a9b7697172fa9cd4388329249879d7c6cb20823f, so the follow-up is not yet production verified. This patch needs its own CI/merge/publication.                                                   |

## Named future items, not hidden in headline counts

Reference additions not in the current catalogue: rat_card (the plan mentions mouse_card, which the current catalogue does NOT contain), donkey, fish, party_face, loser_hand, thinking, blush, ok_smug, sleeping, facepalm, screaming, vomit_rainbow, surrender, energy_ball, sloth. Keep the existing rocket wire ID for the missile performance. Do not introduce aliases only one client understands.

VIP/store additions: crown, chip_rain, diamond_shower, velvet_rope, champagne_tower, standing_ovation, whale, to_the_moon, tilt_meter, bad_beat_bandage, bubble_boy, slot_machine. Seasonal: pumpkin, snowball, party_popper, heart_arrow. These are in addition to ownership/gating work for existing and reference items.

## Evidence and limits

`contact.jpg` contains all 24 Cake/Cash Stack beat and rung frames after fixes. `cake-zoom.jpg` and `cash-stack-zoom.jpg` are browser renders enlarged 3x. `browser-check.json` records computed visibility and clean-cut assertions. Visual review confirms distinct silhouettes and material detail, but this is not a reference-video comparison or approval of every item.

The attached handoff was read in full. This file is a completion inventory, not a claim of a completed line-by-line audit of the entire repository. Full build and whole-suite validation require CI because the local workspace contains only an API-materialized subset of the repository. No hooks or guards were bypassed.
