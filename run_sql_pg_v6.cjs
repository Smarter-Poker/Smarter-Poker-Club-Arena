const { Client } = require('pg');
const fs = require('fs');

async function run() {
  const uri = "postgres://postgres:215SlalomCt%21%21%21@db.kuklfnapbkmacvwxktbh.supabase.co:5432/postgres";
  const client = new Client({ connectionString: uri, ssl: { rejectUnauthorized: false } });
  
  try {
    await client.connect();
    console.log("Connected directly via IPv6!");
    const sql = fs.readFileSync('get_club_home_fixed.sql', 'utf8');
    await client.query(sql);
    console.log("SQL deployed successfully!");
    process.exit(0);
  } catch (err) {
    console.error("Failed:", err.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}
run();
