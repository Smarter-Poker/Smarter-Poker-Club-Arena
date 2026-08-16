#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  COMPREHENSIVE CASH GAME & TOURNAMENT PROVISIONING
 *  Under Midway Union — All Variants, All Stakes, 7-Day Auto-Run Tournaments
 * ═══════════════════════════════════════════════════════════════════════════════
 */
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = 'https://kuklfnapbkmacvwxktbh.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
});

const UNION_ID = 'fade0000-0000-0000-0000-a00000000001';

// ═══════════════════════════════════════════════════════════════════════════════
// BLIND STRUCTURES
// ═══════════════════════════════════════════════════════════════════════════════
const BLINDS_REGULAR = JSON.stringify([
  { level: 1, sb: 25, bb: 50, ante: 0, duration_min: 12 },
  { level: 2, sb: 50, bb: 100, ante: 10, duration_min: 12 },
  { level: 3, sb: 75, bb: 150, ante: 15, duration_min: 12 },
  { level: 4, sb: 100, bb: 200, ante: 25, duration_min: 12 },
  { level: 5, sb: 150, bb: 300, ante: 30, duration_min: 12 },
  { level: 6, sb: 200, bb: 400, ante: 50, duration_min: 10 },
  { level: 7, sb: 300, bb: 600, ante: 75, duration_min: 10 },
  { level: 8, sb: 400, bb: 800, ante: 100, duration_min: 10 },
  { level: 9, sb: 500, bb: 1000, ante: 125, duration_min: 8 },
  { level: 10, sb: 750, bb: 1500, ante: 175, duration_min: 8 },
  { level: 11, sb: 1000, bb: 2000, ante: 250, duration_min: 8 },
  { level: 12, sb: 1500, bb: 3000, ante: 375, duration_min: 8 },
  { level: 13, sb: 2000, bb: 4000, ante: 500, duration_min: 6 },
  { level: 14, sb: 3000, bb: 6000, ante: 750, duration_min: 6 },
  { level: 15, sb: 5000, bb: 10000, ante: 1000, duration_min: 6 },
]);

const BLINDS_TURBO = JSON.stringify([
  { level: 1, sb: 25, bb: 50, ante: 0, duration_min: 5 },
  { level: 2, sb: 50, bb: 100, ante: 10, duration_min: 5 },
  { level: 3, sb: 100, bb: 200, ante: 25, duration_min: 5 },
  { level: 4, sb: 150, bb: 300, ante: 30, duration_min: 4 },
  { level: 5, sb: 200, bb: 400, ante: 50, duration_min: 4 },
  { level: 6, sb: 300, bb: 600, ante: 75, duration_min: 4 },
  { level: 7, sb: 500, bb: 1000, ante: 125, duration_min: 3 },
  { level: 8, sb: 750, bb: 1500, ante: 175, duration_min: 3 },
  { level: 9, sb: 1000, bb: 2000, ante: 250, duration_min: 3 },
  { level: 10, sb: 1500, bb: 3000, ante: 375, duration_min: 2 },
  { level: 11, sb: 2500, bb: 5000, ante: 625, duration_min: 2 },
  { level: 12, sb: 5000, bb: 10000, ante: 1000, duration_min: 2 },
]);

const BLINDS_HYPER = JSON.stringify([
  { level: 1, sb: 50, bb: 100, ante: 10, duration_min: 3 },
  { level: 2, sb: 100, bb: 200, ante: 25, duration_min: 3 },
  { level: 3, sb: 200, bb: 400, ante: 50, duration_min: 2 },
  { level: 4, sb: 400, bb: 800, ante: 100, duration_min: 2 },
  { level: 5, sb: 800, bb: 1600, ante: 200, duration_min: 2 },
  { level: 6, sb: 1500, bb: 3000, ante: 375, duration_min: 2 },
  { level: 7, sb: 3000, bb: 6000, ante: 750, duration_min: 2 },
  { level: 8, sb: 5000, bb: 10000, ante: 1000, duration_min: 2 },
]);

const PAYOUT_5 = JSON.stringify([
  { place: 1, percentage: 40 }, { place: 2, percentage: 25 },
  { place: 3, percentage: 18 }, { place: 4, percentage: 10 }, { place: 5, percentage: 7 },
]);

