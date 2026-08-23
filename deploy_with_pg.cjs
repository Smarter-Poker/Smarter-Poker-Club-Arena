const { Client } = require('pg');
const fs = require('fs');

async function run() {
  const client = new Client({
    host: 'aws-0-us-west-2.pooler.supabase.com',
    port: 5432,
    user: 'postgres.kuklfnapbkmacvwxktbh',
    password: '215SlalomCt!!!',
    database: 'postgres',
    ssl: { rejectUnauthorized: false }
  });

  try {
    await client.connect();
    console.log("Connected successfully to pooler!");
    
    // Kill existing queries
    await client.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE query ILIKE '%get_club_home%' AND pid <> pg_backend_pid();");
    console.log("Terminated blocking queries.");

    const sql = fs.readFileSync('get_club_home_fixed.sql', 'utf8');
    await client.query(sql);
    console.log("Migration applied successfully!");
    
  } catch (err) {
    console.error("Error:", err);
  } finally {
    await client.end();
  }
}
run();
