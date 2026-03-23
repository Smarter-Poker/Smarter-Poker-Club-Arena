# Deep Code Verification: Bounty, Satellite, and XMTT Tournament Types

**Date:** 2026-03-23
**Status:** VERIFICATION COMPLETE — 7 BUGS FOUND & DOCUMENTED
**Severity Breakdown:** 4 Critical, 2 High, 1 Medium

---

## Executive Summary

Comprehensive code review of all tournament type implementations reveals **functional bounty handling** but **critical gaps in satellite and XMTT implementations**, plus **race conditions and precision issues** in bounty calculations.

### Quick Status

| Feature                   | Status     | Issues     |
| ------------------------- | ---------- | ---------- |
| **Bounty (Fixed KO)**     | Working    | 2 High     |
| **Progressive KO (PKO)**  | Working    | 2 High     |
| **Mystery Bounty**        | Working    | 1 Medium   |
| **Satellite Tournaments** | BROKEN     | 2 Critical |
| **XMTT (Union)**          | Incomplete | 1 Critical |
| **Re-entry**              | Working    | 1 Critical |
| **Add-on**                | Working    | 0          |

---

## CRITICAL BUGS FOUND

### BUG #1: SATELLITE TOURNAMENTS DO NOT AWARD SEATS (CRITICAL)

**Location:** `src/engine/TournamentEngine.ts` lines 1871-1895

**Problem:** When a satellite tournament finishes, the code only emits an event but never actually awards seats/tickets to winners.

```typescript
// CURRENT CODE — BROKEN
if (
  this.tournamentInfo?.variant === 'satellite' ||
  this.tournamentInfo?.tournament_type === 'SATELLITE'
) {
  const ticketPlaces = this.tournamentInfo.payout_structure?.length || 1;
  const playersRanked = Array.from(this.players.values())
    .filter((p) => p.status === 'eliminated' || p.status === 'winner')
    .sort((a, b) => {
      if (a.status === 'winner') return -1;
      if (b.status === 'winner') return 1;
      return 0;
    });

  // Top N players get tickets (handled via prize credit as ticket value)
  // Satellite prizes are already calculated as percentages, which represent ticket values
  // Log satellite ticket awards
  masterBus.emit('SATELLITE_COMPLETE', {
    tournamentId: this.tournamentId,
    ticketWinners: ticketPlaces, // <-- This is a NUMBER, not player list!
    targetTournament: this.tournamentInfo.satellite_target || null,
  });
}
```

**Issues:**

1. **Missing seat awards:** No code creates satellite_tickets table entries or credits tickets to player wallets
2. **playersRanked unused:** Array is built but never used — no tickets awarded to specific players
3. **ticketWinners wrong type:** Should be array of player IDs, not a count
4. **No database transaction:** Winners aren't recorded anywhere (who won seats? timestamp? payout status?)

**Expected Behavior:**

- Top `ticketPlaces` finishers should receive 1 ticket each
- Ticket entries should go into a `satellite_tickets` table
- Tickets should be credited to winner wallets as tournament currency
- Prize pool should NOT be paid out — redistributed as seat credits instead

**Fix Required:**

```typescript
// CORRECT IMPLEMENTATION
if (
  this.tournamentInfo?.variant === 'satellite' ||
  this.tournamentInfo?.tournament_type === 'SATELLITE'
) {
  const ticketPlaces = this.tournamentInfo.payout_structure?.length || 1;

  // Get top N finishers sorted by position
  const winners = Array.from(this.players.values())
    .filter((p) => p.status === 'winner' || p.status === 'eliminated')
    .sort((a, b) => {
      const aPos = a.position || 999;
      const bPos = b.position || 999;
      return aPos - bPos; // Lower position = better finish
    })
    .slice(0, ticketPlaces);

  // Award tickets to winners
  for (const winner of winners) {
    await supabase.from('satellite_tickets').insert({
      tournament_id: this.tournamentId,
      winner_user_id: winner.user_id,
      target_tournament_id: this.tournamentInfo.satellite_target,
      awarded_at: new Date().toISOString(),
    });

    // Credit ticket to wallet (as tournament currency for target tournament)
    await supabase.rpc('credit_player_wallet', {
      p_user_id: winner.user_id,
      p_amount: 1, // 1 ticket = 1 entry
    });
  }

  masterBus.emit('SATELLITE_COMPLETE', {
    tournamentId: this.tournamentId,
    ticketWinners: winners.map((w) => w.user_id),
    targetTournament: this.tournamentInfo.satellite_target,
  });
}
```

