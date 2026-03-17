#!/usr/bin/env node
/**
 * Union-Only Table Architecture Migration
 * 
 * Rule: If a club is part of a union, tables use union_id NOT club_id.
 *       club_id is ONLY used for standalone clubs not attached to a union.
 */
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: 'postgresql://postgres.kuklfnapbkmacvwxktbh:215SlalomCt%21@aws-0-us-east-1.pooler.supabase.com:5432/postgres',
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 15000,
});

const MIDWAY_UNION_ID = 'fade0000-0000-0000-0000-a00000000001';
const CLUB_JAQK_ID = 'a0000000-0000-0000-0000-000000000001';
const SHARK_CLUB_ID = 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4';
const MIDWAY_CLUB_ID = 'fade0000-0000-0000-0000-000000000001';

async function run() {
  console.log('Connecting to Supabase PostgreSQL...');
  const client = await pool.connect();

  try {
    // ═════════════════════════════════════════════════════════════════════
    // STEP 1: Add union_id column to tables
    // ═════════════════════════════════════════════════════════════════════
    console.log('\n═══ Step 1: ALTER TABLE — Add union_id column ═══');
    await client.query(`
      ALTER TABLE tables ADD COLUMN IF NOT EXISTS union_id UUID REFERENCES unions(id) ON DELETE CASCADE;
      CREATE INDEX IF NOT EXISTS idx_tables_union ON tables(union_id);
      ALTER TABLE tables ALTER COLUMN club_id DROP NOT NULL;
    `);
    console.log('✅ union_id column added, club_id made nullable');

    // Verify column exists
    const colCheck = await client.query(`
      SELECT column_name, data_type, is_nullable 
      FROM information_schema.columns 
      WHERE table_schema = 'public' AND table_name = 'tables' AND column_name = 'union_id'
    `);
    console.log('Column verification:', colCheck.rows[0] || 'NOT FOUND');

    // ═════════════════════════════════════════════════════════════════════
    // STEP 2: Get Midway Union club's owner_id
    // ═════════════════════════════════════════════════════════════════════
    console.log('\n═══ Step 2: Get Midway Union owner ═══');
    const ownerRes = await client.query(
      `SELECT owner_id FROM clubs WHERE id = $1`, [MIDWAY_CLUB_ID]
    );
    if (ownerRes.rows.length === 0) {
      console.log('❌ ERROR: Midway Union club not found!');
      return;
    }
    const ownerId = ownerRes.rows[0].owner_id;
    console.log('Owner ID:', ownerId);

    // ═════════════════════════════════════════════════════════════════════
    // STEP 3: Create Midway Union in unions table
    // ═════════════════════════════════════════════════════════════════════
    console.log('\n═══ Step 3: Create Midway Union in unions table ═══');
    await client.query(`
      INSERT INTO unions (id, name, description, owner_id, settings)
      VALUES ($1, 'Midway Union', 'Central union connecting Shark Club and Club JAQK', $2,
        '{"revenue_share_percent": 10, "shared_player_pool": true, "cross_club_tournaments": true}'::jsonb)
      ON CONFLICT (id) DO NOTHING
    `, [MIDWAY_UNION_ID, ownerId]);
    console.log('✅ Midway Union created');

    // ═════════════════════════════════════════════════════════════════════
    // STEP 4: Link clubs to union
    // ═════════════════════════════════════════════════════════════════════
    console.log('\n═══ Step 4: Link Shark Club + Club JAQK ═══');
    await client.query(`
      INSERT INTO union_clubs (union_id, club_id) VALUES ($1, $2)
      ON CONFLICT (union_id, club_id) DO NOTHING
    `, [MIDWAY_UNION_ID, SHARK_CLUB_ID]);
    await client.query(`
      INSERT INTO union_clubs (union_id, club_id) VALUES ($1, $2)
      ON CONFLICT (union_id, club_id) DO NOTHING
    `, [MIDWAY_UNION_ID, CLUB_JAQK_ID]);
    console.log('✅ Both clubs linked');

    // ═════════════════════════════════════════════════════════════════════
    // STEP 5: Kill all existing tables from both clubs
    // ═════════════════════════════════════════════════════════════════════
    console.log('\n═══ Step 5: Kill existing tables ═══');
    
    // Count before delete
    const beforeCount = await client.query(
      `SELECT COUNT(*) as cnt FROM tables WHERE club_id IN ($1, $2)`,
      [CLUB_JAQK_ID, SHARK_CLUB_ID]
    );
    console.log(`Tables to delete: ${beforeCount.rows[0].cnt}`);

    // Delete seats first (FK constraint)
    await client.query(`
      DELETE FROM table_seats WHERE table_id IN (
        SELECT id FROM tables WHERE club_id IN ($1, $2)
      )
    `, [CLUB_JAQK_ID, SHARK_CLUB_ID]);
    console.log('✅ Seats cleared');

    // Delete tables
    const delResult = await client.query(`
      DELETE FROM tables WHERE club_id IN ($1, $2)
    `, [CLUB_JAQK_ID, SHARK_CLUB_ID]);
    console.log(`✅ ${delResult.rowCount} tables deleted`);

    // ═════════════════════════════════════════════════════════════════════
    // STEP 6: Create new tables under Midway Union
    // ═════════════════════════════════════════════════════════════════════
    console.log('\n═══ Step 6: Create tables under Midway Union ═══');

    const tables = [
      // NLH 9-max
      ['NLH Micro 0.10/0.20', 'nlh', '0.1/0.2', 0.10, 0.20, 8, 40, 9],
      ['NLH 0.25/0.50', 'nlh', '0.25/0.5', 0.25, 0.50, 20, 100, 9],
      ['NLH 0.50/1.00', 'nlh', '0.5/1', 0.50, 1.00, 40, 200, 9],
      ['NLH 1.00/2.00', 'nlh', '1/2', 1.00, 2.00, 80, 400, 9],
      ['NLH 2.00/5.00', 'nlh', '2/5', 2.00, 5.00, 200, 1000, 9],
      ['NLH 5.00/10.00', 'nlh', '5/10', 5.00, 10.00, 400, 2000, 6],
      // NLH 6-max
      ['NLH 6-Max 0.10/0.20', 'nlh', '0.1/0.2', 0.10, 0.20, 8, 40, 6],
      ['NLH 6-Max 0.50/1.00', 'nlh', '0.5/1', 0.50, 1.00, 40, 200, 6],
      ['NLH 6-Max 1.00/2.00', 'nlh', '1/2', 1.00, 2.00, 80, 400, 6],
      // PLO4
      ['PLO4 0.10/0.20', 'plo4', '0.1/0.2', 0.10, 0.20, 8, 40, 9],
      ['PLO4 0.25/0.50', 'plo4', '0.25/0.5', 0.25, 0.50, 20, 100, 9],
      ['PLO4 0.50/1.00', 'plo4', '0.5/1', 0.50, 1.00, 40, 200, 9],
      ['PLO4 1.00/2.00', 'plo4', '1/2', 1.00, 2.00, 80, 400, 6],
      ['PLO4 2.00/5.00', 'plo4', '2/5', 2.00, 5.00, 200, 1000, 6],
      ['PLO4 5.00/10.00', 'plo4', '5/10', 5.00, 10.00, 400, 2000, 6],
      // PLO5
      ['PLO5 0.25/0.50', 'plo5', '0.25/0.5', 0.25, 0.50, 20, 100, 6],
      ['PLO5 0.50/1.00', 'plo5', '0.5/1', 0.50, 1.00, 40, 200, 6],
      ['PLO5 1.00/2.00', 'plo5', '1/2', 1.00, 2.00, 80, 400, 6],
      ['PLO5 2.00/5.00', 'plo5', '2/5', 2.00, 5.00, 200, 1000, 6],
      // PLO8
      ['PLO8 0.25/0.50', 'plo8', '0.25/0.5', 0.25, 0.50, 20, 100, 9],
      ['PLO8 0.50/1.00', 'plo8', '0.5/1', 0.50, 1.00, 40, 200, 9],
      ['PLO8 1.00/2.00', 'plo8', '1/2', 1.00, 2.00, 80, 400, 9],
      ['PLO8 2.00/5.00', 'plo8', '2/5', 2.00, 5.00, 200, 1000, 6],
    ];

    let created = 0;
    for (const [name, variant, stakes, sb, bb, minBuy, maxBuy, seats] of tables) {
      try {
        await client.query(`
          INSERT INTO tables (union_id, club_id, name, game_type, game_variant, stakes, small_blind, big_blind, min_buy_in, max_buy_in, max_players, status)
          VALUES ($1, NULL, $2, 'cash', $3, $4, $5, $6, $7, $8, $9, 'waiting')
        `, [MIDWAY_UNION_ID, name, variant, stakes, sb, bb, minBuy, maxBuy, seats]);
        console.log(`  ✅ ${name}`);
        created++;
      } catch (err) {
        console.log(`  ❌ ${name}: ${err.message}`);
      }
    }
    console.log(`\n${created}/${tables.length} tables created`);

    // ═════════════════════════════════════════════════════════════════════
    // STEP 7: Add RLS policy for union-based visibility
    // ═════════════════════════════════════════════════════════════════════
    console.log('\n═══ Step 7: RLS policy for union tables ═══');
    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Members can view union tables' AND tablename = 'tables') THEN
          CREATE POLICY "Members can view union tables" ON tables
            FOR SELECT USING (
              union_id IN (
                SELECT uc.union_id FROM union_clubs uc
                JOIN club_members cm ON cm.club_id = uc.club_id
                WHERE cm.user_id = auth.uid()
              )
            );
        END IF;
      END $$;
    `);
    console.log('✅ RLS policy added');

    // ═════════════════════════════════════════════════════════════════════
    // STEP 8: Final verification
    // ═════════════════════════════════════════════════════════════════════
    console.log('\n═══ FINAL VERIFICATION ═══');
    const unionCount = await client.query(`SELECT COUNT(*) FROM unions WHERE id = $1`, [MIDWAY_UNION_ID]);
    const tableCount = await client.query(`SELECT COUNT(*) FROM tables WHERE union_id = $1`, [MIDWAY_UNION_ID]);
    const linkCount = await client.query(`SELECT COUNT(*) FROM union_clubs WHERE union_id = $1`, [MIDWAY_UNION_ID]);
    const oldCount = await client.query(`SELECT COUNT(*) FROM tables WHERE club_id IN ($1, $2)`, [CLUB_JAQK_ID, SHARK_CLUB_ID]);

    console.log(`Midway Union exists: ${unionCount.rows[0].count > 0 ? '✅' : '❌'}`);
    console.log(`Union tables: ${tableCount.rows[0].count}`);
    console.log(`Linked clubs: ${linkCount.rows[0].count}`);
    console.log(`Old club tables remaining: ${oldCount.rows[0].count}`);

  } catch (err) {
    console.error('❌ Migration failed:', err.message);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
