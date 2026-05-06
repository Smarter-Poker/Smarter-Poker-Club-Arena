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
  const { data } = await supabase.from('profiles').select('email');
  
  const emails = data.map(d => d.email).filter(e => e);
  const realCount = emails.filter(e => !e.includes('example.com') && !e.includes('test.com') && !e.includes('debug') && !e.includes('god_')).length;
  console.log("Real emails count:", realCount);
  
  const dummyCount = emails.length - realCount;
  console.log("Dummy count:", dummyCount);
  
  const nullCount = data.length - emails.length;
  console.log("Null emails count:", nullCount);
  
  const domains = {};
  emails.forEach(e => {
    const domain = e.split('@')[1];
    if (domain) {
      domains[domain] = (domains[domain] || 0) + 1;
    }
  });
  console.log("Top domains:");
  Object.entries(domains)
    .sort((a,b) => b[1] - a[1])
    .slice(0, 10)
    .forEach(([d, c]) => console.log(`  ${d}: ${c}`));
}
run();