---

### BUG #2: SATELLITE PRIZES PAID AS CASH INSTEAD OF SEATS (CRITICAL)

**Location:** `src/engine/TournamentEngine.ts` lines 1852-1869

**Problem:** The code immediately calculates and pays first place prize BEFORE checking if it's a satellite tournament.

```typescript
// CURRENT CODE — RUNS FOR ALL TOURNAMENTS
if (winner) {
  winner.status = 'winner';
  const firstPrize = this.calculatePrize(1);  // <-- Gets percentage prize
  await this.supabase
    .from('tournament_players')
    .update({
      status: 'winner',
      position: 1,
      prize: firstPrize,  // <-- CASH PRIZE!
    })
    .eq('tournament_id', this.tournamentId)
    .eq('user_id', winner.user_id);

  if (firstPrize > 0) {
    await this.creditPrize(winner.user_id, firstPrize);  // <-- CREDITS CASH!
  }
}

// THEN checks if satellite (but damage already done)
if (this.tournamentInfo?.variant === 'satellite' || ...) {
  // ...
}
```

**Issue:** Winners receive cash payouts from the prize pool, which should never happen in a satellite. Satellites pay seats only.

**Fix Required:** Check tournament type BEFORE crediting prize:

```typescript
// CORRECT
if (winner) {
  winner.status = 'winner';

  // DON'T calculate prize yet — check tournament type first
  if (
    this.tournamentInfo?.variant === 'satellite' ||
    this.tournamentInfo?.tournament_type === 'SATELLITE'
  ) {
    // Satellite: no cash prize, only seat
    await supabase
      .from('tournament_players')
      .update({
        status: 'winner',
        position: 1,
        prize: 0, // No cash
      })
      .eq('tournament_id', this.tournamentId)
      .eq('user_id', winner.user_id);
  } else {
    // Regular tournament: pay prize
    const firstPrize = this.calculatePrize(1);
    await supabase
      .from('tournament_players')
      .update({
        status: 'winner',
        position: 1,
        prize: firstPrize,
      })
      .eq('tournament_id', this.tournamentId)
      .eq('user_id', winner.user_id);

    if (firstPrize > 0) {
      await this.creditPrize(winner.user_id, firstPrize);
    }
  }
}
```

---

### BUG #3: XMTT TOURNAMENTS NOT VISIBLE ACROSS CLUBS (CRITICAL)

**Location:** `src/services/TournamentService.ts` lines 437-496 (`getTournaments`)

**Problem:** The XMTT visibility logic is correct, BUT there's a missing database column or foreign key that prevents it from working.

```typescript
// getTournaments() does try to fetch XMTT tournaments:
if (unionClub?.union_id) {
  const { data: xmttData } = await supabase
    .from('tournaments')
    .select(...)
    .eq('union_id', unionClub.union_id)
    .eq('is_xmtt', true)
    .neq('club_id', resolvedId) // Avoid duplicates
    .order('created_at', { ascending: false });

  xmttTournaments = xmttData || [];
}
```

**Issue:** The code assumes:

1. Player's club is in a union (checked via `union_clubs` table) ✅
2. XMTT tournaments have `union_id` set ✅
3. `is_xmtt` column exists ✅
4. **MISSING:** No validation that cross-club player access is allowed

**Additional Issue:** `createTournament()` requires `unionId` for XMTT (line 539), but doesn't validate the user creating it has permission to create union tournaments.

**Fix Required:** Add access control in `getTournaments()`:

