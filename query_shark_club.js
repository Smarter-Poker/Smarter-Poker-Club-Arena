import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseKey = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;

const supabase = createClient(supabaseUrl, supabaseKey);

async function main() {
    const { data: club, error } = await supabase
        .from('clubs')
        .select('id, name, club_id')
        .eq('club_id', 25450)
        .maybeSingle();
    console.log('Shark Club Data:', club, 'Error:', error);
}
main();
