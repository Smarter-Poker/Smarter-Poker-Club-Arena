---
description: Club Arena design and styling guidelines
---

# Club Arena Design Guidelines

## CRITICAL RULES

### 1. NO EMOJIS - EVER

- Never use emoji icons anywhere in the UI
- Never use emoji in button text, labels, or tooltips
- Use text labels like "ON", "OFF", "NEW" instead of symbols
- No checkmarks, X marks, or any unicode symbols

### 2. FACEBOOK COLOR SCHEME ONLY

Use Facebook's color palette for all UI components - NOT reference image colors (no gold, orange, amber).

### 3. FOOTER TEXT

Always use: "Club Engine 2026 - Smarter.Poker"
NEVER use: "PokerBros Clone", "But Better", or any PokerBros references visible to users.

---

## Color Palette

| Purpose        | Color                    | Usage                                    |
| -------------- | ------------------------ | ---------------------------------------- |
| Primary Blue   | `#1877F2`                | Buttons, active states, links, toggle on |
| Dark Blue      | `#166FE5`                | Hover states                             |
| Background     | `#0a0a1a` to `#1a1a2e`   | Gradient backgrounds                     |
| Card           | `rgba(255,255,255,0.05)` | Card backgrounds                         |
| Border         | `rgba(255,255,255,0.1)`  | Subtle borders                           |
| Text Primary   | `white`                  | Main text                                |
| Text Secondary | `#888`                   | Muted text                               |

---

## UI Components

### Toggles

- Off state: `rgba(255,255,255,0.1)` track, `#666` thumb
- On state: `#1877F2` track, `white` thumb
- Status text: "ON" or "OFF" (never symbols)

### Buttons

- Primary: `#1877F2` background, white text
- Secondary: transparent with `#1877F2` border

### Sliders

- Track: `#1877F2` for filled portion
- Thumb: `#1877F2` with dark border

### Radio/Select

- Accent color: `#1877F2`
- Selected state: Facebook blue highlight

---

## Code Reference

```css
:root {
  --fb-blue: #1877f2;
  --fb-blue-hover: #166fe5;
  --bg-dark: #0a0a1a;
  --border-subtle: rgba(255, 255, 255, 0.1);
}
```

```tsx
// CORRECT
{
  value ? 'ON' : 'OFF';
}

// WRONG - Never do this
{
  value ? '✓' : '✗';
}
```
