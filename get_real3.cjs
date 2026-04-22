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
  const { data } = await supabase.from('profiles').select('*');
  
  // Real logic? Let's check how many have actual social auth or phone number
  const noEmail = data.filter(d => !d.email);
  console.log("No email count:", noEmail.length);
  
  // Checking phone number
  console.log("No email but phone:", noEmail.filter(d => d.phone).length);
  
  // We can look at the roles of hydra accounts
  const hydra = data.filter(d => d.email && d.email.includes('hydra.smarter.poker'));
  console.log("Hydra role breakdown:");
  const hydraRoles = {}; hydra.forEach(d => hydraRoles[d.role] = (hydraRoles[d.role] || 0) + 1);
  console.log(hydraRoles);

  // Let's filter everything
  const realUsers = data.filter(d => {
    // Exclude by email domain
    if (d.email) {
      const email = d.email.toLowerCase();
      if (email.includes('example.com') || email.includes('test.com') || email.includes('.test') || email.includes('hydra.smarter.poker') || email.includes('.local')) return false;
      // Maybe include smarter.poker if internal team, but depends
    }
    // Exclude by role
    if (d.role === 'god') return false; 
    
    // Also if email is null, are they real? 
    // They have to have some sign in. Let's see if we can exclude known bot patterns
    if (d.username && (d.username.includes('bot') || d.username.includes('test'))) return false;
    
    return true;
  });
  
  console.log("Rough real user count:", realUsers.length);
  console.log("How many of those are internal '@smarter.poker'?:", realUsers.filter(u => u.email && u.email.toLowerCase().includes('smarter.poker')).length);
  console.log("How many of those real users have null email?", realUsers.filter(u => !u.email).length);
  
  if(realUsers.filter(u => !u.email).length > 0) {
      console.log("Sample of null email users:", realUsers.filter(u => !u.email).slice(0,2).map(u => u.username));
  }
}
run();
