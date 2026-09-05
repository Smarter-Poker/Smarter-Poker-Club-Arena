import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

const supabase = createClient(process.env.VITE_SUPABASE_URL!, process.env.VITE_SUPABASE_ANON_KEY!);

function requireTestUserEmail(): string {
  const email = process.env.TEST_USER_EMAIL;
  if (!email) throw new Error('TEST_USER_EMAIL is not set - refusing to guess an account');
  return email;
}

async function run() {
  console.log('Signing in...');
  const { data, error } = await supabase.auth.signInWithPassword({
    // 2026-09-04: this reset a hardcoded PERSONAL account's profile to
    // 'New Player'. It reads TEST_USER_EMAIL from .env.local now and refuses
    // to run without it.
    email: requireTestUserEmail(),
    password: process.env.TEST_USER_PASSWORD,
  });

  if (error) {
    console.error('Login failed:', error);
    return;
  }

  const userId = data.user.id;
  console.log('Logged in user:', userId);

  // Reset the display name and username
  const { error: updateProfErr } = await supabase
    .from('profiles')
    .update({ username: 'Player1234', display_name: 'New Player' })
    .eq('id', userId);

  if (updateProfErr) console.error('Error updating profile:', updateProfErr);

  const { error: updateUsrErr } = await supabase
    .from('users')
    .update({ username: 'Player1234' })
    .eq('id', userId);

  if (updateUsrErr) console.error('Error updating users:', updateUsrErr);

  console.log('Reset successful. User should now see the Complete Profile modal.');
}

run();
