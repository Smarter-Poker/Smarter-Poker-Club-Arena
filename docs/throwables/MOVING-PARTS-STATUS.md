# Moving parts status

## Current state, 2026-09-08

47/47 existing non-glove rigs now have premium moving artwork integrated locally, including bear/shark and the anvil/ghost/UFO batch. The complete handoff scope is 80 unique IDs (48 original including the glove, plus 32 additions), as enumerated in COVERAGE-CATALOGUE.json. Run `node scripts/dev/throwable-coverage.mjs --write` to regenerate source inventory. File presence is not full acceptance. The glove is separate. The expanded catalogue in the handoff plan includes additional items beyond these 47, so this fraction is not overall completion. PR #3673 merged and published through Hetzner as c864fbe1acf170bbf2ad34d5022267223356e699. Both origin and public route served this SHA, and all 181 artwork files per origin matched source bytes (362 checks). Pizza is the subsequent 39th rig. PR #3682, including audio deadline follow-up 07b76db354723adb3a6ea5341b17a6da160cd1e8, merged as f0f47d31ed8d32ea401ea10ea8e81b39fbdf3025. Both production routes now report descendant 8eaf501468bb1ccc15f00a09c25944f6178841dd, containing the pizza merge; exhaustive asset verification for the newer release remains pending.

- Added heart, angry_emoji and cool_sunglasses_emoji. Independent heartbeat accents, progressive anger/shout/flames and dropping glasses/lens glint replace static landing-only behavior.
- All 40 runtime atlases are lossless WebP: 40,685,060 bytes versus 56,890,941 source PNG bytes, 28.5% smaller. Both machines verified exact alpha and visible RGB preservation for all 40. Sources are under art-source/animated, outside the public deployment tree. Production media optimization preserves verified atlas bytes.
- Selector waits for decoded, dimension-checked artwork before spending. Failed loads can retry; closing the picker cancels an uncharged intent. Player waits for cold artwork before starting its animation/audio clock. Immediate payloads no longer inherit flight audio delays.
- Receipt retry protection and removal of the post-payment client cooldown are now present in the full isolated checkout as well as this snapshot. Authenticated event receipts and shared wire identity are still pending.
- Full isolated-checkout TypeScript and all 16,346 client tests across 1,188 files pass after the picker, cutout, account-response ownership and draft-member-policy changes. After a clean merge of origin/main, full TypeScript and the production build passed at 28e81ca4 with behind-main=0. All 141 built picker thumbnails match their hashed source bytes and all 39 then-integrated atlases are byte-identical. The chicken integration subsequently passed full TypeScript, 25 focused checks and a clean production build at ee90152b with behind-main=0; all 40 built atlases and 141 thumbnail hashes match.
- All 47 approved non-glove picker stills are wired locally as 141 versioned WebP thumbnails, about 4.61 MB. Actual component browser QA covers all 47 on dark/light backgrounds, 94 decoded cutouts and no page errors. Narrow matte thresholds preserve dark bodies and cuffs. Small icons now decode the correct 192px bucket, with a real black-sphere opacity regression test.
- Live database pack-credit fix is migration 20260908021633; actual consumption timestamps are migration 20260908023324. Both were applied and live source/privileges verified. Synthetic local PostgreSQL checks total 28. The 30-member monthly allowance was applied as 20260908040103; its live function hash and unchanged execute privileges were verified. VIP 500 and Lifetime unlimited behavior remain covered. The file was renamed from its reserved draft version to match the returned production ledger version.

All original non-glove rigs are now integrated locally. Additional catalogue: 32 items; full scope remains 80 including the separate glove. Bear/shark animation sources passed 63 focused checks, full TypeScript and browser speed/reduced-motion checks, but their organic sound, bear vein mark and final morsel review remain pending. Also pending: added plan catalogue; final fringe/crop and organic/voice audio review; server item entitlements; authenticated receipt transport; real purchase/multiplayer/device/Safari tests; final full-repository gates for future batches; pizza CI/publication and deployed SHA verification.