const PAYOUT_10 = JSON.stringify([
  { place: 1, percentage: 30 }, { place: 2, percentage: 20 }, { place: 3, percentage: 15 },
  { place: 4, percentage: 10 }, { place: 5, percentage: 7 }, { place: 6, percentage: 5 },
  { place: 7, percentage: 5 }, { place: 8, percentage: 4 }, { place: 9, percentage: 2 },
  { place: 10, percentage: 2 },
]);

// ═══════════════════════════════════════════════════════════════════════════════
// CASH GAME DEFINITIONS
// ═══════════════════════════════════════════════════════════════════════════════
function buildCashTables() {
  const tables = [];

  // Stakes matrix: [name_prefix, stakes_str, sb, bb, minBuy, maxBuy]
  const stakesNLH = [
    ['Micro', '0.05/0.10', 0.05, 0.10, 4, 20],
    ['Micro', '0.10/0.20', 0.10, 0.20, 8, 40],
    ['Low', '0.25/0.50', 0.25, 0.50, 20, 100],
    ['Low', '0.50/1.00', 0.50, 1.00, 40, 200],
    ['Mid', '1.00/2.00', 1.00, 2.00, 80, 400],
    ['Mid', '2.00/4.00', 2.00, 4.00, 160, 800],
    ['Mid', '2.00/5.00', 2.00, 5.00, 200, 1000],
    ['Mid', '3.00/6.00', 3.00, 6.00, 240, 1200],
    ['High', '5.00/10.00', 5.00, 10.00, 400, 2000],
    ['High', '10.00/20.00', 10.00, 20.00, 800, 4000],
    ['High', '10.00/25.00', 10.00, 25.00, 1000, 5000],
    ['Nosebleed', '25.00/50.00', 25.00, 50.00, 2000, 10000],
    ['Nosebleed', '50.00/100.00', 50.00, 100.00, 4000, 20000],
  ];

  const stakesPLO = [
    ['Micro', '0.10/0.20', 0.10, 0.20, 8, 40],
    ['Low', '0.25/0.50', 0.25, 0.50, 20, 100],
    ['Low', '0.50/1.00', 0.50, 1.00, 40, 200],
    ['Mid', '1.00/2.00', 1.00, 2.00, 80, 400],
    ['Mid', '2.00/5.00', 2.00, 5.00, 200, 1000],
    ['High', '5.00/10.00', 5.00, 10.00, 400, 2000],
    ['High', '10.00/25.00', 10.00, 25.00, 1000, 5000],
    ['Nosebleed', '25.00/50.00', 25.00, 50.00, 2000, 10000],
  ];

  // NLH 9-Max
  for (const [tier, stakes, sb, bb, min, max] of stakesNLH) {
    tables.push({ name: `NLH ${stakes}`, variant: 'nlh', stakes, sb, bb, min, max, mp: 9 });
  }
  // NLH 6-Max
  for (const [tier, stakes, sb, bb, min, max] of stakesNLH) {
    tables.push({ name: `NLH 6-Max ${stakes}`, variant: 'nlh', stakes, sb, bb, min, max, mp: 6 });
  }

  // PLO4 (9-max for low, 6-max for higher)
  for (const [tier, stakes, sb, bb, min, max] of stakesPLO) {
    const mp = bb <= 1.00 ? 9 : 6;
    tables.push({ name: `PLO4 ${stakes}`, variant: 'plo4', stakes, sb, bb, min, max, mp });
  }

  // PLO5 (always 6-max)
  for (const [tier, stakes, sb, bb, min, max] of stakesPLO) {
    tables.push({ name: `PLO5 ${stakes}`, variant: 'plo5', stakes, sb, bb, min, max, mp: 6 });
  }

  // PLO6 (always 6-max)
  for (const [tier, stakes, sb, bb, min, max] of stakesPLO.slice(0, 6)) {
    tables.push({ name: `PLO6 ${stakes}`, variant: 'plo6', stakes, sb, bb, min, max, mp: 6 });
  }

  // PLO8 Hi-Lo (9-max for low, 6 for high)
  for (const [tier, stakes, sb, bb, min, max] of stakesPLO) {
    const mp = bb <= 1.00 ? 9 : 6;
    tables.push({ name: `PLO8 ${stakes}`, variant: 'plo8', stakes, sb, bb, min, max, mp });
  }

  // Short Deck (always 6-max, higher ante structure)
  const stakesSD = [
    ['0.50/1.00', 0.50, 1.00, 40, 200],
    ['1.00/2.00', 1.00, 2.00, 80, 400],
    ['2.00/5.00', 2.00, 5.00, 200, 1000],
    ['5.00/10.00', 5.00, 10.00, 400, 2000],
  ];
  for (const [stakes, sb, bb, min, max] of stakesSD) {
    tables.push({ name: `Short Deck ${stakes}`, variant: 'short_deck', stakes, sb, bb, min, max, mp: 6 });
  }

  // OFC Pineapple (always 3-max)
  const stakesOFC = [
    ['0.25/0.50', 0.25, 0.50, 20, 100],
    ['0.50/1.00', 0.50, 1.00, 40, 200],
    ['1.00/2.00', 1.00, 2.00, 80, 400],
    ['2.00/5.00', 2.00, 5.00, 200, 1000],
  ];
  for (const [stakes, sb, bb, min, max] of stakesOFC) {
    tables.push({ name: `OFC Pineapple ${stakes}`, variant: 'ofc_pineapple', stakes, sb, bb, min, max, mp: 3 });
  }

  return tables;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TOURNAMENT DEFINITIONS — 7-Day Auto-Run Schedule
// ═══════════════════════════════════════════════════════════════════════════════
function buildTournaments() {
  // Base date: today = Tuesday March 18, 2026. Build Mon-Sun schedule.
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Find next Monday
  const dayOfWeek = today.getDay(); // 0=Sun, 1=Mon...
  const daysUntilMon = dayOfWeek === 0 ? 1 : dayOfWeek === 1 ? 0 : 8 - dayOfWeek;
  const monday = new Date(today);
  monday.setDate(today.getDate() + daysUntilMon);

  const tournaments = [];
  const dayNames = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

  // ── Daily recurring tournaments (run every day of the week) ──
  const dailySchedule = [
    // Morning Grind (10:00 AM ET = 15:00 UTC)
    { hour: 15, name: 'Morning Grind', buyIn: 5, fee: 0.50, gtd: 200, chips: 3000, maxP: 100, blinds: BLINDS_REGULAR, speed: 'regular', game: 'NLH', variant: 'freezeout', rebuy: false, bounty: false },
    { hour: 15, name: 'Morning PLO', buyIn: 10, fee: 1.00, gtd: 300, chips: 5000, maxP: 60, blinds: BLINDS_REGULAR, speed: 'regular', game: 'PLO', variant: 'freezeout', rebuy: false, bounty: false },

    // Lunch Rush (12:00 PM ET = 17:00 UTC)
    { hour: 17, name: 'Lunch Rush Turbo', buyIn: 10, fee: 1.00, gtd: 500, chips: 3000, maxP: 150, blinds: BLINDS_TURBO, speed: 'turbo', game: 'NLH', variant: 'freezeout', rebuy: false, bounty: false },
    { hour: 17, name: 'Lunch Bounty Hunter', buyIn: 20, fee: 2.00, gtd: 1000, chips: 5000, maxP: 200, blinds: BLINDS_REGULAR, speed: 'regular', game: 'NLH', variant: 'bounty', rebuy: false, bounty: true, bountyAmt: 10 },

    // Afternoon Action (2:00 PM ET = 19:00 UTC)
    { hour: 19, name: 'Afternoon Deepstack', buyIn: 25, fee: 2.50, gtd: 2000, chips: 10000, maxP: 200, blinds: BLINDS_REGULAR, speed: 'regular', game: 'NLH', variant: 'freezeout', rebuy: false, bounty: false },
    { hour: 19, name: 'PLO Madness', buyIn: 20, fee: 2.00, gtd: 1000, chips: 5000, maxP: 80, blinds: BLINDS_REGULAR, speed: 'regular', game: 'PLO', variant: 'rebuy', rebuy: true, rebuyCost: 20, rebuyChips: 5000, bounty: false },

    // Happy Hour (4:00 PM ET = 21:00 UTC)
    { hour: 21, name: 'Happy Hour Hyper', buyIn: 5, fee: 0.50, gtd: 300, chips: 1500, maxP: 100, blinds: BLINDS_HYPER, speed: 'hyper', game: 'NLH', variant: 'freezeout', rebuy: false, bounty: false },
    { hour: 21, name: 'PKO Knockout', buyIn: 50, fee: 5.00, gtd: 3000, chips: 5000, maxP: 200, blinds: BLINDS_REGULAR, speed: 'regular', game: 'NLH', variant: 'bounty', rebuy: false, bounty: true, bountyAmt: 25, pko: true },

    // Primetime (7:00 PM ET = 00:00 UTC next day)
    { hour: 0, name: 'Primetime $100K GTD', buyIn: 100, fee: 10.00, gtd: 10000, chips: 10000, maxP: 500, blinds: BLINDS_REGULAR, speed: 'regular', game: 'NLH', variant: 'freezeout', rebuy: false, bounty: false },
    { hour: 0, name: 'Primetime Rebuy Madness', buyIn: 25, fee: 2.50, gtd: 5000, chips: 3000, maxP: 300, blinds: BLINDS_TURBO, speed: 'turbo', game: 'NLH', variant: 'rebuy', rebuy: true, rebuyCost: 25, rebuyChips: 3000, bounty: false },
    { hour: 0, name: 'Primetime PLO Bounty', buyIn: 50, fee: 5.00, gtd: 3000, chips: 5000, maxP: 100, blinds: BLINDS_REGULAR, speed: 'regular', game: 'PLO', variant: 'bounty', rebuy: false, bounty: true, bountyAmt: 25 },

    // Night Owl (9:00 PM ET = 02:00 UTC)
    { hour: 2, name: 'Night Owl $50K GTD', buyIn: 50, fee: 5.00, gtd: 5000, chips: 7500, maxP: 300, blinds: BLINDS_REGULAR, speed: 'regular', game: 'NLH', variant: 'freezeout', rebuy: false, bounty: false },
    { hour: 2, name: 'Night Owl Turbo Bounty', buyIn: 20, fee: 2.00, gtd: 1500, chips: 3000, maxP: 200, blinds: BLINDS_TURBO, speed: 'turbo', game: 'NLH', variant: 'bounty', rebuy: false, bounty: true, bountyAmt: 10 },

    // Late Night (11:00 PM ET = 04:00 UTC)
    { hour: 4, name: 'Late Night Hyper Turbo', buyIn: 10, fee: 1.00, gtd: 500, chips: 1500, maxP: 150, blinds: BLINDS_HYPER, speed: 'hyper', game: 'NLH', variant: 'freezeout', rebuy: false, bounty: false },
    { hour: 4, name: 'Midnight Madness Rebuy', buyIn: 5, fee: 0.50, gtd: 250, chips: 3000, maxP: 200, blinds: BLINDS_TURBO, speed: 'turbo', game: 'NLH', variant: 'rebuy', rebuy: true, rebuyCost: 5, rebuyChips: 3000, bounty: false },

    // Early Bird (6:00 AM ET = 11:00 UTC)
    { hour: 11, name: 'Early Bird Freeroll', buyIn: 0, fee: 0, gtd: 100, chips: 3000, maxP: 500, blinds: BLINDS_TURBO, speed: 'turbo', game: 'NLH', variant: 'freezeout', rebuy: false, bounty: false },
    { hour: 11, name: 'Dawn Patrol', buyIn: 10, fee: 1.00, gtd: 500, chips: 5000, maxP: 100, blinds: BLINDS_REGULAR, speed: 'regular', game: 'NLH', variant: 'freezeout', rebuy: false, bounty: false },

    // Extra: 1 AM ET = 06:00 UTC
    { hour: 6, name: 'Graveyard Grinder', buyIn: 5, fee: 0.50, gtd: 200, chips: 3000, maxP: 100, blinds: BLINDS_TURBO, speed: 'turbo', game: 'NLH', variant: 'freezeout', rebuy: false, bounty: false },

    // Extra: 8 AM ET = 13:00 UTC
    { hour: 13, name: 'Sunrise Bounty', buyIn: 15, fee: 1.50, gtd: 500, chips: 5000, maxP: 150, blinds: BLINDS_REGULAR, speed: 'regular', game: 'NLH', variant: 'bounty', rebuy: false, bounty: true, bountyAmt: 5 },
  ];

  // ── Special day-of-week tournaments ──
  const weeklySpecials = [
    // Sunday Major
    { day: 6, hour: 0, name: '★ Sunday Major $500K GTD', buyIn: 200, fee: 20.00, gtd: 50000, chips: 15000, maxP: 1000, blinds: BLINDS_REGULAR, speed: 'regular', game: 'NLH', variant: 'freezeout', rebuy: false, bounty: false },
    { day: 6, hour: 0, name: '★ Sunday PLO Championship', buyIn: 100, fee: 10.00, gtd: 10000, chips: 10000, maxP: 200, blinds: BLINDS_REGULAR, speed: 'regular', game: 'PLO', variant: 'freezeout', rebuy: false, bounty: false },
    { day: 6, hour: 2, name: '★ Sunday PKO Bounty', buyIn: 100, fee: 10.00, gtd: 10000, chips: 5000, maxP: 300, blinds: BLINDS_REGULAR, speed: 'regular', game: 'NLH', variant: 'bounty', rebuy: false, bounty: true, bountyAmt: 50, pko: true },

    // Saturday Night Feature
    { day: 5, hour: 0, name: '★ Saturday Night Special', buyIn: 50, fee: 5.00, gtd: 5000, chips: 10000, maxP: 300, blinds: BLINDS_REGULAR, speed: 'regular', game: 'NLH', variant: 'rebuy', rebuy: true, rebuyCost: 50, rebuyChips: 10000, bounty: false },
    { day: 5, hour: 2, name: '★ Saturday Turbo Knockout', buyIn: 30, fee: 3.00, gtd: 3000, chips: 3000, maxP: 200, blinds: BLINDS_TURBO, speed: 'turbo', game: 'NLH', variant: 'bounty', rebuy: false, bounty: true, bountyAmt: 15, pko: true },

    // Friday Night
    { day: 4, hour: 0, name: '★ Friday Night Fever', buyIn: 75, fee: 7.50, gtd: 7500, chips: 10000, maxP: 300, blinds: BLINDS_REGULAR, speed: 'regular', game: 'NLH', variant: 'freezeout', rebuy: false, bounty: false },

    // Wednesday PLO Special
    { day: 2, hour: 0, name: '★ Wednesday PLO Wars', buyIn: 50, fee: 5.00, gtd: 3000, chips: 7500, maxP: 100, blinds: BLINDS_REGULAR, speed: 'regular', game: 'PLO', variant: 'rebuy', rebuy: true, rebuyCost: 50, rebuyChips: 7500, bounty: false },

    // Monday Kickstart
    { day: 0, hour: 0, name: '★ Monday Kickstart', buyIn: 25, fee: 2.50, gtd: 2500, chips: 5000, maxP: 200, blinds: BLINDS_REGULAR, speed: 'regular', game: 'NLH', variant: 'freezeout', rebuy: false, bounty: false },

    // Thursday Bounty Bash
    { day: 3, hour: 0, name: '★ Thursday Bounty Bash', buyIn: 30, fee: 3.00, gtd: 3000, chips: 5000, maxP: 200, blinds: BLINDS_REGULAR, speed: 'regular', game: 'NLH', variant: 'bounty', rebuy: false, bounty: true, bountyAmt: 15, pko: true },

    // Tuesday Turbo Stack
    { day: 1, hour: 0, name: '★ Tuesday Turbo Stack', buyIn: 15, fee: 1.50, gtd: 1500, chips: 3000, maxP: 200, blinds: BLINDS_TURBO, speed: 'turbo', game: 'NLH', variant: 'freezeout', rebuy: false, bounty: false },
  ];

  // Build daily tournaments for 7 days
  for (let dayOffset = 0; dayOffset < 7; dayOffset++) {
    const day = new Date(monday);
    day.setDate(monday.getDate() + dayOffset);
    const dayName = dayNames[dayOffset];

    for (const t of dailySchedule) {
      const startTime = new Date(day);
      startTime.setUTCHours(t.hour, 0, 0, 0);
      // If hour < current day's start, it's next day
      if (t.hour < 8) { // 8 UTC = 3 AM ET, so "next day" events
        startTime.setDate(startTime.getDate() + 1);
      }

      const tourn = {
        name: `${dayName} ${t.name}`,
        game_type: t.game,
        variant: t.variant,
        tournament_type: 'MTT',
        buy_in_amount: t.buyIn,
        buy_in_fee: t.fee,
        guaranteed_prize: t.gtd,
        starting_chips: t.chips,
        max_players: t.maxP,
        min_players: 2,
        current_players: 0,
        status: 'REGISTERING',
        start_time: startTime.toISOString(),
        blind_structure: t.blinds,
        payout_structure: t.maxP >= 100 ? PAYOUT_10 : PAYOUT_5,
        blind_speed: t.speed,
        is_turbo: t.speed === 'turbo' || t.speed === 'hyper',
        late_reg_mins: t.speed === 'hyper' ? 15 : t.speed === 'turbo' ? 30 : 60,
        late_reg_levels: t.speed === 'hyper' ? 2 : t.speed === 'turbo' ? 3 : 4,
        union_id: UNION_ID,
        club_id: null,
        is_rebuy: t.rebuy || false,
        rebuy_cost: t.rebuyCost || 0,
        rebuy_chips: t.rebuyChips || 0,
        rebuy_levels: t.rebuy ? 4 : 0,
        is_reentry: false,
        add_on_available: t.rebuy || false,
        addon_cost: t.rebuyCost || 0,
        addon_chips: t.rebuyChips || 0,
        addon_levels: t.rebuy ? 1 : 0,
        is_bounty: t.bounty || false,
        bounty_amount: t.bountyAmt || 0,
        is_pko: t.pko || false,
        is_mystery_bounty: false,
        mystery_bounty_min: 0,
        mystery_bounty_max: 0,
        is_xmtt: false,
        is_multi_day: false,
        total_days: 1,
        day_number: 1,
        spin_type: 'standard',
        spin_multiplier: 0,
        prize_pool: 0,
        total_rake: 0,
      };
      tournaments.push(tourn);
    }

    // Add weekly specials for this day
    for (const t of weeklySpecials) {
      if (t.day === dayOffset) {
        const startTime = new Date(day);
        startTime.setUTCHours(t.hour, 0, 0, 0);
        if (t.hour < 8) startTime.setDate(startTime.getDate() + 1);

        tournaments.push({
          name: t.name,
          game_type: t.game,
          variant: t.variant,
          tournament_type: 'MTT',
          buy_in_amount: t.buyIn,
          buy_in_fee: t.fee,
          guaranteed_prize: t.gtd,
          starting_chips: t.chips,
          max_players: t.maxP,
          min_players: 2,
          current_players: 0,
          status: 'REGISTERING',
          start_time: startTime.toISOString(),
          blind_structure: t.blinds,
          payout_structure: PAYOUT_10,
          blind_speed: t.speed,
          is_turbo: t.speed === 'turbo' || t.speed === 'hyper',
          late_reg_mins: t.speed === 'hyper' ? 15 : t.speed === 'turbo' ? 30 : 60,
          late_reg_levels: t.speed === 'hyper' ? 2 : t.speed === 'turbo' ? 3 : 4,
          union_id: UNION_ID,
          club_id: null,
          is_rebuy: t.rebuy || false,
          rebuy_cost: t.rebuyCost || 0,
          rebuy_chips: t.rebuyChips || 0,
          rebuy_levels: t.rebuy ? 4 : 0,
          is_reentry: false,
          add_on_available: t.rebuy || false,
          addon_cost: t.rebuyCost || 0,
          addon_chips: t.rebuyChips || 0,
          addon_levels: t.rebuy ? 1 : 0,
          is_bounty: t.bounty || false,
          bounty_amount: t.bountyAmt || 0,
          is_pko: t.pko || false,
          is_mystery_bounty: false,
          mystery_bounty_min: 0,
          mystery_bounty_max: 0,
          is_xmtt: false,
          is_multi_day: false,
          total_days: 1,
          day_number: 1,
          spin_type: 'standard',
          spin_multiplier: 0,
          prize_pool: 0,
          total_rake: 0,
        });
      }
    }
  }

  return tournaments;
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXECUTION
// ═══════════════════════════════════════════════════════════════════════════════
async function run() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  MIDWAY UNION — COMPREHENSIVE TABLE & TOURNAMENT PROVISIONING');
  console.log('═══════════════════════════════════════════════════════════════\n');

  // ── Step 1: Delete existing tables under union ──
  console.log('═══ Step 1: Clear existing union tables ═══');
  const { data: oldTables } = await supabase.from('tables').select('id').eq('union_id', UNION_ID);
  if (oldTables && oldTables.length > 0) {
    await supabase.from('table_seats').delete().in('table_id', oldTables.map(t => t.id));
    const { error: delErr } = await supabase.from('tables').delete().eq('union_id', UNION_ID);
    console.log(`  Deleted ${oldTables.length} old tables: ${delErr ? '❌ ' + delErr.message : '✅'}`);
  } else {
    console.log('  No existing tables to delete');
  }

  // ── Step 2: Delete existing tournaments under union ──
  console.log('\n═══ Step 2: Clear existing union tournaments ═══');
  const { data: oldTourns } = await supabase.from('tournaments').select('id').eq('union_id', UNION_ID);
  if (oldTourns && oldTourns.length > 0) {
    await supabase.from('tournament_players').delete().in('tournament_id', oldTourns.map(t => t.id));
    const { error: delErr2 } = await supabase.from('tournaments').delete().eq('union_id', UNION_ID);
    console.log(`  Deleted ${oldTourns.length} old tournaments: ${delErr2 ? '❌ ' + delErr2.message : '✅'}`);
  } else {
    console.log('  No existing tournaments to delete');
  }

  // ── Step 3: Create cash tables ──
  console.log('\n═══ Step 3: Create cash game tables ═══');
  const cashTables = buildCashTables();
  let tableOk = 0;
  
  // Insert in batches of 20
  for (let i = 0; i < cashTables.length; i += 20) {
    const batch = cashTables.slice(i, i + 20).map(t => ({
      union_id: UNION_ID,
      club_id: null,
      name: t.name,
      game_type: 'cash',
      game_variant: t.variant,
      stakes: t.stakes,
      small_blind: t.sb,
      big_blind: t.bb,
      min_buy_in: t.min,
      max_buy_in: t.max,
      max_players: t.mp,
      current_players: 0,
      status: 'waiting',
    }));
    
    const { error } = await supabase.from('tables').insert(batch);
    if (error) {
      console.log(`  ❌ Batch ${Math.floor(i/20)+1} failed: ${error.message}`);
    } else {
      tableOk += batch.length;
    }
  }
  console.log(`  ✅ ${tableOk}/${cashTables.length} tables created`);

  // Print table breakdown
  const variants = {};
  for (const t of cashTables) {
    variants[t.variant] = (variants[t.variant] || 0) + 1;
  }
  console.log('  Breakdown:');
  for (const [v, c] of Object.entries(variants)) {
    console.log(`    ${v}: ${c} tables`);
  }

  // ── Step 4: Create tournaments ──
  console.log('\n═══ Step 4: Create tournaments ═══');
  const tournaments = buildTournaments();
  let tournOk = 0;

  // Insert in batches of 10
  for (let i = 0; i < tournaments.length; i += 10) {
    const batch = tournaments.slice(i, i + 10);
    const { error } = await supabase.from('tournaments').insert(batch);
    if (error) {
      console.log(`  ❌ Batch ${Math.floor(i/10)+1} failed: ${error.message}`);
      // Try one-by-one for this batch
      for (const t of batch) {
        const { error: eOne } = await supabase.from('tournaments').insert(t);
        if (eOne) {
          console.log(`    ❌ ${t.name}: ${eOne.message}`);
        } else {
          tournOk++;
        }
      }
    } else {
      tournOk += batch.length;
    }
  }
  console.log(`  ✅ ${tournOk}/${tournaments.length} tournaments created`);

  // ── Step 5: Verify ──
  console.log('\n═══ FINAL VERIFICATION ═══');
  const { data: ft } = await supabase.from('tables').select('id').eq('union_id', UNION_ID);
  const { data: ftn } = await supabase.from('tournaments').select('id').eq('union_id', UNION_ID);
  console.log(`Cash Tables: ${ft?.length || 0}`);
  console.log(`Tournaments: ${ftn?.length || 0}`);
  console.log('\nDone!');
}

run().catch(console.error);
