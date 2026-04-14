const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '/Users/smarter.poker/Documents/club-arena/.env' });
const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseKey = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);
supabase.rpc('increment_table_seat_stack', { p_table_id: '123', p_user_id: '456', p_amount: 100 })
  .then(res => console.log('RPC Response:', res))
  .catch(err => console.error(err));
