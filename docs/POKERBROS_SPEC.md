# 🎰 Club Engine — PokerBros Clone Specification

## Overview

**Club Engine** is a PokerBros clone but BETTER. It's a private club-based poker platform that enables players to join private poker communities, play cash games and tournaments, and manage chips through an agent/owner system.

**Brand Colors**: Blue, White, Black

---

## 🏛️ Core Architecture

### Club-Based System
- **Clubs**: Private, invite-only poker rooms with unique Club IDs
- **Unions**: Networks of clubs that combine player pools for more liquidity
- **Agents**: Intermediaries who recruit players, handle deposits/withdrawals, manage chips

### Currency System
- **Chips**: Virtual currency for gameplay (no real cash value in-app)
- **Diamonds**: In-app purchase currency that club owners buy from platform
- Diamonds → Chips conversion for club economy

---

## 🎮 Game Types & Formats

### Cash Games
| Game | Variants |
|------|----------|
| **Texas Hold'em** | No-Limit, Fixed-Limit, Short Deck (6+) |
| **Omaha** | PLO4, PLO5, PLO6, Hi-Lo, High-only |
| **Open Face Chinese** | 2-handed, 3-handed, Pineapple, Ultimate, Joker |
| **Special Formats** | Double Board, Pineapple Hold'em, Crazy Pineapple |

### Table Settings
- **Blinds**: Configurable small/big blind structure
- **Buy-in**: Min/Max ranges (e.g., 50BB - 200BB)
- **Player Count**: 2-9 players per table
- **Time Bank**: Extra decision time (configurable seconds)
- **Multi-tabling**: Up to 4 tables simultaneously
- **Table Themes**: 6 different visual themes

### Special Game Features
| Feature | Description |
|---------|-------------|
| **Straddle** | Voluntary all-positions straddle, re-straddle support |
| **Bomb Pot** | Everyone antes, no preflop action, straight to flop |
| **Run It Twice** | Deal remaining cards twice when all-in, split pot by winner |
| **Double Board** | Two separate boards dealt simultaneously |
| **Action Tables** | Require minimum % of hands played |

### Tournaments
| Type | Description |
|------|-------------|
| **MTT** | Multi-table tournaments, deep stacks, 7-12 min blinds |
| **SNG** | Sit & Go, starts when full |
| **Spin-It** | 3-player hyper-turbo, random multiplier (2x-100x) |

### Tournament Settings
- Starting stacks (configurable)
- Blind level duration
- Antes structure
- Late registration period
- Re-entry/rebuy options
- Prize distribution structure

---

## 👤 User Features

### Account & Profile
- Custom avatar selection
- Username/display name
- Career playing stats
- Hand history (last 6 days)

### In-Game Stats Tracking
- Total games played
- Total hands
- VPIP (Voluntarily Put Money In Pot) %
- PFR (Pre-Flop Raise) %
- ROI (Return on Investment)
- Player style icons (Newbie, Rock, etc.)

### Session Stats (visible when clicking player avatar)
- Current Table VPIP
- Buy-in amount
- Current session winnings

---

## 🏆 Club Owner/Admin Features

### Club Management
- Club name, icon, introduction
- Public vs private settings
- Auto-approve or manual approval for new members
- Push notifications to members
- Global notes for players

### Role Hierarchy
| Role | Permissions |
|------|-------------|
| **Owner** | Full control, treasury, all admin functions |
| **Super Agent** | High-level recruitment, chip distribution |
| **Agent** | Player recruitment, deposits/withdrawals |
| **Manager** | Table control, player management |
| **Member** | Standard play access |

### Table Control
- Create/start/stop tables
- Configure blinds, buy-ins, rake
- Enable/disable features (straddle, bomb pot, RIT)
- Disband tables

### Game Configuration Options
- Bomb pot frequency (every X hands)
- Bomb pot ante amount (1-5 BB or random)
- Jackpot settings (Bad Beat Jackpot)
- Double board toggle
- Run it twice toggle
- Chat restrictions
- Time bank settings

### Security Settings
- GPS restrictions (prevent players too close)
- IP restrictions (prevent same IP at table)
- Device restrictions (prevent multi-accounting)

---

## 🛡️ Security & Fair Play

### Anti-Cheat System
- **Live Alert Engine**: AI-powered suspicious activity detection (97-98% detection rate)
- **Game Integrity Team (GIB)**: Human oversight for collusion, chip dumping, bots
- **Photo Rotating Verification**: CAPTCHA-like bot detection
- **In-game Captchas**: Random verification prompts

### Restrictions
- GPS-based proximity prevention
- IP address restrictions
- Device ID tracking
- Player blacklists (club/union level)

