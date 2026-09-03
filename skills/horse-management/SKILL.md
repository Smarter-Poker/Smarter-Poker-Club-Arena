---
name: horse-management
description: 'Add, remove, and manage Hydra horse fleet players in Club Arena. Use when users want to create new horses, modify existing horses, check horse status, or manage the horse fleet. Trigger on: horse, horses, fleet, hydra, add horse, remove horse, horse admin.'
---

# Horse Fleet Management Skill

## CRITICAL TERMINOLOGY

**NEVER call them "bots". They are HORSES. Always.**

## OVERVIEW

The Hydra horse fleet consists of AI-controlled players that are indistinguishable from real players ("Invisible Fleet Law"). Each horse is a fully-fledged player account in the smarter.poker system with all the same records, data, and capabilities as a real human player.

## ARCHITECTURE

### Database Tables Required for Each Horse

Every horse MUST have entries in ALL of these tables (verified working process):

1. **auth.users** — Supabase authentication entry (required as FK target)
   - Created via Admin Auth API: `POST /auth/v1/admin/users`
   - Must use the SAME UUID as the profile id
   - Use email: `horse.{username}@hydra.smarter.poker`
   - Set `email_confirm: true` and random password

2. **public.users** — Public users table (FK target for club_members, wallets)
   - Fields: `id`, `username`, `email`, `avatar_url`
   - Username MUST be unique across all users — append `_horse` or player_number if collision

3. **profiles** — Main player profile (the "source of truth")
   - `is_horse = true`, `horse_profile`, `horse_status = 'available'`
   - All JSONB preference fields must match real player defaults
   - `player_number` in 100000-999999 range (avoids collision with real players 1000-99999)

4. **wallets** — Triple wallet system (3 rows per horse)
   - BUSINESS (balance: 0), PLAYER (balance: 10000), PROMO (balance: 0)
   - FK to auth.users via user_id

5. **diamond_wallets** — Premium currency (1 row per horse)
   - balance: 0, lifetime_earned: 0, lifetime_spent: 0

6. **club_members** — Club membership (2 rows per horse, one per club)
   - SHARK_CLUB: `a41434bb-8d0c-400a-8f0d-e8b3d65afed4`
   - JAQK_CLUB: `a0000000-0000-0000-0000-000000000001`
   - role: 'member', status: 'approved', chip_balance: 50000

## CREATION ORDER (CRITICAL — FK dependencies)

1. **auth.users** first (Admin Auth API)
2. **public.users** second (depends on nothing but username uniqueness)
3. **profiles** third (FK to auth.users)
4. **wallets** fourth (FK to auth.users)
5. **diamond_wallets** fifth (FK to user_id)
6. **club_members** last (FK to public.users)

## HORSE PROFILES (Brain Types)

- `fish` (25%) — High VPIP, lots of calling, occasional wild plays
- `tag` (25%) — Tight-Aggressive, solid ABC poker
- `lag` (15%) — Loose-Aggressive, wide ranges, creative
- `balanced` (15%) — GTO-oriented, mixed strategies
- `tricky` (10%) — Deceptive, slowplays, check-raises
- `grinder` (10%) — Disciplined small ball, pot control

## HORSE BRAIN WIRING

- **HorseLogic.ts** — Core decision engine with 5 styles (TAG, LAG, BALANCED, TRICKY, GRINDER)
- **HorseBrainAdapter.ts** — Bridge between engine and AI (GTO cache + adaptation)
- **HydraService.ts** — Fleet management, seating, organic recede
- **HorseOrchestrator.ts** — Multi-table coordination (max 4 per horse: 2 cash + 2 tournament)

## ADDING NEW HORSES — Verified Process

### Step 1: Generate unique identifiers

```javascript
const playerNum = 100000 + Math.floor(Math.random() * 900000); // Unique in range
const horseId = crypto.randomUUID(); // Will be used across ALL tables
const username = 'HorseName'; // Must be unique
const email = `horse.${username.toLowerCase()}@hydra.smarter.poker`;
```

### Step 2: Create auth.users entry

```javascript
await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
  method: 'POST',
  headers: {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    id: horseId,
    email: email,
    password: `HorseFleet_${horseId.substring(0, 8)}_${Math.random().toString(36).substring(2, 10)}`,
    email_confirm: true,
    user_metadata: { is_horse: true, display_name: 'HorseName' },
  }),
});
```

