const { createClient } = require("@supabase/supabase-js");
const s = createClient("https://kuklfnapbkmacvwxktbh.supabase.co", process.env.SUPABASE_SERVICE_ROLE_KEY);

// 100 more unique poker-style alias names
const NEW_NAMES = [
    "StackBuilder", "RiverCard_RC", "BarrelDown", "SplashAround",
    "OrbitTight", "SetMiner_SM", "FlopConnect", "TurnBet_TB",
    "PotOdds_PO", "BlindBattle", "UTG_Grinder", "CO_Raiser",
    "SB_Warrior", "BB_Defend", "BtnStealer", "HiJack_HJ",
    "LoJack_LJ", "EP_Tight", "MP_Loose", "LP_Aggro",
    "FullRing_FR", "SixHanded_6M", "HeadsUp_HU", "ThreeMax_3M",
    "FinalFour", "BubbleBoy_BB", "ITM_Grinder", "ChipUp_CU",
    "LevelUp_LU", "BlindUp_BU", "AnteUp_2", "PostFlop_PF",
    "PreFlop_Hero", "RiverHero_RH", "TurnHero_TH", "FlopHero_FH",
    "NutsOnRiver", "StraightFlsh", "QuadsCity", "FullBoat_FB",
    "TwoPairTim", "TopKicker_TK", "SecondPair", "BottomSet_BS",
    "GutterHit", "OpenEnder_OE", "FlushDraw_FD", "OESD_Plus",
    "ComboTwist", "EquityComp", "FoldEquity_2", "BlockerBet_2",
    "LeadOut_LO", "DonkLead_DL", "CheckShove", "GameFlow_GF",
    "StackDepth_SD", "SPR_Calc", "EffStack_ES", "Ante_Action",
    "BlindVsBlnd", "3BetPot_3BP", "4BetRange_4BR", "5BetShove",
    "ColdCall_Kings", "FlatWithAces", "SlowRoll_NO", "TimelyAggro",
    "TextureRead", "RangeNarrow", "PolRange_PR", "MergedRange_2",
    "CapRange_2", "LinearRange", "CondRange_CR2", "NodeLock_NL",
    "FreqBased_FB2", "EVCalc_EV", "ICMSpot_ICM", "ChipEV_CEV",
    "DollarEV_DEV", "RiskPremium_RP", "VRatio_VR", "StackRisk_SR",
    "DepthCharge", "ShotTaker_ST", "BankRoll_BR", "ShotClock_SC",
    "GameSelect_GS", "SeatSelect_SS2", "TableBreak", "ColorUp_CU2",
    "RebuyKing_RK2", "AddOnPro", "LatRegKing", "DayTwoGrind", "DownToFour"
];

async function renameRemaining() {
    // Get ALL profiles to check existing names
    const { data: allProfiles } = await s.from("profiles").select("id, username").eq("is_horse", true);
    const existingNames = new Set(allProfiles.map(p => p.username));

    // Find bad names
    const badProfiles = allProfiles.filter(p =>
        p.username?.toLowerCase().includes("horse") ||
        p.username?.includes("hydra") ||
        p.username?.includes("v6")
    );

    console.log("Bad profiles to rename:", badProfiles.length);

    let nameIdx = 0;
    let renamed = 0;

    for (const profile of badProfiles) {
        while (nameIdx < NEW_NAMES.length && existingNames.has(NEW_NAMES[nameIdx])) {
            nameIdx++;
        }

        if (nameIdx >= NEW_NAMES.length) {
            // Generate a unique name from profile position
            const suffix = renamed + 200;
            const prefix = ["Ace", "King", "Queen", "Jack", "Ten", "Nine"][renamed % 6];
            const post = ["High", "Club", "River", "Turn", "Flop", "Blind"][Math.floor(renamed / 6) % 6];
            const uniqueName = `${prefix}${post}_${suffix}`;

            const { error } = await s.from("profiles").update({ username: uniqueName }).eq("id", profile.id);
            if (!error) { renamed++; existingNames.add(uniqueName); }
            continue;
        }

        const newName = NEW_NAMES[nameIdx];
        existingNames.add(newName);
        nameIdx++;

        const { error } = await s.from("profiles").update({ username: newName }).eq("id", profile.id);
        if (error) {
            console.log("ERROR:", profile.username, "->", newName, error.message);
        } else {
            renamed++;
        }
    }

    console.log("Renamed", renamed, "profiles");

    // Final verification
    const { data: verify } = await s.from("profiles").select("username").eq("is_horse", true);
    const stillBad = verify?.filter(h =>
        h.username?.toLowerCase().includes("horse") ||
        h.username?.includes("hydra") ||
        h.username?.includes("v6")
    );
    console.log("Still bad:", stillBad?.length || 0);
    if (stillBad?.length > 0) {
        stillBad.forEach(h => console.log("  -", h.username));
    }
}

renameRemaining();
