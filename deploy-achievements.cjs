#!/usr/bin/env node
// Deploy user_achievements table to production
const { Pool } = require('pg');

// Supabase pooler connection (transaction mode)
const pool = new Pool({
  connectionString: 'postgresql://postgres.kuklfnapbkmacvwxktbh:SmarterPoker2025!@aws-0-us-east-1.pooler.supabase.com:6543/postgres',
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 15000,
});

const SQL = `
-- Create user_achievements table
CREATE TABLE IF NOT EXISTS user_achievements (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  achievement_id TEXT NOT NULL,
  progress INTEGER DEFAULT 0,
  unlocked_at TIMESTAMP WITH TIME ZONE,
  is_unlocked BOOLEAN DEFAULT FALSE,
  rewards_claimed BOOLEAN DEFAULT FALSE,
  rewards_claimed_at TIMESTAMP WITH TIME ZONE,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_user_achievements_user ON user_achievements(user_id);
CREATE INDEX IF NOT EXISTS idx_user_achievements_unlocked ON user_achievements(unlocked_at) WHERE unlocked_at IS NOT NULL;

-- Enable RLS
ALTER TABLE user_achievements ENABLE ROW LEVEL SECURITY;

-- RLS Policies (idempotent)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Users can view own achievements' AND tablename = 'user_achievements') THEN
    CREATE POLICY "Users can view own achievements" ON user_achievements FOR SELECT USING (user_id = auth.uid());
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Users can insert own achievements' AND tablename = 'user_achievements') THEN
    CREATE POLICY "Users can insert own achievements" ON user_achievements FOR INSERT WITH CHECK (user_id = auth.uid());
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Users can update own achievements' AND tablename = 'user_achievements') THEN
    CREATE POLICY "Users can update own achievements" ON user_achievements FOR UPDATE USING (user_id = auth.uid());
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Service role full access to user_achievements' AND tablename = 'user_achievements') THEN
    CREATE POLICY "Service role full access to user_achievements" ON user_achievements FOR ALL USING (true) WITH CHECK (true);
  END IF;
END $$;
`;

async function deploy() {
  console.log('Connecting to Supabase PostgreSQL...');
  const client = await pool.connect();
  try {
    console.log('Deploying user_achievements table...');
    await client.query(SQL);
    console.log('✅ Deployment complete!');
    
    // Verify
    const res = await client.query("SELECT tablename FROM pg_tables WHERE tablename = 'user_achievements' AND schemaname = 'public'");
    console.log('Verification:', res.rows.length > 0 ? '✅ Table exists' : '❌ Table NOT found');
    
    // Check RLS
    const rls = await client.query("SELECT polname FROM pg_policies WHERE tablename = 'user_achievements'");
    console.log('RLS policies:', rls.rows.map(r => r.polname).join(', '));
  } catch (err) {
    console.error('❌ Deploy failed:', err.message);
  } finally {
    client.release();
    await pool.end();
  }
}

deploy();
