import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();
const supabase = createClient(process.env.VITE_SUPABASE_URL!, process.env.VITE_SUPABASE_ANON_KEY!);

async function run() {
  const tables = [
    'credit_invoices',
    'settlement_invoices',
    'user_achievements',
    'training_user_achievements',
    'union_wallets',
    'union_bank',
    'audit_logs',
    'club_arena_audit_logs',
    'platform_audit_logs',
  ];

  for (const table of tables) {
    const { error } = await supabase.from(table).select('*').limit(1);
    if (error && error.code === '42P01') {
      console.log(`❌ ${table} Not Found`);
    } else if (error) {
      console.log(`❓ ${table} Error: ${error.message}`);
    } else {
      console.log(`✅ ${table} EXACT MATCH`);
    }
  }
}
run();