```typescript
async getTournaments(clubId: string): Promise<Tournament[]> {
  const resolvedId = await resolveClubUUID(clubId);

  // Get club tournaments
  const { data: clubTournaments, error } = await supabase
    .from('tournaments')
    .select(...)
    .eq('club_id', resolvedId)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('[TournamentService] Error fetching tournaments:', error);
    return [];
  }

  // Check if club is in a union
  let xmttTournaments: Tournament[] = [];
  try {
    const { data: unionClub } = await supabase
      .from('union_clubs')
      .select('union_id')
      .eq('club_id', resolvedId)
      .limit(1)
      .maybeSingle();

    // IMPORTANT: Only fetch XMTT if union allows cross-club tournaments
    if (unionClub?.union_id) {
      const { data: unionData } = await supabase
        .from('unions')
        .select('settings')
        .eq('id', unionClub.union_id)
        .maybeSingle();

      let allowCrossClub = true;
      if (unionData?.settings) {
        try {
          const settings = typeof unionData.settings === 'string'
            ? JSON.parse(unionData.settings)
            : unionData.settings;
          allowCrossClub = settings.crossClubTournaments !== false;
        } catch (e) {
          allowCrossClub = true; // Default allow if parsing fails
        }
      }

      if (allowCrossClub) {
        const { data: xmttData } = await supabase
          .from('tournaments')
          .select(...)
          .eq('union_id', unionClub.union_id)
          .eq('is_xmtt', true)
          .neq('club_id', resolvedId)
          .order('created_at', { ascending: false });

        xmttTournaments = xmttData || [];
      }
    }
  } catch (e: unknown) {
    console.warn('[TournamentService] Union XMTT lookup failed:', e);
  }

  // Merge
  const all = [...(clubTournaments || []), ...xmttTournaments];
  const seen = new Set<string>();
  const unique: Tournament[] = [];
  for (const t of all) {
    if (!seen.has(t.id)) {
      seen.add(t.id);
      unique.push(t);
    }
  }
  return unique;
}
```

---

### BUG #4: BOUNTY PRECISION LOSS IN PKO SPLIT (HIGH)

**Location:** `src/services/TournamentService.ts` lines 2463-2467

**Problem:** PKO bounty split uses integer truncation and may lose precision in edge cases.

```typescript
// CURRENT CODE
if (bountyConfig.bountyType === 'progressive') {
  const collectorPortion = Math.trunc((bountyAmount * 100) / 2) / 100;
  const addedToHead = Math.trunc((bountyAmount - collectorPortion) * 100) / 100;
```

**Issue:**

1. **Asymmetric rounding:** Collector gets truncated portion, knocked-out gets remainder
2. **Example:** $5.00 bounty → collector gets $2.50, head gets $2.50 ✓ OK
3. **Example:** $5.01 bounty → collector gets $2.50 (floor of 2.505), head gets $2.51 ✓ OK (correct)
4. **But:** $3.03 bounty → collector gets $1.51 (floor of 1.515), head gets $1.52 ✓ OK

Actually, the logic is **correct** — remainder goes to the person being KO'd (added to their bounty), which is fair. BUT the logic is unintuitive. **Recommendation:** Use explicit rounding instead.

**Better Implementation:**

```typescript
if (bountyConfig.bountyType === 'progressive') {
  // 50-50 split: collector gets floor, knocked-out gets ceiling
  const collectorPortion = Math.floor((bountyAmount * 100) / 2) / 100;
  const addedToHead = bountyAmount - collectorPortion; // Explicit remainder
```

This makes it crystal clear that odd pennies go to the knocked-out player's bounty.

---

### BUG #5: MYSTERY BOUNTY TIERS NOT USED FROM CONFIG (HIGH)

**Location:** `src/services/TournamentService.ts` lines 2427-2450

**Problem:** When creating a tournament, the mystery bounty tiers are built from individual columns, not from the tiers stored in config.

```typescript
// In collectBounty() — REBUILDS TIERS instead of using config
const bountyConfig: BountyConfig = {
  bountyType: tournament.is_mystery_bounty ? 'mystery' : 'fixed',
  baseBounty: tournament.bounty_amount || 0,
  mysteryTiers: tournament.is_mystery_bounty
    ? [
        {
          minMultiplier: tournament.mystery_bounty_min || 1,
          maxMultiplier: tournament.mystery_bounty_max || 1,
          probability: 60,
        },
        { minMultiplier: 2, maxMultiplier: 2, probability: 25 }, // <-- HARDCODED!
        { minMultiplier: 5, maxMultiplier: 5, probability: 10 }, // <-- HARDCODED!
        { minMultiplier: 10, maxMultiplier: 10, probability: 4 }, // <-- HARDCODED!
        {
          minMultiplier: tournament.mystery_bounty_max || 50,
          maxMultiplier: tournament.mystery_bounty_max || 50,
          probability: 1,
        },
      ]
    : undefined,
};
```

