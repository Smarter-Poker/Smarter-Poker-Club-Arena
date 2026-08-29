The core problem is now clear:
The Button Builder was given two jobs that should never have been combined:

1. Build the #ClubButtons factory
2. Migrate the products to #ClubButtons
   That caused it to start applying an immature component system to World Hub, Commander, and global navigation before you had visually approved the factory itself.
   The technical foundation is useful. The visual system is not approved.
   Do not throw everything away.
   Also do not continue migrating Club Arena.
   We should preserve the good architecture, stop the bad rollout, rebuild the visual component factory properly, visually approve it, and then migrate each application separately.
   Some useful foundation work is already merged:

- Club Arena #1524, the #ClubButtons foundation/BBJ work, is merged.
- Shared controls #37 are merged.
  But product migrations have also already been merged:
- World Hub #896 is merged.
- Commander #71 is merged.
  And utility/navigation shell PR #1527 is still open.
  So we need a controlled recovery, not another giant migration prompt.
  Right now:
  Do not run the Club Arena Pass 1 prompt.
  Do not run gameplay Pass 2.
  Do not let Button Builder modify World Hub, Commander, Club Arena production screens, or global headers any further.
  Do not merge #1527 yet.
  Button Builder's only job from this point should be:
  Build and visually prove the component factory.
  Nothing else.
  I would preserve these pieces because they are fundamentally correct:
- CLUB_BUTTONS_MASTER_SPEC.md
- Reference repository
- Asset manifest
- Live-content architecture
- Semantic buttons/inputs
- Dynamic data regions
- Tabular numerals
- Accessibility work
- Loading/error/stale states
- Mobile breakpoint architecture
- Product-mode concept
- /dev/club-ui
- Tests
- Hyper-realistic-shell + live-content architecture
- Stack-safe wallet concept
  The master specification already documents the correct hybrid architecture:
  static hyper-realistic shell + live React content + semantic HTML + state overlays + application state.
  That part was right.
  The problem was the artwork/component execution.
  This is one of the biggest lessons from what happened.
  The giant overview sheet is useful for:
- What components exist
- Shape-family ideas
- Mobile concepts
- State coverage
- Architecture
  It is not detailed enough to be the final production reference for each control.
  The BBJ and individual wallets are the actual quality bar.
  So Button Builder now needs full-size master references for every major component family.
  Not tiny versions inside one giant board.
  For example:

```
01 BBJ Hero
02 Wallet Row

03 Primary Action
04 Secondary Action
05 Compact Action
06 Danger Action

07 Chat Utility
08 Stats Utility
09 Time Bank Utility
10 Rabbit Hunt Utility
11 Previous Hand Utility
12 Menu Utility

13 Top-Level Navigation Assembly
14 Sub Navigation / Tabs

15 Value Display
16 Status Badge

17 Modal
18 Information Panel

19 Input
20 Select
21 Toggle
```

Each should be designed large enough to show the same depth/material detail as the BBJ.
This should now be the #1 rule:
The current World Hub header failed because it essentially became:

```
[ SAME LONG FRAME ]
[ SAME LONG FRAME ]
[ SAME LONG FRAME ]
[ SAME LONG FRAME ]
[ SAME LONG FRAME ]
```

with different icons and labels.
That is not the vision.
A better top navigation might be:

```
╔══════════════════════════════════════════════════╗
║ HOME │ COACH │ FRIENDS │ PAGES │ ALERTS │ PROFILE ║
╚══════════════════════════════════════════════════╝
```

as one manufactured navigation console, where each segment belongs to the same physical assembly.
The utility buttons should also vary.
For example:
Chat could look like a compact communications module.
Stats could resemble a miniature instrumentation panel.
Time Bank could be built around a timer/dial concept.
Previous Hand could use directional mechanical geometry.
Menu could resemble a compact control switch.
Same chrome.
Same gunmetal.
Same black glass.
Same blue energy.
But not the same shape.
This was another major turning point in our discussion.
There is no reason Codex needs to fake the entire BBJ quality in CSS.
The correct production component is:

