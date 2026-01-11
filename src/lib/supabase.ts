import { createClient } from '@supabase/supabase-js';
const supabaseUrl = 'YOUR_SUPABASE_URL';
const supabaseKey = 'YOUR_SUPABASE_KEY';
export const supabase = createClient(supabaseUrl, supabaseKey);