Publication route: user clarified the Club Arena-to-Hetzner destination and continued the release. Standard branch push succeeded, pre-push hooks ran without bypass, and autopilot merged PR #3673. CI run 34186048786 passed all applicable jobs; publisher run 34186369801 delivered the verified release. The earlier upload approval blocker is resolved. Follow CI/autopilot and publish-club-arena.yml; no manual merge or alternate publisher.

## Latest reliability fixes

Audio response and body reads now have ten-second deadlines per container, permitting AAC fallback and a later retry after a stalled request. Six audio lifecycle tests and 37 combined audio/grammar/class-resolution checks pass with full TypeScript. The unused static pepperoni class that failed initial CI was removed; no gate budget was raised.

Production pack expiry is rechecked using actual time when the credit is consumed, including after a row-lock wait. A credit expiring during that wait yields to the next valid pack before diamonds. Migration 20260908045142 is applied; MD5 9db52098a228a7be9f9c89ed5bf122a0; anonymous execute denied, authenticated allowed. PR #3688 carries the matching migration and 28-check PostgreSQL evidence, pushed as dbacf9e3fc8317c54c5319ec10e555f9a5b9344d. PR #3688 merged into main as bfb4c5a2e1.

## Latest visual sequence: Pizza

Face-down impact, sliding smear, stretching cheese tether, peel at 2200 ms, falling slice and cheese drop, pepperoni remaining on the forehead. Genuine transparent RGBA source replaces two rejected checkerboard outputs. 32 focused checks, 11 browser captures and 15 speed samples passed, with zero reduced-motion animations or page errors. Bespoke cheese and peel audio remain pending; an existing packaged wet impact cue plays.

## Previous visual sequence: Chicken

Chicken uses four authored poses: landing pop, downward peck, four head-up bobs, wide-beak cluck and four half-open ending bobs. The source sheet is unchanged and losslessly encoded. Recorded cluck/bawk sounds remain pending; only the packaged landing pop plays. The four newest sequences together passed 60 normalized-speed samples at 0.5/1/2, 44 beat/scale captures, zero reduced-motion animations and zero page errors. The payload-and-cue preview decodes 12 audio containers. This is not an authenticated table-flow test.

## Previous three sequences

Laugh rocks through eight finite laugh cycles and emits independent tears. Cry moves from sad to trembling to sobbing, with descending drops and an expanding water puddle. Doge flies as glasses, pops as a bare head, slides glasses back on, and reveals a rotating sunburst. The existing transparent sheets are used; two new Doge extraction attempts produced opaque checkerboards and were rejected. Recorded laugh, cry and bespoke Doge music remain pending. These are visual integrations, not complete sound signoff. 58 specification/asset/darkroom tests pass; 33 beat/scale captures and 45 normalized speed samples pass, reduced-motion animations are zero.

## Historical progress log

The entries below describe earlier checkpoints. Their counts, PNG paths, environment limitations and test totals are historical; the current state above supersedes them.

## Source artwork

47 non-glove animation part sheets generated. The approved user glove pair remains the reference. MOVING-SOURCE-INVENTORY.json records source paths and review state. An alpha channel alone does not prove a usable transparent background: pizza and snowman still have visible background contamination. Star, bomb, rose and doge need spacing/separation correction. Other sheets still require final part-by-part edge and identity review. Rejected correction attempts are preserved in generated_images, not shipped as runtime assets.

## Local code changes

- Beer: premium mugs, foam plume and independently animated foam droplets.
- Banana: premium projectile, impact flash and peel hat.
- Trophy: premium trophy, forming pose, spotlight and sparkle.
- Water gun: premium gun, moving jet, splash face and droplets.
- AtlasSprite renders authored source rectangles without changing source pixels.
- Player sizing now targets direct child SVGs. The previous descendant rule overrode atlas viewport dimensions and exposed neighboring sprites; browser inspection caught and verified the fix.
- ThrowableImage remounts internal image state on item/size changes, preventing old cutouts and exhausted fallback ladders from leaking into a reused cell.
- Darkroom copies each atlas once per generation, includes target replay controls, and retains exact-beat snapshots. No runtime timers were added to rigs.
- Raster prohibition updated to reflect the user's explicit premium-art request; timing, speed, overlay isolation and reduced-motion requirements remain.

