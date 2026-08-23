const { Client } = require('pg');
const fs = require('fs');

async function run() {
  const uri = "postgres://postgres.kuklfnapbkmacvwxktbh:215SlalomCt%21%21%21@aws-0-us-west-2.pooler.supabase.com:6543/postgres";
  const client = new Client({ connectionString: uri, ssl: { rejectUnauthorized: false } });
  
  try {
    await client.connect();
    console.log("Connected directly via IPv4 pooler!");
    
    // Deploy all unapplied migrations or just supabase/migrations/20260823240000_promo_wallet_cashier.sql?
    // Since we just need supabase/migrations/20260823240000_promo_wallet_cashier.sql to fix the RPC!
    const sql = fs.readFileSync('supabase/migrations/20260823240000_promo_wallet_cashier.sql', 'utf8');
    await client.query(sql);
    console.log("SQL deployed successfully!");
  } catch (err) {
    console.error("Failed:", err.message);
  } finally {
    await client.end();
  }
}
run();
