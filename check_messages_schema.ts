import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

const supabase = createClient(
  process.env.VITE_SUPABASE_URL || '',
  process.env.VITE_SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY || ''
);

async function checkSchema() {
  const { data, error } = await supabase.from('messages').select('fake_column').limit(1);
  console.log('Error:', error);
  console.log('Data:', data);
}
checkSchema();