## Verification

51 specification, choreography and darkroom tests pass. One additional image-identity regression test passes. Four live target replays rendered and cleaned up without page errors. 43 beat/size captures generated and selected key states visually reviewed. The full application TypeScript check fails because this partial snapshot lacks unrelated imported modules; a full app build is not verified.

## Still required

- Finish all remaining 37 non-glove runtime art integrations and remaining legacy choreography upgrades.
- Correct background contamination, clipped effects, overlapping parts, and remaining pose/content issues before integration.
- Verify asset preload behavior, network budget, dimensions, simultaneous throws and reduced motion with the full application.
- Review animation geometry against approved art, not just old vector geometry; the ten local rigs are not a completed visual sign-off.
- Finish picker artwork replacement, voice clips, sound review and complete multiplayer/purchase/browser flows.
- Complete receipt transport authenticity/catalog gating/shared event identity work documented in the handoff audit.
- Recover a complete current checkout and reconcile upstream changes before publishing.
- Push/publish remains blocked: automatic approval review rejected uploading private source to Smarter-Poker/Smarter-Poker-Club-Arena and required explicit destination confirmation. Do not bypass via another transport.

No changes in this checkpoint are claimed pushed, merged, deployed or published.

## Continuation: Six Additional Rigs

Tomato, cracked egg, champagne, cash stack, cake and poop now use premium atlas art throughout their visible moving parts. Tomato has burst and settled poses, separate stretching drips and pulp chunks. Egg has a yolk cap, shell halves and individually growing white drips. Champagne has an opening cork, foam jet, spray and two clinking flutes. Cash has premium notes and independently animated wings. Cake retains the approved chocolate/cream/cherry identity through plate slide and residue. The splat gag has a sculpted swirl and separate material droplets.

A second shared rendering defect was found visually: nested SVG images enlarged parent geometry despite clipping, corrupting fill-box pivots. AtlasSprite now uses a bounded foreignObject with an atlas background. Browser captures show beer and champagne meeting correctly. Solid props preserve aspect ratio; explicitly authored liquid drips can stretch.

Validation: 52 specification/choreography/darkroom/image-identity tests pass. Strict targeted TypeScript passes. Six new rigs have matching normalized poses at speeds 0.5, 1 and 2, and zero active CSS animations under reduced motion. 69 new beat/size captures and refreshed captures of the original four were made. This is local Chromium validation, not a production Safari/mobile or multiplayer sign-off. The video is silent visual playback only; it does not validate audio.

The shared atlas still assumes 1254 x 1254 sheets. Do not integrate a differently sized sheet without extending metadata. Asset preloading/network failure behavior is still a required production gate. No newly named audio cues were added. Organic character cues absent from the audio manifest remain a blocker for those complete character rigs.

Publishing status is unchanged: no code or new artwork from this checkpoint has been pushed or deployed. Preserve the prior automatic approval rejection and do not bypass it.

## Next batch: trash can and horseshoe

12 of 47 non-glove rigs integrated locally; 35 remain. Trash can uses independent metal body/lid, upright 2-clubs/7-diamonds, bubble and buzzing flies. Lid remains inside returning-can group. Atlas silhouette clips isolate adjacent body/lid source rows and remove neighboring-image ghosts without changing CSS pivots. Horseshoe uses metal shoe, premium gold burst and corrected FOUR-leaf clover chips; supported Good Luck caption retained. Audio tracks unchanged; preview is silent and no new audio verification claimed.

