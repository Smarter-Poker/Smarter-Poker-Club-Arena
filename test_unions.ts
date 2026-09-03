import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

async function run() {
  const supabase = createClient(
    process.env.VITE_SUPABASE_URL!,
    process.env.VITE_SUPABASE_ANON_KEY!
  );
  const { data, error } = await supabase.from('unions').select('*').limit(1);
  if (data && data.length > 0) {
    console.log('unions keys:', Object.keys(data[0]));
  } else {
    // try to get columns using a trick: insert fake data and see validation error
    const { error: insErr } = await supabase.from('unions').insert({ __fake__: true });
    console.log('unions insert error:', insErr);
  }
}
run();