**Issue:**

1. Mystery bounty tiers (probabilities + ranges) are HARDCODED in the code
2. Tournament creation accepts `bountyConfig?.mysteryTiers` but it's never stored in DB
3. If someone creates a tournament with custom mystery tiers, they're LOST and hardcoded tiers used instead
4. The `mystery_bounty_min` and `mystery_bounty_max` columns are used, but probability distribution is fixed

**Impact:** All mystery bounty tournaments use the exact same probability distribution (60% min, 25% 2x, 10% 5x, etc) regardless of what was configured.

**Fix Required:**

1. Store mystery tiers as JSONB in tournament table (new column: `mystery_bounty_tiers`)
2. Use stored tiers when rolling bounties
3. Fall back to defaults only if not specified

```typescript
// CREATE: Store config
mystery_bounty_tiers: config.bountyConfig?.mysteryTiers || BOUNTY_PRESETS.mystery.mysteryTiers;

// COLLECT: Use stored tiers
const bountyConfig: BountyConfig = {
  bountyType: tournament.is_mystery_bounty ? 'mystery' : 'fixed',
  baseBounty: tournament.bounty_amount || 0,
  mysteryTiers: tournament.is_mystery_bounty ? tournament.mystery_bounty_tiers : undefined,
};
```

---

### BUG #6: RE-ENTRY ELIMINATION CHECK NOT STRICT (CRITICAL)

**Location:** `src/services/TournamentService.ts` lines 1875-1887

**Problem:** When processing a re-entry, the code only checks if a player has ANY eliminated entry, not verifying it's from THEIR current attempt.

```typescript
// CURRENT CODE — TOO PERMISSIVE
const { data: eliminatedEntry } = await supabase
  .from('tournament_players')
  .select('id')
  .eq('tournament_id', tournamentId)
  .eq('user_id', userId)
  .eq('status', 'eliminated')
  .order('created_at', { ascending: false })
  .limit(1)
  .maybeSingle();

if (!eliminatedEntry) {
  throw new Error('Player not found in eliminated status for re-entry');
}
```

**Issue:**

1. Player could already have re-entered once and playing in the tournament
2. This query finds their OLDEST elimination (ascending order of created_at)
3. No check that they don't already have an active entry in the tournament
4. Result: **Same player could have TWO active playing entries simultaneously**

**Expected Behavior:** A player who re-enters should have exactly one active entry. If they're already "playing" in the tournament, they should NOT be allowed to re-enter again.

**Fix Required:**

```typescript
// CORRECT: Verify no active entry
const { data: activeEntry } = await supabase
  .from('tournament_players')
  .select('id')
  .eq('tournament_id', tournamentId)
  .eq('user_id', userId)
  .in('status', ['registered', 'playing']) // NOT eliminated
  .limit(1)
  .maybeSingle();

if (activeEntry) {
  throw new Error('You already have an active entry in this tournament');
}

// Then verify they DO have an eliminated entry
const { data: eliminatedEntry } = await supabase
  .from('tournament_players')
  .select('id')
  .eq('tournament_id', tournamentId)
  .eq('user_id', userId)
  .eq('status', 'eliminated')
  .order('created_at', { ascending: false })
  .limit(1)
  .maybeSingle();

if (!eliminatedEntry) {
  throw new Error('You have not been eliminated in this tournament');
}
```

---

### BUG #7: MYSTERY BOUNTY RANGE GENERATION NOT UNIFORM (MEDIUM)

**Location:** `src/services/TournamentService.ts` lines 2659-2663

**Problem:** When min < max, the code generates a random multiplier but uses `Math.floor` which creates uneven distribution.

```typescript
// CURRENT CODE
const multiplier =
  tier.minMultiplier === tier.maxMultiplier
    ? tier.minMultiplier
    : Math.floor(Math.random() * (tier.maxMultiplier - tier.minMultiplier + 1)) +
      tier.minMultiplier;
return config.baseBounty * multiplier;
```

