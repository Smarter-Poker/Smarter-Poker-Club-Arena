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
  const { data } = await supabase.from('profiles').select('email, id, username, first_name');
  
  const emails = data.map(d => d.email).filter(e => e);
  const testPatterns = ['antiabuse', 'test', 'smarter.poker', 'smarterpoker', 'example.com', 'demo'];
  
  const realUsers = data.filter(d => {
    if (!d.email) return false;
    const email = d.email.toLowerCase();
    
    // check patterns
    for (const pattern of testPatterns) {
      if (email.includes(pattern)) return false;
    }
    
    // Check missing domains or local
    if (!email.includes('.')) return false;
    if (email.includes('.local')) return false;
    
    return true;
  });
  
  console.log("Real users count:", realUsers.length);
  realUsers.forEach(u => console.log(u.email));
}
run();
