import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

// Direct fetch with REST to list columns of unions
async function run() {
  const url = process.env.VITE_SUPABASE_URL + '/rest/v1/unions?limit=1';
  const response = await fetch(url, {
    method: 'OPTIONS', // often reveals schema
    headers: {
      apikey: process.env.VITE_SUPABASE_ANON_KEY!,
      Authorization: `Bearer ${process.env.VITE_SUPABASE_ANON_KEY!}`,
    },
  });

  const hdrs = Array.from(response.headers.entries());
  console.log('Headers:', hdrs);

  // Another trick: Select a non-existent column to see the hint
  const { error } = await createClient(
    process.env.VITE_SUPABASE_URL!,
    process.env.VITE_SUPABASE_ANON_KEY!
  )
    .from('unions')
    .select('fakecolumn')
    .limit(1);
  console.log('columns hint:', error?.hint);
}
run();
