import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

const VITE_SUPABASE_URL = process.env.VITE_SUPABASE_URL || '';
const VITE_SUPABASE_ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY || '';
const supabase = createClient(VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY);

async function main() {
  const {
    data: { user },
  } = await supabase.auth.signInWithPassword({
    email: 'test@example.com', // wait, I don't know a password
    password: 'test',
  });
}
