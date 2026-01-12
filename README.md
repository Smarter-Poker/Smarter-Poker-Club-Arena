# ♠ Club Arena

> **PokerBros Clone + Better** — Private poker clubs with agents, unions, and full game logic.

![Version](https://img.shields.io/badge/version-1.0.0-blue)
![TypeScript](https://img.shields.io/badge/typescript-5.9-blue)
![React](https://img.shields.io/badge/react-19-blue)

---

## 🚀 Quick Start

```bash
# Install dependencies
npm install

# Start development server
npm run dev

# Open in browser
http://localhost:5174
```

---

## 🎮 Demo

**Play Now:** http://localhost:5174/play

Play poker against AI opponents with:
- Real card dealing
- Proper pot calculations
- Side pot handling
- Hand evaluation (Hold'em + Omaha)

---

## ✨ Features

### 🏛️ Private Clubs
- Create and manage private poker communities
- 6-digit club IDs for easy joining
- Member roles: Owner, Admin, Agent, Member

### 🤝 Unions
- Join club networks for more players
- Cross-club tournaments
- Shared player pools

### 🎰 Poker Engine
- All game variants: NLH, PLO4/5/6, Short Deck, OFC
- Complete hand evaluation
- Side pots & split pots
- Configurable rake

### 👔 Agent System (PokerBros-style)
- Multi-tier agent hierarchy
- Chip distribution & tracking
- Commission management

---

## 🛠️ Tech Stack

| Technology | Purpose |
|-----------|---------|
| React 19 | UI Framework |
| TypeScript | Type Safety |
| Vite 7 | Build Tool |
| Zustand | State Management |
| Supabase | Database & Auth |
| Framer Motion | Animations |

---

## 📁 Project Structure

```
src/
├── components/     # Reusable UI components
├── pages/          # Route pages
├── engine/         # Poker game logic
├── services/       # API/database services
├── stores/         # Zustand state
├── types/          # TypeScript definitions
├── lib/            # Utilities
└── styles/         # Global CSS
```

---

## 📖 Documentation

- [Build Report](./docs/BUILD_REPORT.md) - Session work summary
- [Poker Engine](./docs/POKER_ENGINE.md) - Engine API reference

---

## 🎨 Design System

| Color | Hex | Usage |
|-------|-----|-------|
| Royal Blue | #4169E1 | Primary actions |
| Near Black | #050507 | Background |
| Pure White | #FFFFFF | Text |
| Gold | #FFD700 | Chip amounts |

---

## 🔗 Related Projects

| Project | Port | Description |
|---------|------|-------------|
| **Club Arena** | 5174 | This project (Orb #2) |
| **Diamond Arena** | 5173 | High-stakes training (Orb #3) |

---

## 📝 License

© 2026 Smarter.Poker — All rights reserved.
