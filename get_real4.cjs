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
  const fakeDomains = ['hydra.smarter.poker', 'test.com', 'smarter.poker', 'example.com', 'midwayunion.test', 'smarter.poker.local'];
  
  const realEmails = emails.filter(e => {
    const domain = e.split('@')[1];
    return !fakeDomains.includes(domain?.toLowerCase());
  });
  
  console.log("Real emails:", realEmails.length);
  console.log(realEmails);
}
run();
