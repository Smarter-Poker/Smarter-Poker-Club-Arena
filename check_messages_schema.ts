import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

const serviceRoleKey = process.env.VITE_SUPABASE_SERVICE_ROLE_KEY || '';
const supabase = createClient(
  process.env.VITE_SUPABASE_URL || '',
  serviceRoleKey || process.env.VITE_SUPABASE_ANON_KEY || '',
  serviceRoleKey
    ? {
        global: {
          headers: {
            'x-smarter-data-actor': 'service',
            'x-smarter-data-protocol': '1',
          },
        },
      }
    : undefined
);

async function checkSchema() {
  const { data, error } = await supabase.from('messages').select('fake_column').limit(1);
  console.log('Error:', error);
  console.log('Data:', data);
}
checkSchema();
