#!/usr/bin/env node
/**
 * Union-Only Table Architecture Migration
 * Uses supabase-js service role for data ops + Management API for DDL
 */
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = 'https://kuklfnapbkmacvwxktbh.supabase.co';
const SERVICE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt1a2xmbmFwYmttYWN2d3hrdGJoIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NzczMDg0NCwiZXhwIjoyMDgzMzA2ODQ0fQ.bbDqj-me78PID99npWCZ5qUuINSC1-eCBb1BVhgiSRs';

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
});

const MIDWAY_UNION_ID = 'fade0000-0000-0000-0000-a00000000001';
const CLUB_JAQK_ID = 'a0000000-0000-0000-0000-000000000001';
const SHARK_CLUB_ID = 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4';
const MIDWAY_CLUB_ID = 'fade0000-0000-0000-0000-000000000001';

// Execute raw SQL via Supabase's pg-meta endpoint
async function execSQL(sql) {
  const res = await fetch(`${SUPABASE_URL}/pg`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${SERVICE_KEY}`,
      'apikey': SERVICE_KEY,
      'X-Connection-Encrypted': 'true'
    },
    body: JSON.stringify({ query: sql })
  });
  
  if (!res.ok) {
    // Try alternate endpoint
    const res2 = await fetch(`${SUPABASE_URL}/sql`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SERVICE_KEY}`,
        'apikey': SERVICE_KEY, 
      },
      body: JSON.stringify({ query: sql })
    });
    if (!res2.ok) {
      const txt = await res2.text().catch(() => '');
      return { error: `SQL API failed: ${res2.status} ${txt}` };
    }
    return { data: await res2.json().catch(() => ({})) };
  }
  return { data: await res.json().catch(() => ({})) };
}

