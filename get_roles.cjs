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
  const { data: statusData } = await supabase.from('profiles').select('status');
  const statuses = new Set(statusData?.map(d => d.status) || []);
  console.log("Statuses:", Array.from(statuses));

  const { data: roleData } = await supabase.from('profiles').select('role');
  const roles = new Set(roleData?.map(d => d.role) || []);
  console.log("Roles:", Array.from(roles));
  
  const { count: activeRealCount } = await supabase.from('profiles').select('*', { count: 'exact', head: true })
    .eq('status', 'active')
    .neq('role', 'bot');
  console.log("Count with status active and role != bot:", activeRealCount);
}
run();
