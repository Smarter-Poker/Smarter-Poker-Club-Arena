---
description: Table UI design reference for Club Arena poker tables
---

# 🎰 Table Design Specification

Reference image: `/Users/smarter.poker/.gemini/antigravity/brain/9defb580-9a41-4a2c-a372-4094bf6de732/uploaded_media_1769284438824.png`

## Layout Requirements

### Table Shape

- **Vertical oval table** (portrait orientation)
- **Ornate gold/bronze border** with decorative rail
- **Dark felt interior** with subtle gradient
- **Aspect ratio**: ~1:1.4 (taller than wide)

### Player Seats (9-max)

- **Hero at bottom center** (Seat 1)
- **Large character avatars** that extend OUTSIDE the table edge
- **Player info boxes** below/beside each avatar:
  - Player name (e.g., "Villain 4", "Hero")
  - Stack size in BB (e.g., "45 BB", not chip amounts)
  - Gold/amber border boxes

### Seat Positions (clockwise from hero)

1. **Seat 1 (Hero)**: Bottom center - 50%, 95%
2. **Seat 2**: Bottom left - 20%, 85%
3. **Seat 3**: Left side - 8%, 60%
4. **Seat 4**: Upper left - 15%, 30%
5. **Seat 5**: Top left - 30%, 10%
6. **Seat 6**: Top center - 50%, 5%
7. **Seat 7**: Top right - 70%, 10%
8. **Seat 8**: Upper right - 85%, 30%
9. **Seat 9**: Right side - 92%, 60%

### Table Center

- **Pot display** near top: "POT 0" badge
- **Game info** in center: "Blind vs Blind" + "Smarter.Poker"
- **Dealer button** (D) visible near relevant seat

### Hero Display

- **Hole cards displayed NEXT to hero avatar** (not on table)
- Cards should be large and visible (A♥ K♥ style)

### Action Panel (Bottom)

- **2x2 button grid**:
  ```
  [ Fold ]     [ Call ]
  [Raise 8bb]  [ All-In ]
  ```
- Blue for Fold/Call, amber for Raise/All-In
- Full width buttons with rounded corners

### Header Bar

- Back button
- App title ("Smarter.Poker")
- Chips count with + button
- XP / Level display
- Profile, Messages, Notifications, Settings icons

### Context Banner (Optional)

- Below header
- Shows game situation: "You Are On The Button. The Player To Your Right Bets 2.5 BB..."

## Color Scheme

- **Background**: Dark navy (#0A0A1A)
- **Table felt**: Dark green gradient
- **Rail**: Gold/bronze metallic
- **Player boxes**: Amber/gold border (#D4A84B)
- **Action buttons**: Blue (#1E3A5F) and Amber (#D4A84B)
- **Text**: White primary, gray secondary

## Avatar Style

- **Large character illustrations** (not photos)
- Fantasy/game style (wolves, dragons, lions, kings, etc.)
- Avatars should be ~80-100px and extend above table edge
- Variety of characters per player