52 focused regression tests pass; targeted strict TypeScript passes. Browser captured 26 beat/scale frames and confirmed normalized poses at speed 0.5/1/2, no active reduced-motion animations, no page errors. Preview: reviews/premium-moving-luck-trash/two-animations.mp4. Browser evidence: browser-validation.json in same directory. Art generation required transparency retries; selected RGBA runtime assets still require final edge polish/production asset-budget QA. Dice and rose remain pending. No push, merge, deployment or full application verification performed. Prior named-repository approval-review block remains unresolved.

## 2026-09-08: Six More Premium Integrations

18/47 non-glove rigs now integrated locally: added dice, rose, rocket, fireworks, snowman, bomb. 29 remain on legacy playback. This is not 100% complete and has not been published.

- Dice now uses held/cupped hand poses and three finite shake groups with pauses. Existing cue schedule preserved.
- Rose uses new complete transparent rose-bloom.png because the original sheet clips the full bloom. Bud, butterfly flutter and kiss-to-chin drift use the existing sheet.
- Rocket uses reticle, diving rocket with separate exhaust, impact flare, fireball and mushroom cloud.
- Fireworks uses staged blue/magenta/gold bursts, rising trails and ember stages. Magenta outer edge remains an art polish item.
- Snowman uses a new transparent sheet, powder cloud, independently falling carrot and deterministic snow clumps. Rejected checkerboard/background attempts were not shipped.
- Bomb uses independent body, fuse, flickering spark, preflash, shared approved rocket fireball and its own smoke. New sheet's cropped bottom-left explosion is deliberately unused.
- Preview builder now handles hyphenated asset names and decodes all atlas backgrounds before screenshots, rejecting missing or non-1254-square assets. Added regression coverage for the missing rose-bloom failure.

Validation: 53 focused tests pass; strict targeted TypeScript passes. 74 browser captures produced. Normalized poses agree at speed 0.5/1/2, reduced-motion animation count is zero, no page errors. Raster metadata and hashes recorded in reviews/premium-moving-six-more/asset-validation.json. Preview is silent, payload-only and not a full table/purchase/multiplayer test. No new sound assets were added or listening verification claimed.

Read-only GitHub registry check confirmed current default-branch still has the same 18 rig entries (blob 1787a1e2382bfed6a042921897a62d8512b1fc94). No repository mutation was attempted. Existing automatic approval review block remains: private-source upload to Smarter-Poker/Smarter-Poker-Club-Arena requires the named-destination confirmation previously requested. Do not bypass via another transport.

Remaining work: 29 bespoke rigs and their unprovided sounds; all premium picker assets; final artwork alpha-edge/fringe and crop QA; atlas loading/failure/performance budget; full checkout/typecheck/build; receipt retry patch, server catalog gating, authenticated event receipts and deterministic event identity; monthly allowance boundary and purchase/browser/multiplayer verification; audio listening, recorded voice lines, real devices; publish/CI/deployment verification. See prior detailed audit and plan.

## 2026-09-08: Alien, Robot, Rubber Duck and audio gate repair

21/47 non-glove rigs integrated locally, 26 still need bespoke integration. This checkpoint is not a release and has not been pushed or published.

- Alien blinks, speaks with a separate glyph bubble, changes its eyes and scans down the target with a separate ring. Added two electronic blips and a synchronized scan sweep. New alien-effects.png is transparent 1254x1254, generated from the premium bubble/ring reference using built-in image generation. Prompt: background extraction; preserve objects, remove black/olive backdrop and ring center, real alpha, square canvas, bubble above ring, no cropped objects.
- Robot uses neutral, scanning, short-circuit and power-down poses with stepped movement, jitter, ear smoke and delayed head flop. Added servo, zap and descending power-down cues. The scanner currently moves the authored head pose; independent eye-lens movement remains an enhancement.
- Rubber duck performs three squash/bounce squeaks, settles into a separate puddle, turns to a front pose and squeezes for a final squeak. Added authored rubber-toy squeak and quiet water bed.
- Restored the older audio library from the manifest's licensed sources. Fixed two incomplete local outputs by rebuilding. All 51 cue names now have both containers locally.
- Fixed a sound builder gate: previously only Opus was decoded/measured, allowing broken AAC output to pass. Now both outputs must decode and pass the audibility floor. Added a regression that corrupts AAC after an otherwise successful encoder exit and confirms rejection before metadata publication.

