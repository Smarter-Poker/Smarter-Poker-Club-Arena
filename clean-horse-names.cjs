const { createClient } = require("@supabase/supabase-js");
const s = createClient("https://kuklfnapbkmacvwxktbh.supabase.co", process.env.SUPABASE_SERVICE_ROLE_KEY);

async function cleanNames() {
    // Get all horse profiles
    const { data: horses } = await s.from("profiles")
        .select("id, username, display_name, full_name")
        .eq("is_horse", true);

    console.log("Total horses:", horses.length);

    const existingNames = new Set();
    let updated = 0;

    for (const h of horses) {
        const updates = {};
        let newUsername = h.username;

        // 1. If full_name exists, use it as display_name
        if (h.full_name && h.full_name !== "null") {
            updates.display_name = h.full_name;
        }

        // 2. Clean up the display_name if it contains horse/hydra references
        if (h.display_name && (
            h.display_name.toLowerCase().includes("horse") ||
            h.display_name.includes("hydra") ||
            h.display_name.includes("v6")
        )) {
            // Clear out the bad display_name
            updates.display_name = null;
        }

        // 3. Clean up username: remove underscores (replace with spaces)
        if (newUsername && newUsername.includes("_")) {
            // Replace underscores with spaces but keep the name clean
            // e.g., DeepStack_AI -> DeepStack AI, BigSlick_Mike -> BigSlick Mike
            // But also handle suffixes like _CR, _F3B, _NB etc — drop them if they look like abbreviations
            newUsername = newUsername
                .replace(/_([A-Z]{1,4})$/g, '') // Remove trailing abbreviation suffixes like _CR, _F3B
                .replace(/_(\d+)$/g, '')         // Remove trailing number suffixes like _2
                .replace(/_/g, ' ')              // Replace remaining underscores with spaces
                .trim();
        }

        // 4. If username still contains horse/bot/hydra/v6, replace with a clean name
        const lower = (newUsername || "").toLowerCase();
        if (lower.includes("horse") || lower.includes("hydra") || lower.includes("v6")) {
            // These profiles never had a real name. Generate a clean human-like poker name.
            // Use first names that feel like real poker players
            const firstNames = [
                "Mike", "Steve", "Chris", "Danny", "Johnny", "Tony", "Bobby", "Eddie",
                "Tommy", "Frankie", "Joey", "Billy", "Vinny", "Sammy", "Mikey", "Jimmy",
                "Ricky", "Kenny", "Dave", "Matt", "Nick", "Jake", "Alex", "Brian",
                "Jason", "Kevin", "Ryan", "Tyler", "Kyle", "Marcus", "Andre", "Darius",
                "Wayne", "Carlos", "Craig", "Derek", "Eric", "Greg", "Ian", "Lance",
                "Omar", "Pete", "Ray", "Sean", "Todd", "Wade", "Zach", "Drew",
                "Cole", "Brent", "Chad", "Doug", "Evan", "Frank", "Hank", "Ivan",
                "Joel", "Kurt", "Leo", "Max", "Nate", "Oscar", "Phil", "Quinn",
                "Rob", "Scott", "Tim", "Vince", "Wes", "Xavier", "Yuri", "Zeke",
                "Aaron", "Blake", "Cal", "Dean", "Eli", "Finn", "Gabe", "Hugh",
                "Jack", "Keith", "Luke", "Mitch", "Noah", "Owen", "Patrick", "Russ",
                "Sam", "Troy", "Uri", "Val", "Will", "Xander", "Yale", "Zane"
            ];
            const lastInitials = ["A", "B", "C", "D", "E", "F", "G", "H", "J", "K", "L", "M", "N", "P", "R", "S", "T", "V", "W"];

            // Pick a unique name
            let attempts = 0;
            do {
                const idx = (updated + attempts) % firstNames.length;
                const li = (updated + attempts) % lastInitials.length;
                newUsername = firstNames[idx] + " " + lastInitials[li];
                attempts++;
            } while (existingNames.has(newUsername) && attempts < 500);
        }

        // 5. Check if the username changed
        if (newUsername !== h.username) {
            updates.username = newUsername;
        }

        // Apply updates if any
        if (Object.keys(updates).length > 0) {
            existingNames.add(updates.username || h.username);
            const { error } = await s.from("profiles").update(updates).eq("id", h.id);
            if (error) {
                console.log("ERROR:", h.username, "->", updates.username, error.message);
            } else {
                updated++;
                if (updated <= 20) {
                    console.log(`  "${h.username}" -> "${updates.username || h.username}" (display: ${updates.display_name === undefined ? 'unchanged' : updates.display_name})`);
                }
            }
        } else {
            existingNames.add(h.username);
        }
    }

    console.log(`\nUpdated ${updated} profiles`);

    // Final verification
    const { data: verify } = await s.from("profiles")
        .select("username, display_name")
        .eq("is_horse", true)
        .limit(20);

    console.log("\n=== SAMPLE (first 20) ===");
    verify?.forEach(v => console.log(`  "${v.username}" (display: ${v.display_name})`));

    // Check for remaining bad names
    const { data: allHorses } = await s.from("profiles")
        .select("username").eq("is_horse", true);

    const withUnderscore = allHorses?.filter(h => h.username?.includes("_"));
    const withHorse = allHorses?.filter(h => h.username?.toLowerCase().includes("horse"));
    const withBot = allHorses?.filter(h => h.username?.toLowerCase().includes("bot"));

    console.log("\n=== REMAINING ISSUES ===");
    console.log("With underscore:", withUnderscore?.length || 0);
    console.log("With horse:", withHorse?.length || 0);
    console.log("With bot:", withBot?.length || 0);
}

cleanNames();
