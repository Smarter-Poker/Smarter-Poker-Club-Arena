import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();
const supabase = createClient(process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const res = await supabase.rpc('exec_sql', { p_sql: "SELECT prosrc FROM pg_proc WHERE proname = 'fn_club_money_panel';" });
console.log(res.data[0].prosrc);
