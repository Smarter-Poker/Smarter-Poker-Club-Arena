const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

const envPath = path.resolve('../Smarter-Poker-World-Hub/.env.production.local');
const envContent = fs.readFileSync(envPath, 'utf-8');
const envVars = {};
envContent.split('\n').forEach(line => {
  const match = line.match(/^([^=]+)=(.*)$/);
  if (match) envVars[match[1]] = match[2].replace(/^"|"(.*?)$/g, '$1');
});

const url = envVars['NEXT_PUBLIC_SUPABASE_URL'];
const key = envVars['SUPABASE_SERVICE_ROLE_KEY'];

const supabase = createClient(url, key);

async function run() {
  const { data: withEmail } = await supabase.from('profiles').select('email').not('email', 'is', 'null');
  const { data: withLogin } = await supabase.from('profiles').select('last_login').not('last_login', 'is', 'null');
  
  console.log("Profiles with email:", withEmail?.length);
  console.log("Profiles with last_login:", withLogin?.length);
}
run();