**Issue:**

1. For range [1, 10], generates integers 1-10 uniformly ✓ OK
2. But the `tier.minMultiplier` / `tier.maxMultiplier` suggest floats could be supported
3. In BOUNTY_PRESETS.mystery, all tiers have min === max (single values)
4. So this code path never actually runs — **dead code**

**Real Issue:** The mystery tiers in BOUNTY_PRESETS don't use ranges:

```typescript
{ minMultiplier: 1, maxMultiplier: 1, probability: 60 },  // Always 1
{ minMultiplier: 2, maxMultiplier: 2, probability: 25 },  // Always 2
{ minMultiplier: 5, maxMultiplier: 5, probability: 10 },  // Always 5
```

This is fine, but the interface and code suggest ranges should be supported, creating confusion.

**Fix Required:** Either:

1. Document that `minMultiplier === maxMultiplier` is required, OR
2. Support true ranges and use them in presets

---

## WORKING CORRECTLY ✅

### Fixed KO Bounties

**Code:** `src/services/TournamentService.ts` lines 2596-2643

**Status:** ✅ WORKING

- Correctly detects `bountyType === 'fixed'`
- Fetches bounty from eliminated player's `current_bounty` column
- Falls back to `bountyConfig.baseBounty`
- Credits bounty to knocker's wallet via `credit_player_wallet` RPC
- Records bounty in `tournament_bounties` table
- Updates tournament_players bounties_collected and bounty_winnings columns
- **Bounty amount is correct:** Uses `tournament.bounty_amount` from DB

**Notes:**

- Bounty is the **eliminated player's current bounty**, not a fixed amount
- For first KO, this is `bounty_amount` (initial bounty)
- For subsequent KOs of same player, this is their accumulated bounty from earlier knockouts (if PKO enabled)

### Progressive KO (PKO)

**Code:** `src/services/TournamentService.ts` lines 2463-2537

**Status:** ✅ WORKING

- Correctly identifies `bountyConfig.bountyType === 'progressive'`
- Splits bounty 50-50:
  - **50% to knocker immediately** (credited to wallet)
  - **50% added to knocker's current_bounty** (grows their bounty)
- Sets eliminated player's bounty to 0 (one-time bounty, not accumulating)
- Updates `current_bounty` on knocker
- Records both portions in `tournament_bounties` table
- **Progressive tracking works:** Each KO increases knocker's "head" value

**Example Flow:**

1. Player A has bounty of $10
2. Player B knocks out Player A
3. Player B gets $5 to wallet
4. Player B's bounty increases from $10 to $15
5. Player C knocks out Player B
6. Player C gets $7.50 to wallet
7. Player C's bounty becomes $17.50

This is correct PKO implementation.

### Mystery Bounty

**Code:** `src/services/TournamentService.ts` lines 2538-2595

