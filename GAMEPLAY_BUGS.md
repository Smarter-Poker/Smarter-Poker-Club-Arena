# Gameplay Bugs - Observed During E2E Testing (March 20, 2026)

## CRITICAL (Blocking Gameplay)

1. **SHOWDOWN popup overlay blocks entire table** - HoleCardReveal component renders fullscreen overlay
   - FIX APPLIED: Disabled HoleCardReveal render + SHOWDOWN_START emission in TablePage.tsx
   - STATUS: Code fixed, waiting for CDN cache to clear

2. **HandReveal "Player Won / Reveal (10)" popup** - Blocks table after uncontested wins
   - FIX APPLIED: Disabled HandReveal component render + trigger in TablePage.tsx
   - STATUS: Code fixed, waiting for CDN cache to clear

3. **Action flow skips flop betting** - Goes straight from preflop to turn
   - NEEDS INVESTIGATION: Check HandController.advanceStage() and horse think-time

4. **Action buttons don't work for live play** - Fold/Check/Raise not responsive
   - NEEDS INVESTIGATION: Check handleActionPanelAction() and action validation

## HIGH PRIORITY (UI/UX)

5. **Hero seat position** - Should always be bottom center, currently bottom-right
   - FIX: Rotate seat positions so hero seat is always index 0 (bottom center)

6. **Cards overlap player avatar** - Hole cards cover the player name/stack
   - FIX: Adjust card positioning in SeatSlot CSS to offset cards above/beside avatar

7. **No bet amounts displayed** - When players bet/call/raise, no chips shown in front of them
   - FIX: Ensure bet amounts render in SeatSlot when player.bet > 0

8. **Dealer button not visible/rotating** - Can't tell who has the button
   - FIX: Check dealerSeat state update and DealerButton render

9. **Player names generic** - "Player 2", "Player 3" instead of horse names
   - FIX: Query horse names from profiles table, not just seat number

## MEDIUM PRIORITY (Polish)

10. **Rabbit Hunt is overlay** - Should be small icon, not fullscreen
    - FIX: Change to inline icon next to community cards

11. **Active player moves/bounces** - Should just glow/highlight, not animate movement
    - FIX: Remove CSS animation on active seat, add glow border only

12. **Avatars are circles with letter** - Should show actual avatars
    - FIX: Load avatar URLs from profiles, show default avatar for horses

13. **BBJ shows 0.00** - Bad Beat Jackpot not calculating
    - FIX: Check BBJService connection to Supabase

14. **Action only on one player at a time** - Multiple seats appear active
    - FIX: Ensure currentPlayerSeat correctly updates on each turn