### Step 3: Create public.users entry

```javascript
await fetch(`${SUPABASE_URL}/rest/v1/users`, {
  method: 'POST',
  headers: { ...serviceHeaders, Prefer: 'return=representation,resolution=merge-duplicates' },
  body: JSON.stringify({ id: horseId, username: username, email: email, avatar_url: avatarUrl }),
});
```

### Step 4: Create profile

```javascript
await fetch(`${SUPABASE_URL}/rest/v1/profiles`, {
  method: 'POST',
  headers: { ...serviceHeaders, Prefer: 'return=representation' },
  body: JSON.stringify({
    // ... ALL profile fields including JSONB preferences
    // See DEFAULT_PREFS in the migration script for complete list
    is_horse: true,
    horse_profile: 'fish', // or tag, lag, balanced, tricky, grinder
    horse_status: 'available',
    // ... many more fields
  }),
});
```

### Step 5: Create wallets

```javascript
for (const [type, bal] of [
  ['BUSINESS', 0],
  ['PLAYER', 10000],
  ['PROMO', 0],
]) {
  await fetch(`${SUPABASE_URL}/rest/v1/wallets`, {
    method: 'POST',
    headers: serviceHeaders,
    body: JSON.stringify({ user_id: horseId, wallet_type: type, balance: bal, locked_balance: 0 }),
  });
}
await fetch(`${SUPABASE_URL}/rest/v1/diamond_wallets`, {
  method: 'POST',
  headers: serviceHeaders,
  body: JSON.stringify({ user_id: horseId, balance: 0, lifetime_earned: 0, lifetime_spent: 0 }),
});
```

### Step 6: Join both clubs

```javascript
for (const clubId of [SHARK_CLUB_ID, JAQK_CLUB_ID]) {
  await fetch(`${SUPABASE_URL}/rest/v1/club_members`, {
    method: 'POST',
    headers: serviceHeaders,
    body: JSON.stringify({
      club_id: clubId,
      user_id: horseId,
      role: 'member',
      status: 'approved',
      chip_balance: 50000,
      is_active: true,
      is_bot: false,
      is_prepaid: true,
      trust_score: 50,
      tier: 'bronze',
    }),
  });
}
```

## REMOVING A HORSE

1. Set `horse_status = 'disabled'` in profiles
2. Remove from `table_seats` (any active tables)
3. Remove from `club_members` (both clubs)
4. Optionally: delete from `wallets`, `diamond_wallets`, `public.users`, `auth.users`
5. Note: DO NOT delete the profile — keep for hand history references

## VERIFICATION CHECKLIST

For each horse, verify ALL of these exist:

- [ ] auth.users entry with matching UUID
- [ ] public.users entry with matching UUID
- [ ] profiles entry with `is_horse = true` and all fields populated
- [ ] 3 wallet entries (BUSINESS, PLAYER, PROMO)
- [ ] 1 diamond_wallet entry
- [ ] 2 club_members entries (Shark + JAQK)
- [ ] Email assigned (`horse.{name}@hydra.smarter.poker`)
- [ ] Avatar URL assigned (dicebear avataaars)
- [ ] Horse profile assigned (fish/tag/lag/balanced/tricky/grinder)
- [ ] Horse status = 'available'

## CONFIGURATION

- **Supabase URL**: `https://kuklfnapbkmacvwxktbh.supabase.co`
- **SHARK_CLUB_ID**: `a41434bb-8d0c-400a-8f0d-e8b3d65afed4`
- **JAQK_CLUB_ID**: `a0000000-0000-0000-0000-000000000001`
- **Fleet Size Config**: `HydraService.ts` → `DEFAULT_CONFIG.fleetSize`
- **Max Tables Per Horse**: 4 (2 cash + 2 tournament)

## TESTING

- All E2E testing on **smarter.poker** — NEVER on club-arena.vercel.app
- Test URL: `https://smarter.poker/hub/club-arena/`
- Horse Admin: `https://smarter.poker/horses`

## COMMON ISSUES

1. **FK violation on club_members**: Missing `public.users` entry. Create that first.
2. **FK violation on wallets**: Missing `auth.users` entry. Create via Admin Auth API first.
3. **Username collision in public.users**: Append `_horse` or player_number to make unique.
4. **Player number collision**: Use 100000-999999 range. Check before inserting.
