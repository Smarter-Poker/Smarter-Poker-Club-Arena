import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config({ path: '.env' });
const supabase = createClient(process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

supabase.from('hand_actions').select('*', { count: 'exact', head: true }).then(r => console.log('hand_actions:', r));
supabase.from('hands').select('*', { count: 'exact', head: true }).then(r => console.log('hands:', r));