99 focused tests pass, targeted strict TypeScript passes. Chromium decodes all 14 new cue containers; all 102 library audio containers decode and meet the level floor via ffmpeg. Browser and audio evidence is under reviews/premium-characters. Payload/cue preview: character-animations.mp4. Existing jsdom sound-preload diagnostics are noisy but the test run has 99 passing tests. Full application and actual paid/multiplayer flow remain unverified.

Still pending: 26 bespoke moving rigs; premium picker wiring; final art fringe/crop polish; eye-lens scan refinement; missing organic and recorded voice sounds; asset loading/failure/performance work; full checkout/build; receipt retry patch publication; server catalog gates and authenticated event identity; monthly boundary, real purchases and multiplayer browser verification; listening and device QA; CI/publishing/deployment confirmation. Existing named-repository automatic approval rejection remains unresolved. Do not bypass it with another transport.

## 2026-09-08: Ten More Sequences

31/47 non-glove rigs integrated locally, 16 still pending. Added thumbs_up, thumbs_down, star, diamond, basketball, football, tennis_ball, bowling_ball, coffee, magnet. 104 focused tests pass. Native atlas dimensions and source-directed returns fixed at the renderer/player. All 124 audio containers decode and meet the level floor. See docs/changelog/2026-09-08-throwable-sports-reactions-coffee-magnet.md for exact choreography, evidence and limitations. No push or publication.

## Avatar-copy batch

Anvil, ghost and UFO use read-only target-avatar copies scoped to their own table. Only these rigs request readback. Disabled avatars are not invented, srcset currentSrc is preserved, and an unavailable or tainted canvas does not break the real seat. The originals, cards, stacks and actions are never mutated. Anvil slams with dust and a flatten/pop gag; ghost passes twice and chills the copy; UFO lifts and shrinks the copy into its beam and returns it after departure.

77 focused checks, full checkout TypeScript, 29 browser captures and 45 normalized speed samples passed. Reduced motion leaves zero animations and the harness reports no page errors. The new anvil source is real RGBA (SHA256 b2c1c6edadf5134a62152c0f0033afb4d3c7816750f49c968115009e951a5a08); the generated RGB checkerboard attempt was rejected. Bespoke sound acceptance and full authenticated device flows remain pending.

Bear/shark PR #3696 merged as b07947266fb79601a720d0a51d2588898de88f46. Anvil/ghost/UFO publication is not yet verified.

## Final original rig batch

Skull, lightning and eight ball are integrated, and bear now has its sculpted anger mark. The successful use request ID travels in optional CHAT payload metadata and is passed to the rig; the legacy message string is unchanged. Receiver authorization is not supplied by an ID and remains pending. Full TypeScript and 165 focused checks passed; 44 new captures and 60 speed samples cover the four affected rigs. PR #3699 merged as 7fa4ddea203bdba3c605ee1e3025d97b73e48bb4. Final-original batch publication is not yet verified.

## Expanded catalogue: fish

Fish expands the enabled catalogue to 49 items: 48 original IDs including the separate glove plus one of the 32 additions. Its premium atlas and standalone still feed three fingerprinted thumbnails and the shared atlas URL pipeline. The performance has a silent impact, diagonal rest and alternating flop poses, two timed sweeps, a temporary red mark, and a rotating slide with a final fade. The existing allowance RPC applies; fish is free-tier access, not unlimited usage. Dedicated recorded flop audio remains pending.

71 focused tests and full TypeScript passed. All 13 preview frames were visually reviewed, with 15 normalized speed samples, no reduced-motion animations and no page errors. Inventory tests now accept actual local delivery files alongside the historical storage listing, and require rig/CSS/audio registration for the expanded item rather than inventing a legacy signature. There are 31 additions still without integrated rigs. This is not 100 percent acceptance.