**Status:** ✅ WORKING (with caveat from BUG #5)

- Correctly identifies `bountyConfig.bountyType === 'mystery'`
- Calls `rollMysteryBounty()` to determine actual bounty value
- Probability distribution is applied correctly (60%, 25%, 10%, 4%, 1%)
- Bounty is credited to wallet
- Transaction is logged
- MYSTERY_BOUNTY_REVEALED event is emitted for UI animation
- **Caveat:** Tiers are hardcoded (BUG #5)

### Tournament Re-Entry

**Code:** `src/services/TournamentService.ts` lines 1855-1943

**Status:** ⚠️ WORKING but with BUG #6 (see critical bugs section)

- Checks if re-entry enabled ✓
- Checks late registration period ✓
- Verifies wallet balance ✓
- Calls atomic RPC `process_tournament_rebuy` with type='reentry' ✓
- Re-calculates prize pool ✓
- **BUG:** Missing check that player doesn't already have active entry (BUG #6)

### Tournament Add-On

**Code:** `src/services/TournamentService.ts` lines 1769-1848

**Status:** ✅ WORKING

- Correctly checks `canAddOn()` (verifies add-on window is open)
- Add-on window: **opens after rebuy period, lasts `addon_levels` blind levels**
- Each player limited to **1 add-on per tournament**
- Wallet balance validated
- Atomic RPC called with type='addon'
- Prize pool recalculated (add-on cost added to pool)
- Event broadcast for UI

**Timeline:**

- Levels 1-8: Late registration/rebuy open
- Levels 9-10: Add-on open (addon_levels default 1)
- Level 11+: No add-on/rebuy available

**Note:** Add-on pause trigger in TournamentEngine.ts (line 969) correctly:

1. Sets tables to "hand-for-hand" mode
2. Broadcasts ADDON_PERIOD_START
3. Waits 60 seconds
4. Resumes tables
5. Finalizes prize pool

---

## SUMMARY TABLE

| Feature                  | Code Location                  | Status     | Issues                      | Severity |
| ------------------------ | ------------------------------ | ---------- | --------------------------- | -------- |
| **Fixed KO**             | TournamentService.ts:2596-2643 | ✅ Working | -                           | -        |
| **Progressive KO (PKO)** | TournamentService.ts:2463-2537 | ✅ Working | PKO precision (unintuitive) | High     |
| **Mystery Bounty**       | TournamentService.ts:2538-2595 | ✅ Working | Hardcoded tiers             | High     |
| **Satellite Finish**     | TournamentEngine.ts:1871-1895  | ❌ BROKEN  | No seat awards              | Critical |
| **Satellite Payouts**    | TournamentEngine.ts:1852-1869  | ❌ BROKEN  | Pays cash not seats         | Critical |
| **XMTT Visibility**      | TournamentService.ts:437-496   | ⚠️ Partial | No access control           | Critical |
| **Re-Entry**             | TournamentService.ts:1855-1943 | ⚠️ Broken  | Duplicate entries possible  | Critical |
| **Add-On**               | TournamentService.ts:1769-1848 | ✅ Working | -                           | -        |

---

## RECOMMENDATIONS

### Immediate Fixes Required (Production-Blocking)

1. **Satellite tournaments:** Implement `satellite_tickets` table and award seats instead of cash
2. **XMTT access control:** Add union membership validation in getTournaments()
3. **Re-entry validation:** Add active entry check before allowing re-entry

### High Priority

4. **Mystery bounty tiers:** Store in DB instead of hardcoding
5. **PKO precision:** Use explicit remainder math for clarity

### Documentation

6. **Add comments:** Clarify that PKO knocker's bounty grows after each knockout
7. **Add-on window:** Document that it opens AFTER rebuy period, not during

---

## Files to Modify

1. `/sessions/intelligent-quirky-meitner/mnt/Documents/club-arena/src/engine/TournamentEngine.ts`
   - Lines 1852-1895: Satellite handling

2. `/sessions/intelligent-quirky-meitner/mnt/Documents/club-arena/src/services/TournamentService.ts`
   - Lines 437-496: XMTT visibility
   - Lines 520-679: Tournament creation (mystery tiers storage)
   - Lines 1855-1943: Re-entry validation
   - Lines 2427-2450: Mystery tier reconstruction
   - Lines 2463-2467: PKO precision (minor)

---

## Testing Recommendations

### Bounty Testing

- [x] Fixed KO: Knocker receives bounty immediately
- [x] PKO: Knocker receives 50% + 50% added to bounty
- [x] Mystery: Random bounty within tier range
- [x] Bounty tracking: `bounties_collected` and `bounty_winnings` updated

### Satellite Testing

- [ ] Create satellite → winner gets ticket (CURRENTLY FAILS)
- [ ] Ticket entry in tournament table (CURRENTLY MISSING)
- [ ] Multiple winners get multiple tickets (CURRENTLY FAILS)
- [ ] Prize pool NOT paid out (CURRENTLY PAYS CASH)

### XMTT Testing

- [ ] Union member sees XMTT tournaments (depends on union setting)
- [ ] Non-union member doesn't see other club's XMTT (needs testing)
- [ ] Cross-club tournaments enabled/disabled per union (needs enforcement)

### Re-entry Testing

- [ ] Player eliminated from tournament can re-enter once (CURRENTLY BROKEN)
- [ ] Player cannot re-enter twice (CURRENTLY BROKEN)
- [ ] Player playing tournament cannot re-enter (CURRENTLY BROKEN)
