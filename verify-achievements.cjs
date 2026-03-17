#!/usr/bin/env node
const { createClient } = require('./node_modules/@supabase/supabase-js');
const sb = createClient(
  'https://kuklfnapbkmacvwxktbh.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt1a2xmbmFwYmttYWN2d3hrdGJoIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NzczMDg0NCwiZXhwIjoyMDgzMzA2ODQ0fQ.bbDqj-me78PID99npWCZ5qUuINSC1-eCBb1BVhgiSRs'
);

async function check() {
  console.log('=== Checking user_achievements table ===');
  const r = await sb.from('user_achievements').select('id').limit(1);
  if (r.error) {
    console.log('STATUS: MISSING -', r.error.message);
  } else {
    console.log('STATUS: EXISTS ✅ - rows:', (r.data || []).length);
  }
}

check().catch(e => console.error(e));
