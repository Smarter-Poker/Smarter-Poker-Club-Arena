#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  PURGE: Kill old club tournaments + Remove all horse activity
 * ═══════════════════════════════════════════════════════════════════════════════
 */
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = 'https://kuklfnapbkmacvwxktbh.supabase.co';
const SERVICE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt1a2xmbmFwYmttYWN2d3hrdGJoIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NzczMDg0NCwiZXhwIjoyMDgzMzA2ODQ0fQ.bbDqj-me78PID99npWCZ5qUuINSC1-eCBb1BVhgiSRs';

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
});

const CLUB_JAQK_ID = 'a0000000-0000-0000-0000-000000000001';
const SHARK_CLUB_ID = 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4';
const UNION_ID = 'fade0000-0000-0000-0000-a00000000001';

async function run() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  PURGE: Kill Old Games + Remove Horses');
  console.log('═══════════════════════════════════════════════════════════════\n');

  // ═══════════════════════════════════════════════════════════════════
  // STEP 1: Kill ALL old club-level tournaments (those with club_id set)
  // ═══════════════════════════════════════════════════════════════════
  console.log('═══ Step 1: Kill old club-level tournaments ═══');

  // Get all tournaments with club_id set (these are the OLD ones)
  const { data: oldTourns, error: otErr } = await supabase
    .from('tournaments')
    .select('id, name, club_id, status')
    .not('club_id', 'is', null);

  console.log(`  Found ${oldTourns?.length || 0} old club tournaments`);

  if (oldTourns && oldTourns.length > 0) {
    const ids = oldTourns.map(t => t.id);

    // Delete tournament_players first
    const { error: tpErr } = await supabase
      .from('tournament_players')
      .delete()
      .in('tournament_id', ids);
    console.log(`  Tournament players: ${tpErr ? '❌ ' + tpErr.message : '✅ cleaned'}`);

    // Delete tournaments in batches (supabase has query limits)
    let delCount = 0;
    for (let i = 0; i < ids.length; i += 50) {
      const batch = ids.slice(i, i + 50);
      const { error: delErr } = await supabase
        .from('tournaments')
        .delete()
        .in('id', batch);
      if (delErr) {
        console.log(`  ❌ Batch ${Math.floor(i/50)+1} failed: ${delErr.message}`);
      } else {
        delCount += batch.length;
      }
    }
    console.log(`  Deleted: ${delCount}/${oldTourns.length} old tournaments ✅`);
  }

  // ═══════════════════════════════════════════════════════════════════
  // STEP 2: Remove ALL horse profiles from tables
  // ═══════════════════════════════════════════════════════════════════
  console.log('\n═══ Step 2: Remove horse activity ═══');

  // Find horse user IDs
  const { data: horses } = await supabase
    .from('profiles')
    .select('id, username, display_name, is_horse')
    .eq('is_horse', true);

  console.log(`  Horse profiles found: ${horses?.length || 0}`);

  if (horses && horses.length > 0) {
    const horseIds = horses.map(h => h.id);

    // Remove from table_seats (active)
    const { data: horseSeats } = await supabase
      .from('table_seats')
      .select('id')
      .in('user_id', horseIds)
      .is('left_at', null);
    console.log(`  Active horse seats: ${horseSeats?.length || 0}`);

    if (horseSeats && horseSeats.length > 0) {
      const { error: seatErr } = await supabase
        .from('table_seats')
        .update({ left_at: new Date().toISOString() })
        .in('user_id', horseIds)
        .is('left_at', null);
      console.log(`  Horse seats cleared: ${seatErr ? '❌ ' + seatErr.message : '✅'}`);
    }

    // Remove from tournament_players
    const { data: horseTPlayers } = await supabase
      .from('tournament_players')
      .select('id')
      .in('user_id', horseIds);
    console.log(`  Horse tournament registrations: ${horseTPlayers?.length || 0}`);

    if (horseTPlayers && horseTPlayers.length > 0) {
      const { error: tpErr } = await supabase
        .from('tournament_players')
        .delete()
        .in('user_id', horseIds);
      console.log(`  Horse tournament entries deleted: ${tpErr ? '❌ ' + tpErr.message : '✅'}`);
    }

    // Remove from table_waitlists
    const { error: wlErr } = await supabase
      .from('table_waitlists')
      .delete()
      .in('user_id', horseIds);
    console.log(`  Horse waitlist entries: ${wlErr ? '❌ ' + wlErr.message : '✅ cleaned'}`);

    // List the horses
    console.log('  Horses:');
    for (const h of horses) {
      console.log(`    ${h.username || h.display_name || h.id.slice(0,12)}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // STEP 3: Clear any active seats on union tables (fresh start)
  // ═══════════════════════════════════════════════════════════════════
  console.log('\n═══ Step 3: Clear all active seats ═══');
  const { data: activeSeats } = await supabase
    .from('table_seats')
    .select('id, table_id, user_id')
    .is('left_at', null);

  console.log(`  Active seats remaining: ${activeSeats?.length || 0}`);
  if (activeSeats && activeSeats.length > 0) {
    const { error: clearErr } = await supabase
      .from('table_seats')
      .update({ left_at: new Date().toISOString() })
      .is('left_at', null);
    console.log(`  All seats cleared: ${clearErr ? '❌ ' + clearErr.message : '✅'}`);

    // Reset current_players on all tables
    const { error: resetErr } = await supabase
      .from('tables')
      .update({ current_players: 0 })
      .eq('union_id', UNION_ID);
    console.log(`  Table player counts reset: ${resetErr ? '❌ ' + resetErr.message : '✅'}`);
  }

  // ═══════════════════════════════════════════════════════════════════
  // STEP 4: Reset all table statuses to 'waiting'
  // ═══════════════════════════════════════════════════════════════════
  console.log('\n═══ Step 4: Reset table statuses ═══');
  const { error: statusErr } = await supabase
    .from('tables')
    .update({ status: 'waiting', current_players: 0 })
    .eq('union_id', UNION_ID);
  console.log(`  All tables reset to 'waiting': ${statusErr ? '❌ ' + statusErr.message : '✅'}`);

  // ═══════════════════════════════════════════════════════════════════
  // FINAL VERIFICATION
  // ═══════════════════════════════════════════════════════════════════
  console.log('\n═══ FINAL VERIFICATION ═══');
  const { data: ft } = await supabase.from('tables').select('id').eq('union_id', UNION_ID);
  const { data: ftn } = await supabase.from('tournaments').select('id, club_id, union_id');
  const unionTourns = (ftn || []).filter(t => t.union_id && !t.club_id);
  const clubTourns = (ftn || []).filter(t => t.club_id);
  const { data: fs } = await supabase.from('table_seats').select('id').is('left_at', null);
  const { data: fh } = await supabase.from('profiles').select('id').eq('is_horse', true);

  console.log(`Union cash tables: ${ft?.length || 0}`);
  console.log(`Union tournaments (clean, no club_id): ${unionTourns.length}`);
  console.log(`Old club tournaments remaining: ${clubTourns.length}`);
  console.log(`Active seats: ${fs?.length || 0}`);
  console.log(`Total horse profiles: ${fh?.length || 0}`);
  console.log(`\n${clubTourns.length === 0 && (fs?.length || 0) === 0 ? '✅ ALL CLEAN!' : '⚠️ Some items remain'}`);
}

run().catch(console.error);