async function run() {
  // ═════════════════════════════════════════════════════════════════════
  // STEP 1: ALTER TABLE via SQL endpoint
  // ═════════════════════════════════════════════════════════════════════
  console.log('═══ Step 1: ALTER TABLE — Add union_id ═══');
  
  const ddl = await execSQL(`
    ALTER TABLE tables ADD COLUMN IF NOT EXISTS union_id UUID REFERENCES unions(id) ON DELETE CASCADE;
    CREATE INDEX IF NOT EXISTS idx_tables_union ON tables(union_id);
    ALTER TABLE tables ALTER COLUMN club_id DROP NOT NULL;
  `);
  
  if (ddl.error) {
    console.log('DDL via SQL API failed:', ddl.error);
    console.log('⚠️  You may need to run this SQL manually in Supabase Dashboard:');
    console.log('   ALTER TABLE tables ADD COLUMN IF NOT EXISTS union_id UUID REFERENCES unions(id) ON DELETE CASCADE;');
    console.log('   CREATE INDEX IF NOT EXISTS idx_tables_union ON tables(union_id);');
    console.log('   ALTER TABLE tables ALTER COLUMN club_id DROP NOT NULL;');
    console.log('');
    console.log('Continuing with data operations...');
  } else {
    console.log('✅ DDL executed successfully');
  }

  // Test if union_id column exists by trying to select it
  const colTest = await supabase.from('tables').select('union_id').limit(1);
  if (colTest.error && colTest.error.message.includes('union_id')) {
    console.log('❌ union_id column does NOT exist yet. Please run the ALTER TABLE SQL manually.');
    console.log('   Go to: https://supabase.com/dashboard → SQL Editor → paste:');
    console.log('   ALTER TABLE tables ADD COLUMN IF NOT EXISTS union_id UUID REFERENCES unions(id) ON DELETE CASCADE;');
    console.log('   ALTER TABLE tables ALTER COLUMN club_id DROP NOT NULL;');
    return;
  }
  console.log('✅ union_id column exists');

  // ═════════════════════════════════════════════════════════════════════
  // STEP 2: Get Midway Union owner
  // ═════════════════════════════════════════════════════════════════════
  console.log('\n═══ Step 2: Get Midway Union owner ═══');
  const { data: muClub } = await supabase
    .from('clubs')
    .select('owner_id')
    .eq('id', MIDWAY_CLUB_ID)
    .single();
  
  if (!muClub) {
    console.log('❌ Midway Union club not found');
    return;
  }
  console.log('Owner ID:', muClub.owner_id);

  // ═════════════════════════════════════════════════════════════════════
  // STEP 3: Create Midway Union in unions table
  // ═════════════════════════════════════════════════════════════════════
  console.log('\n═══ Step 3: Create Midway Union ═══');
  const { error: uErr } = await supabase.from('unions').upsert({
    id: MIDWAY_UNION_ID,
    name: 'Midway Union',
    description: 'Central union connecting Shark Club and Club JAQK',
    owner_id: muClub.owner_id,
    settings: { revenue_share_percent: 10, shared_player_pool: true, cross_club_tournaments: true }
  }, { onConflict: 'id' });
  console.log(uErr ? `❌ ${uErr.message}` : '✅ Union created');

  // ═════════════════════════════════════════════════════════════════════
  // STEP 4: Link clubs
  // ═════════════════════════════════════════════════════════════════════
  console.log('\n═══ Step 4: Link clubs to union ═══');
  for (const [name, cid] of [['SHARK CLUB', SHARK_CLUB_ID], ['Club JAQK', CLUB_JAQK_ID]]) {
    const { error } = await supabase.from('union_clubs').upsert(
      { union_id: MIDWAY_UNION_ID, club_id: cid },
      { onConflict: 'union_id,club_id' }
    );
    console.log(`  ${name}: ${error ? '❌ ' + error.message : '✅'}`);
  }

  // ═════════════════════════════════════════════════════════════════════
  // STEP 5: Kill existing tables
  // ═════════════════════════════════════════════════════════════════════
  console.log('\n═══ Step 5: Kill existing tables ═══');
  
  // Get table IDs to delete seats
  const { data: oldTables } = await supabase.from('tables').select('id')
    .in('club_id', [CLUB_JAQK_ID, SHARK_CLUB_ID]);
  console.log(`Found ${oldTables?.length || 0} tables to delete`);
  
  if (oldTables && oldTables.length > 0) {
    const ids = oldTables.map(t => t.id);
    await supabase.from('table_seats').delete().in('table_id', ids);
    console.log('  Seats cleared');
    const { error: delErr } = await supabase.from('tables').delete()
      .in('club_id', [CLUB_JAQK_ID, SHARK_CLUB_ID]);
    console.log(`  Tables: ${delErr ? '❌ ' + delErr.message : '✅ Deleted'}`);
  }

  // ═════════════════════════════════════════════════════════════════════
  // STEP 6: Create union tables
  // ═════════════════════════════════════════════════════════════════════
  console.log('\n═══ Step 6: Create tables under Midway Union ═══');
  
  const tables = [
    { name: 'NLH Micro 0.10/0.20', v: 'nlh', s: '0.1/0.2', sb: 0.10, bb: 0.20, min: 8, max: 40, mp: 9 },
    { name: 'NLH 0.25/0.50', v: 'nlh', s: '0.25/0.5', sb: 0.25, bb: 0.50, min: 20, max: 100, mp: 9 },
    { name: 'NLH 0.50/1.00', v: 'nlh', s: '0.5/1', sb: 0.50, bb: 1.00, min: 40, max: 200, mp: 9 },
    { name: 'NLH 1.00/2.00', v: 'nlh', s: '1/2', sb: 1.00, bb: 2.00, min: 80, max: 400, mp: 9 },
    { name: 'NLH 2.00/5.00', v: 'nlh', s: '2/5', sb: 2.00, bb: 5.00, min: 200, max: 1000, mp: 9 },
    { name: 'NLH 5.00/10.00', v: 'nlh', s: '5/10', sb: 5.00, bb: 10.00, min: 400, max: 2000, mp: 6 },
    { name: 'NLH 6-Max 0.10/0.20', v: 'nlh', s: '0.1/0.2', sb: 0.10, bb: 0.20, min: 8, max: 40, mp: 6 },
    { name: 'NLH 6-Max 0.50/1.00', v: 'nlh', s: '0.5/1', sb: 0.50, bb: 1.00, min: 40, max: 200, mp: 6 },
    { name: 'NLH 6-Max 1.00/2.00', v: 'nlh', s: '1/2', sb: 1.00, bb: 2.00, min: 80, max: 400, mp: 6 },
    { name: 'PLO4 0.10/0.20', v: 'plo4', s: '0.1/0.2', sb: 0.10, bb: 0.20, min: 8, max: 40, mp: 9 },
    { name: 'PLO4 0.25/0.50', v: 'plo4', s: '0.25/0.5', sb: 0.25, bb: 0.50, min: 20, max: 100, mp: 9 },
    { name: 'PLO4 0.50/1.00', v: 'plo4', s: '0.5/1', sb: 0.50, bb: 1.00, min: 40, max: 200, mp: 9 },
    { name: 'PLO4 1.00/2.00', v: 'plo4', s: '1/2', sb: 1.00, bb: 2.00, min: 80, max: 400, mp: 6 },
    { name: 'PLO4 2.00/5.00', v: 'plo4', s: '2/5', sb: 2.00, bb: 5.00, min: 200, max: 1000, mp: 6 },
    { name: 'PLO4 5.00/10.00', v: 'plo4', s: '5/10', sb: 5.00, bb: 10.00, min: 400, max: 2000, mp: 6 },
    { name: 'PLO5 0.25/0.50', v: 'plo5', s: '0.25/0.5', sb: 0.25, bb: 0.50, min: 20, max: 100, mp: 6 },
    { name: 'PLO5 0.50/1.00', v: 'plo5', s: '0.5/1', sb: 0.50, bb: 1.00, min: 40, max: 200, mp: 6 },
    { name: 'PLO5 1.00/2.00', v: 'plo5', s: '1/2', sb: 1.00, bb: 2.00, min: 80, max: 400, mp: 6 },
    { name: 'PLO5 2.00/5.00', v: 'plo5', s: '2/5', sb: 2.00, bb: 5.00, min: 200, max: 1000, mp: 6 },
    { name: 'PLO8 0.25/0.50', v: 'plo8', s: '0.25/0.5', sb: 0.25, bb: 0.50, min: 20, max: 100, mp: 9 },
    { name: 'PLO8 0.50/1.00', v: 'plo8', s: '0.5/1', sb: 0.50, bb: 1.00, min: 40, max: 200, mp: 9 },
    { name: 'PLO8 1.00/2.00', v: 'plo8', s: '1/2', sb: 1.00, bb: 2.00, min: 80, max: 400, mp: 9 },
    { name: 'PLO8 2.00/5.00', v: 'plo8', s: '2/5', sb: 2.00, bb: 5.00, min: 200, max: 1000, mp: 6 },
  ];

  let created = 0;
  for (const t of tables) {
    const { error } = await supabase.from('tables').insert({
      union_id: MIDWAY_UNION_ID,
      club_id: null,
      name: t.name,
      game_type: 'cash',
      game_variant: t.v,
      stakes: t.s,
      small_blind: t.sb,
      big_blind: t.bb,
      min_buy_in: t.min,
      max_buy_in: t.max,
      max_players: t.mp,
      status: 'waiting'
    });
    if (error) {
      console.log(`  ❌ ${t.name}: ${error.message}`);
    } else {
      console.log(`  ✅ ${t.name}`);
      created++;
    }
  }
  console.log(`\n${created}/${tables.length} tables created`);

  // ═════════════════════════════════════════════════════════════════════
  // STEP 7: Verify
  // ═════════════════════════════════════════════════════════════════════
  console.log('\n═══ FINAL VERIFICATION ═══');
  const { data: ut } = await supabase.from('tables').select('id').eq('union_id', MIDWAY_UNION_ID);
  const { data: ul } = await supabase.from('union_clubs').select('club_id').eq('union_id', MIDWAY_UNION_ID);
  const { data: ot } = await supabase.from('tables').select('id').in('club_id', [CLUB_JAQK_ID, SHARK_CLUB_ID]);
  
  console.log(`Union tables: ${ut?.length || 0}`);
  console.log(`Linked clubs: ${ul?.length || 0}`);
  console.log(`Old club tables: ${ot?.length || 0}`);
}

run().catch(console.error);