### RNG Certification
- Gaming Labs certified
- iTech Labs certified
- BMM Testlabs certified
- Fair, unbiased card shuffling

---

## 🎁 In-App Items & VIP Features

### Purchasable Items
| Item | Function |
|------|----------|
| **Time Bank** | Extra decision time |
| **Emojis** | Throwable reactions at table |
| **Rabbit Cam** | See undealt cards after hand ends |
| **VIP Cards** | Premium features bundle |

### Daily Rewards
- Daily Bonus (free chips)
- Daily Draw (prize wheel)
- Lucky Draw (random rewards)

---

## 💰 Economy & Rake

### Rake System
- Configurable rake % (typically 5%)
- Rake caps by stake level (1.5BB - 6BB)
- "No flop, no drop" option (no rake if no flop)
- Reduced rake for short-handed tables (e.g., 2.5%)

### Rakeback
- Configurable rakeback % (up to 70%)
- Player incentive for volume

### Monitoring
- Fee tracking dashboard for owners
- Transaction history
- Club treasury management

---

## 🎨 UI/UX Requirements

### Design Language
- **Primary Color**: Blue (#4169E1 Royal Blue)
- **Secondary**: White (#FFFFFF)
- **Background**: Black/Dark (#050507)
- **Accents**: Gold for VIP, Green for success, Red for danger

### Table UI
- High-quality felt design
- Animated card dealing
- Chip stack visualization
- Pot size display
- Player seat positions (round layout)
- Avatar display with status indicators
- Action buttons (Fold, Check, Call, Raise, All-In)
- Bet slider for raise amounts
- Timer/time bank visualization

### Lobby UI
- Club list with traffic indicators
- Table list with filters
- Game type tabs (Hold'em, Omaha, OFC, Tournaments)
- Search functionality
- Create table button
- Active player counts

### Multi-tabling
- Up to 4 tables
- Tile or cascade window options
- Quick table switching
- Action priority alerts

---

## 📱 Platform Support

- iOS app
- Android app
- Multi-tabling support
- One-handed mobile operation
- Push notifications

---

## 🔄 Real-time Features

### Live Updates
- Real-time chip movements
- Instant action notifications
- Live player status (online/offline/away)
- Table activity indicators
- Waiting list updates

### Notifications
- Your turn alerts
- Tournament start notifications
- Club announcements
- New message alerts

---

## 📊 Analytics & Reporting

### For Players
- Hand history viewer
- Session results
- Lifetime statistics
- Leak analysis (VPIP/PFR patterns)

### For Club Owners
- Revenue reports
- Player activity metrics
- Table utilization
- Agent performance tracking

---

## 🚀 "Better Than PokerBros" Features

### Improvements Over PokerBros
1. **Modern UI**: Sleeker, more intuitive interface
2. **Faster Performance**: Optimized for speed
3. **Better Stats**: More detailed analytics
4. **Enhanced Security**: Additional anti-cheat layers
5. **Social Features**: Integrated chat, friend lists
6. **Training Integration**: GTO training tools (Orb #4)
7. **Reputation System**: Trust scores, player ratings
8. **Better Tournament System**: More tournament types, features
9. **Improved Multi-tabling**: Smoother 4-table experience
10. **Web Access**: Play from browser (not just mobile apps)

---

## 🗂️ Database Schema Requirements

### Core Tables
- `clubs` - Club registry
- `club_members` - Membership tracking
- `club_agents` - Agent assignments
- `tables` - Active game tables
- `players_at_table` - Current seating
- `hands` - Hand history
- `hand_actions` - Individual actions per hand
- `tournaments` - Tournament registry
- `tournament_entries` - Player registrations
- `chips_ledger` - All chip transactions
- `diamonds_ledger` - Diamond purchases/conversions

### Supporting Tables
- `profiles` - User profiles
- `player_stats` - Aggregate statistics
- `jackpots` - Bad beat jackpot pools
- `blacklists` - Banned players
- `settings` - Club/table configurations

---

## 📋 Implementation Priority

### Phase 1: Core Platform
1. Authentication system
2. Club creation/joining
3. Basic lobby UI
4. Profile management

### Phase 2: Gameplay
1. Table creation
2. Basic Hold'em cash game
3. Chip management
4. Hand history

### Phase 3: Features
1. Omaha variants
2. Tournament system
3. Straddle/Run It Twice
4. Multi-tabling

### Phase 4: Polish
1. Analytics dashboard
2. Advanced anti-cheat
3. VIP system
4. Social features

---

*This specification captures all PokerBros functionality while outlining improvements for a superior product.*