```
HYPER-REALISTIC TEXTLESS SHELL
             +
LIVE ICON
             +
LIVE LABEL
             +
LIVE VALUE
             +
REAL HTML BUTTON
             +
REAL HANDLER
```

For something like:
Club Bank $1,376,644.87
the hyper-realistic artwork contains:

- Chrome
- Gunmetal
- Crystal details
- Black glass
- Bevels
- Shadows
- Texture
- Mechanical construction
  But:
  CLUB BANK
  and:
  $1,376,644.87
  remain live DOM content.
  That is how we keep the quality.
  This separation needs to become permanent:

```
                 BUTTON BUILDER
                      │
             Builds + Approves
                      │
                      ▼
             #ClubButtons System
                      │
        ┌─────────────┼──────────────┐
        ▼             ▼              ▼
   CLUB ARENA      WORLD HUB     CLUB COMMANDER
     AGENT           AGENT           AGENT
```

Button Builder does not migrate the applications.
The application agents do.
That was the architectural mistake earlier.
This still needs to be cleaned up.
Right now, there is a Club Arena implementation and a shared implementation. The implementation plan itself describes proving things in Club Arena and then moving them to shared code.
I do not want that to remain two independent sources permanently.
There should ultimately be one canonical source, conceptually something like:

```
@smarter-poker/club-ui
```

containing:

```
/assets
/tokens
/icons
/components
/styles
/spec
```

Then:

```
Club Arena adapter
World Hub adapter
Club Commander adapter
```

may exist if necessary, but those adapters must be thin.
If creating a neutral package is too disruptive right now, the existing shared package can temporarily serve that role.
But Button Builder must document exactly which implementation is canonical before migration resumes.
Because you have already visually seen the World Hub/global navigation implementation and you don't like it, I would remove those application integrations.
I would not wipe the underlying Button Builder foundation.
Specifically, I would have the agent inspect:
World Hub PR #896, already merged.
Commander PR #71, already merged.
and create targeted rollback PRs for the product-level navigation integration if those PRs are responsible for the generic UI you're seeing.
Keep:

- Shared package
- Tests
- Specifications
- Button Builder asset infrastructure
  Remove:
- Premature application usage of the generic components
  This gets World Hub and Commander back to their pre-migration look until the real factory is ready.
  I would not blindly revert anything automatically. First have the agent identify exactly what #896 and #71 changed.
  PR #1527 adds the utility and navigation shells. Its description shows exactly the strategy that produced these generic forms, such as a single square utility shell and a single connected navigation shell.
  Do not merge it as-is.
  It should be reworked after we establish the new purpose-specific component masters.
  This should become the centerpiece.
  Button Builder should produce a standalone visual laboratory.
  I want you to be able to open one page and see:
  Primary Secondary Compact Danger
  Chat Stats Time Bank Rabbit Hunt Previous Hand Menu Add Settings
  Wallet row Treasury row Jackpot Value display
  Top-level navigation assembly Tabs Subnavigation
  Modal Panel
  Input Select Toggle
  For each:
  Desktop
  Mobile
  Default
  Hover
  Pressed
  Selected
  Disabled
  Loading
  And live-value stress tests.
  I would change one requirement from our earlier workflow.
  Codex does not need to be the final judge of visual quality.
  You should be.
  The process becomes:

```
Codex builds /dev/club-ui
       ↓
Vercel Preview
       ↓
You open it
       ↓
You screenshot it
       ↓
We review it here
       ↓
Changes
       ↓
Approve
```

That solves the localhost-browser blocker too.
If Codex cannot inspect localhost, that's fine.
Deploy the Button Builder laboratory to a private/preview Vercel URL.
You inspect it manually.
We can compare its screenshots here against the references.
I would require these to be approved before Club Arena gets touched:

- Primary action
- Secondary action
- Compact action
- Danger action
- Wallet row
- Utility set
- Top navigation
- Tabs
- Value display
- Status badge
- Modal
- Panel
- Forms
  Not necessarily every edge case.
  But the major visual language must be locked.
  Only after the factory is approved:
  Migrate everything except live gameplay.
  Use the protected prompt we created.
  Order:

```
AUDIT
↓
GAMEPLAY PROTECTION BOUNDARY
↓
NON-GAMEPLAY SHARED COMPONENTS
↓
LOBBIES
↓
NAVIGATION
↓
HAMBURGER MENUS
↓
WALLETS / FINANCIAL
↓
TOURNAMENT UI
↓
MODALS
↓
FORMS
↓
MOBILE QA
↓
FINAL AUDIT
```

Live poker table untouched.
After Club Arena looks right:
Then World Hub.
After World Hub looks right:
Then Club Commander.
One product at a time.
Why?
Because if there is a fundamental flaw in the shared design system, you want to discover it in one application, not three.
Only after:

- Button Builder approved
- Club Arena non-gameplay approved
- World Hub approved
- Commander approved
  do we touch the live game screen.
  And we already created the special Pass 2 prompt for exactly that reason.
  In order:

1. Stop Button Builder from migrating anything else.
2. Do not send Club Arena the migration prompt.
3. Do not merge #1527.
4. Have Button Builder audit World Hub #896 and Commander #71 and prepare targeted rollback plans for the premature generic integrations.
5. Keep #1524 and #37 foundation work unless inspection shows a specific problem.
6. Convert Button Builder into factory-only mode.
7. Build full-size high-quality masters for each component family.
8. Build the real /dev/club-ui.
9. Deploy it to a Vercel preview.
10. Send me screenshots of that preview.
11. We visually approve/reject the component families.
12. Once approved, then start Club Arena Pass 1.
    Do not use another 50-section migration prompt.
    Send this focused directive:
    STOP ALL PRODUCT MIGRATION IMMEDIATELY. Button Builder is now factory-only. Do not make any further changes to Club Arena production pages, World Hub, Club Commander, global headers, navigation, or live gameplay. Preserve all existing work and Git history. Audit the already-merged World Hub #896 and Commander #71 migrations and report which files would need targeted rollback to restore their pre-#ClubButtons presentation without removing the shared foundation. Do not execute rollback until approved. Hold PR #1527 and do not merge it. Preserve #1524 and shared #37 unless a specific defect is identified.
    Rebuild /dev/club-ui as the sole current product. The BBJ and detailed wallet master images are the material-quality authority. The overview board is architecture-only. Eliminate the generic-frame approach. Create purpose-built, high-resolution hyper-realistic component families with distinct silhouettes under the rule SAME FACTORY, DIFFERENT PARTS. Use actual textless hyper-realistic shell artwork + live DOM content, not generic CSS frames.
    Required families before approval: Primary Action, Secondary Action, Compact Action, Danger Action, stack-safe Wallet Row, Chat, Stats, Time Bank, Rabbit Hunt, Previous Hand, Menu, top-level connected Navigation Assembly, Tabs/Subnavigation, Value Display, Status Badge, Modal, Panel, Input, Select, Toggle. Utility controls must not all share the same body. Top navigation must look like one purpose-built mechanical navigation console rather than repeated elongated buttons.
    For every family, show master reference, textless production shell, live component, desktop, mobile, and interaction states in /dev/club-ui. Keep all live values/text dynamic and semantic. Create mobile-specific shells where necessary. Establish and document ONE canonical #ClubButtons package/source that all three products will eventually consume through thin adapters.
    Deploy /dev/club-ui to an accessible Vercel preview for HUMAN visual review. Do not resume any application migration until I explicitly approve the Button Builder laboratory. Finish by returning only: preview URL, component inventory, canonical-source architecture, list of existing product migrations requiring rollback/re-migration, and #CLUBBUTTONS FACTORY READY FOR VISUAL REVIEW: YES/NO.
