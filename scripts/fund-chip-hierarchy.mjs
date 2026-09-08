/**
 * CHIP FUNDING HIERARCHY EXECUTION SCRIPT
 *
 * Uses the real ChipFlowService and AgentService logic to:
 * 1. Assign player_numbers to all horses
 * 2. Clean up old placeholder agents
 * 3. Promote 5 horses to agents per club (10 total)
 * 4. Assign remaining horses under agents via player_number referral codes
 * 5. Reset ALL horse wallet balances to 0
 * 6. Mint chips to Union Owner (KingFish)
 * 7. Fund: KingFish → Agents → Players with complete transaction logging
 * 8. Verify the entire ledger
 *
 * Flow: Union Owner (KingFish) → Agents → Players
 * (Club owner = Union owner = KingFish, so Union → Club is internal ledger)
 */

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://kuklfnapbkmacvwxktbh.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
  global: {
    headers: {
      'x-smarter-data-actor': 'service',
      'x-smarter-data-protocol': '1',
    },
  },
});

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════
const KINGFISH_ID = '47965354-0e56-43ef-931c-ddaab82af765';
const SHARK_CLUB_ID = 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4';
const JAQK_CLUB_ID = 'a0000000-0000-0000-0000-000000000001';
const UNION_ID = 'fade0000-0000-0000-0000-000000000001';

const CHIPS_PER_PLAYER = 5000;
const AGENT_BUFFER = 10000;

const exact = (v) => Math.trunc(v * 100) / 100;

// Valid commission rates: 40%, 45%, 50%, 55%, 60%, 65%, 70%
const VALID_COMMISSION_RATES = [0.40, 0.45, 0.50, 0.55, 0.60, 0.65, 0.70];
const randomRate = () => VALID_COMMISSION_RATES[Math.floor(Math.random() * VALID_COMMISSION_RATES.length)];
const randomBool = () => Math.random() > 0.5;
// Credit lines: random between 10000 and 500000 in 5000 increments
const randomCreditLine = () => (Math.floor(Math.random() * 99) + 2) * 5000; // 10000 to 500000
// Display rate as clean integer percentage
const rateDisplay = (r) => Math.round(r * 100);

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS (mirror the service RPCs)
// ═══════════════════════════════════════════════════════════════════════════════

async function creditWallet(userId, amount) {
    const { error } = await supabase.rpc('credit_player_wallet', {
        p_user_id: userId,
        p_amount: exact(amount),
    });
    if (error) throw new Error(`Credit failed for ${userId}: ${error.message}`);
}

async function deductWallet(userId, amount) {
    const { data, error } = await supabase.rpc('deduct_player_wallet', {
        p_user_id: userId,
        p_amount: exact(amount),
    });
    if (error) throw new Error(`Deduct failed for ${userId}: ${error.message}`);
    if (data === false) throw new Error(`Insufficient balance for ${userId}`);
}

async function logTx(userId, walletType, amount, type, category, description, relatedEntityId = null) {
    const { error } = await supabase.rpc('log_wallet_transaction', {
        p_user_id: userId,
        p_wallet_type: walletType,
        p_amount: exact(Math.abs(amount)),
        p_type: type,
        p_category: category,
        p_description: description,
        p_table_id: null,
        p_hand_id: null,
        p_related_entity_id: relatedEntityId,
    });
    if (error) console.error(`  TX LOG: ${error.message}`);
}

async function transfer(fromId, toId, amount, category, fromDesc, toDesc, relatedId = null) {
    const amt = exact(amount);
    await deductWallet(fromId, amt);
    await logTx(fromId, 'PLAYER', amt, 'debit', category, fromDesc, relatedId || toId);
    await creditWallet(toId, amt);
    await logTx(toId, 'PLAYER', amt, 'credit', category, toDesc, relatedId || fromId);
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════════

async function main() {
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║     CHIP FUNDING HIERARCHY — Full Chain Execution           ║');
    console.log('║     Union Owner → Club → Agents → Players                   ║');
    console.log('╚══════════════════════════════════════════════════════════════╝\n');

    // ─── STEP 1: Load all horses ────────────────────────────────────────────
    console.log('STEP 1: Loading all horses...');
    const { data: horses, error: hErr } = await supabase
        .from('profiles')
        .select('id, username, display_name, player_number')
        .eq('is_horse', true)
        .order('username');

    if (hErr) throw hErr;
    console.log(`  Found ${horses.length} horses\n`);

    // ─── STEP 2: Assign player_numbers to all horses ────────────────────────
    console.log('STEP 2: Assigning player_numbers (referral codes)...');
    const usedNumbers = new Set();
    // Gather existing numbers
    const { data: allProfiles } = await supabase
        .from('profiles')
        .select('player_number')
        .not('player_number', 'is', null);
    (allProfiles || []).forEach(p => usedNumbers.add(p.player_number));

    let numbersAssigned = 0;
    for (const horse of horses) {
        if (!horse.player_number) {
            let num;
            do {
                num = 1000 + Math.floor(Math.random() * 899000);
            } while (usedNumbers.has(num));
            usedNumbers.add(num);

            await supabase
                .from('profiles')
                .update({ player_number: num })
                .eq('id', horse.id);
            horse.player_number = num;
            numbersAssigned++;
        }
    }
    console.log(`  Assigned ${numbersAssigned} new player_numbers`);
    console.log(`  All horses now have referral codes\n`);

    // ─── STEP 3: Ensure all horses have wallets ─────────────────────────────
    console.log('STEP 3: Ensuring all horses have PLAYER/BUSINESS/PROMO wallets...');
    const horseIds = horses.map(h => h.id);
    const { data: existingWallets } = await supabase
        .from('wallets')
        .select('user_id, wallet_type')
        .in('user_id', horseIds);

    const walletSet = new Set((existingWallets || []).map(w => `${w.user_id}:${w.wallet_type}`));
    let walletsCreated = 0;

    for (const horse of horses) {
        for (const wt of ['PLAYER', 'BUSINESS', 'PROMO']) {
            if (!walletSet.has(`${horse.id}:${wt}`)) {
                const { error } = await supabase.from('wallets').insert({
                    user_id: horse.id,
                    wallet_type: wt,
                    balance: 0,
                    locked_balance: 0,
                });
                if (!error) walletsCreated++;
            }
        }
    }
    console.log(`  Created ${walletsCreated} missing wallets\n`);

    // ─── STEP 4: Clean up old placeholder agents ────────────────────────────
    console.log('STEP 4: Cleaning up old placeholder agents...');

    // Clear agent_id references on all horse members first
    for (const clubId of [SHARK_CLUB_ID, JAQK_CLUB_ID]) {
        await supabase
            .from('club_members')
            .update({ agent_id: null })
            .eq('club_id', clubId)
            .in('user_id', horseIds);
    }

    // Delete placeholder agent club_members (face0000-...)
    const { data: fakeCMs } = await supabase
        .from('club_members')
        .select('user_id, club_id')
        .like('user_id', 'face0000-%');
    for (const fm of (fakeCMs || [])) {
        await supabase.from('club_members')
            .delete()
            .eq('user_id', fm.user_id)
            .eq('club_id', fm.club_id);
    }
    console.log(`  Removed ${(fakeCMs || []).length} placeholder club memberships`);

    // Delete placeholder agent records
    const { data: fakeAgents } = await supabase
        .from('agents')
        .delete()
        .like('user_id', 'face0000-%')
        .select('id');
    console.log(`  Removed ${(fakeAgents || []).length} placeholder agent records\n`);

    // ─── STEP 5: Promote 5 horses to agents per club ────────────────────────
    console.log('STEP 5: Promoting horses to agent status...');

    // Sort horses by username for consistent selection
    const sortedHorses = [...horses].sort((a, b) => a.username.localeCompare(b.username));

    // Pick 5 for SHARK CLUB, 5 for JAQK (different horses for each)
    const sharkAgents = sortedHorses.slice(0, 5);
    const jaqkAgents = sortedHorses.slice(5, 10);

    // Promote SHARK CLUB agents (random commission rates, credit types, credit lines)
    console.log('\n  SHARK CLUB Agents:');
    const sharkAgentConfigs = [];
    for (const agent of sharkAgents) {
        const commRate = randomRate();
        const isPrepaid = randomBool();
        const creditLine = isPrepaid ? 0 : randomCreditLine();
        const rakebackRate = Math.trunc(commRate * 100 * 0.3) / 10000; // ~30% of commission as player rakeback

        sharkAgentConfigs.push({ agent, commRate, isPrepaid, creditLine, rakebackRate });

        // Create agent record
        const { error: agentErr } = await supabase.from('agents').insert({
            user_id: agent.id,
            club_id: SHARK_CLUB_ID,
            role: 'agent',
            status: 'active',
            commission_rate: commRate,
            player_rakeback_rate: rakebackRate,
            credit_limit: creditLine,
            credit_used: 0,
            is_prepaid: isPrepaid,
            business_balance: 0,
            player_balance: 0,
            promo_balance: 0,
            total_players: 0,
            active_player_count: 0,
            sub_agent_count: 0,
            weekly_rake_generated: 0,
            lifetime_earnings: 0,
        });

        if (agentErr && !agentErr.message.includes('duplicate'))
            console.error(`    ERROR creating agent ${agent.username}: ${agentErr.message}`);

        // Upgrade club_members role
        await supabase.from('club_members')
            .update({ role: 'agent' })
            .eq('user_id', agent.id)
            .eq('club_id', SHARK_CLUB_ID);

        // Log promotion
        await logTx(agent.id, 'BUSINESS', 0, 'credit', 'settlement',
            `Promoted to agent in SHARK CLUB | Rake back: ${rateDisplay(commRate)}% | ${isPrepaid ? 'Pre-paid' : `Credit line: ${creditLine}`} | Referral: #${agent.player_number}`,
            SHARK_CLUB_ID);

        console.log(`    ${agent.username} — #${agent.player_number} — Rake back: ${rateDisplay(commRate)}% — ${isPrepaid ? 'PRE-PAID' : `CREDIT: ${creditLine}`}`);
    }

    // Promote JAQK agents (random commission rates, credit types, credit lines)
    console.log('\n  Club JAQK Agents:');
    const jaqkAgentConfigs = [];
    for (const agent of jaqkAgents) {
        const commRate = randomRate();
        const isPrepaid = randomBool();
        const creditLine = isPrepaid ? 0 : randomCreditLine();
        const rakebackRate = Math.trunc(commRate * 100 * 0.3) / 10000;

        jaqkAgentConfigs.push({ agent, commRate, isPrepaid, creditLine, rakebackRate });

        const { error: agentErr } = await supabase.from('agents').insert({
            user_id: agent.id,
            club_id: JAQK_CLUB_ID,
            role: 'agent',
            status: 'active',
            commission_rate: commRate,
            player_rakeback_rate: rakebackRate,
            credit_limit: creditLine,
            credit_used: 0,
            is_prepaid: isPrepaid,
            business_balance: 0,
            player_balance: 0,
            promo_balance: 0,
            total_players: 0,
            active_player_count: 0,
            sub_agent_count: 0,
            weekly_rake_generated: 0,
            lifetime_earnings: 0,
        });

        if (agentErr && !agentErr.message.includes('duplicate'))
            console.error(`    ERROR creating agent ${agent.username}: ${agentErr.message}`);

        await supabase.from('club_members')
            .update({ role: 'agent' })
            .eq('user_id', agent.id)
            .eq('club_id', JAQK_CLUB_ID);

        await logTx(agent.id, 'BUSINESS', 0, 'credit', 'settlement',
            `Promoted to agent in Club JAQK | Rake back: ${rateDisplay(commRate)}% | ${isPrepaid ? 'Pre-paid' : `Credit line: ${creditLine}`} | Referral: #${agent.player_number}`,
            JAQK_CLUB_ID);

        console.log(`    ${agent.username} — #${agent.player_number} — Rake back: ${rateDisplay(commRate)}% — ${isPrepaid ? 'PRE-PAID' : `CREDIT: ${creditLine}`}`);
    }

    // ─── STEP 6: Assign remaining horses under agents ───────────────────────
    console.log('\n\nSTEP 6: Assigning players under agents via referral codes...');

    const agentUserIdSet = new Set([...sharkAgents, ...jaqkAgents].map(a => a.id));

    // SHARK CLUB assignments
    const sharkPlayers = [];
    const { data: sharkMembers } = await supabase
        .from('club_members')
        .select('user_id, role')
        .eq('club_id', SHARK_CLUB_ID)
        .eq('role', 'member')
        .in('user_id', horseIds);

    for (const m of (sharkMembers || [])) {
        if (!agentUserIdSet.has(m.user_id)) {
            sharkPlayers.push(m.user_id);
        }
    }

    console.log(`  SHARK CLUB: ${sharkPlayers.length} players to assign across ${sharkAgents.length} agents`);
    const sharkCounts = [0, 0, 0, 0, 0];
    for (let i = 0; i < sharkPlayers.length; i++) {
        const agentIdx = i % 5;
        const agent = sharkAgents[agentIdx];
        await supabase.from('club_members')
            .update({ agent_id: agent.id })
            .eq('user_id', sharkPlayers[i])
            .eq('club_id', SHARK_CLUB_ID);
        sharkCounts[agentIdx]++;
    }
    for (let i = 0; i < 5; i++) {
        await supabase.from('agents')
            .update({ total_players: sharkCounts[i], active_player_count: sharkCounts[i] })
            .eq('user_id', sharkAgents[i].id)
            .eq('club_id', SHARK_CLUB_ID);
        console.log(`    ${sharkAgents[i].username}: ${sharkCounts[i]} players`);
    }

    // JAQK assignments
    const jaqkPlayers = [];
    const { data: jaqkMembers } = await supabase
        .from('club_members')
        .select('user_id, role')
        .eq('club_id', JAQK_CLUB_ID)
        .eq('role', 'member')
        .in('user_id', horseIds);

    for (const m of (jaqkMembers || [])) {
        if (!agentUserIdSet.has(m.user_id)) {
            jaqkPlayers.push(m.user_id);
        }
    }

    console.log(`\n  Club JAQK: ${jaqkPlayers.length} players to assign across ${jaqkAgents.length} agents`);
    const jaqkCounts = [0, 0, 0, 0, 0];
    for (let i = 0; i < jaqkPlayers.length; i++) {
        const agentIdx = i % 5;
        const agent = jaqkAgents[agentIdx];
        await supabase.from('club_members')
            .update({ agent_id: agent.id })
            .eq('user_id', jaqkPlayers[i])
            .eq('club_id', JAQK_CLUB_ID);
        jaqkCounts[agentIdx]++;
    }
    for (let i = 0; i < 5; i++) {
        await supabase.from('agents')
            .update({ total_players: jaqkCounts[i], active_player_count: jaqkCounts[i] })
            .eq('user_id', jaqkAgents[i].id)
            .eq('club_id', JAQK_CLUB_ID);
        console.log(`    ${jaqkAgents[i].username}: ${jaqkCounts[i]} players`);
    }

    // ─── STEP 7: Reset all horse balances ───────────────────────────────────
    console.log('\n\nSTEP 7: Resetting all horse wallet balances to 0...');
    const { data: horseWallets } = await supabase
        .from('wallets')
        .select('user_id, balance')
        .eq('wallet_type', 'PLAYER')
        .in('user_id', horseIds)
        .gt('balance', 0);

    let resetTotal = 0;
    for (const w of (horseWallets || [])) {
        await supabase.from('wallets')
            .update({ balance: 0 })
            .eq('user_id', w.user_id)
            .eq('wallet_type', 'PLAYER');
        await logTx(w.user_id, 'PLAYER', w.balance, 'debit', 'settlement',
            'Balance reset for proper funding chain initialization');
        resetTotal += w.balance;
    }
    console.log(`  Reset ${(horseWallets || []).length} wallets, cleared ${resetTotal} chips`);

    // Also reset KingFish balance
    const { data: kfWallet } = await supabase
        .from('wallets')
        .select('balance')
        .eq('user_id', KINGFISH_ID)
        .eq('wallet_type', 'PLAYER')
        .single();
    if (kfWallet && kfWallet.balance > 0) {
        await supabase.from('wallets')
            .update({ balance: 0 })
            .eq('user_id', KINGFISH_ID)
            .eq('wallet_type', 'PLAYER');
        await logTx(KINGFISH_ID, 'PLAYER', kfWallet.balance, 'debit', 'settlement',
            'Union owner balance reset for clean funding chain');
        console.log(`  Reset KingFish balance: ${kfWallet.balance} → 0`);
    }

    // ─── STEP 8: Mint chips to Union Owner ──────────────────────────────────
    console.log('\n\nSTEP 8: Minting chips to Union Owner (KingFish)...');

    const totalPlayersCount = sharkPlayers.length + jaqkPlayers.length;
    const totalAgentsCount = 10;
    const playerChipsNeeded = totalPlayersCount * CHIPS_PER_PLAYER;
    const agentChipsNeeded = totalAgentsCount * (CHIPS_PER_PLAYER + AGENT_BUFFER);
    const ownerBuffer = 50000;
    const totalMint = playerChipsNeeded + agentChipsNeeded + ownerBuffer;

    console.log(`  Players: ${totalPlayersCount} × ${CHIPS_PER_PLAYER} = ${playerChipsNeeded}`);
    console.log(`  Agents: ${totalAgentsCount} × ${CHIPS_PER_PLAYER + AGENT_BUFFER} = ${agentChipsNeeded}`);
    console.log(`  Owner buffer: ${ownerBuffer}`);
    console.log(`  Total mint: ${totalMint} chips`);

    await creditWallet(KINGFISH_ID, totalMint);
    await logTx(KINGFISH_ID, 'PLAYER', totalMint, 'credit', 'mint',
        `Union owner chip mint: ${totalMint} chips for complete hierarchy funding`,
        UNION_ID);
    console.log(`  Minted ${totalMint} chips to KingFish\n`);

    // ─── STEP 9: Fund Agents from KingFish ──────────────────────────────────
    console.log('STEP 9: Funding agents from Union Owner (KingFish)...\n');

    // SHARK CLUB agents
    console.log('  SHARK CLUB:');
    for (let i = 0; i < sharkAgents.length; i++) {
        const agent = sharkAgents[i];
        const playerCount = sharkCounts[i];
        const fundAmount = (playerCount * CHIPS_PER_PLAYER) + CHIPS_PER_PLAYER + AGENT_BUFFER;

        await transfer(
            KINGFISH_ID, agent.id, fundAmount, 'transfer',
            `Union Owner → Agent ${agent.username} (SHARK CLUB): ${playerCount} players + self + buffer`,
            `Funded by Union Owner (KingFish): ${playerCount} players allocation + agent chips`
        );
        console.log(`    ${agent.username}: ${fundAmount} chips (${playerCount} players × ${CHIPS_PER_PLAYER} + ${CHIPS_PER_PLAYER} self + ${AGENT_BUFFER} buffer)`);
    }

    // JAQK agents
    console.log('\n  Club JAQK:');
    for (let i = 0; i < jaqkAgents.length; i++) {
        const agent = jaqkAgents[i];
        const playerCount = jaqkCounts[i];
        const fundAmount = (playerCount * CHIPS_PER_PLAYER) + CHIPS_PER_PLAYER + AGENT_BUFFER;

        await transfer(
            KINGFISH_ID, agent.id, fundAmount, 'transfer',
            `Union Owner → Agent ${agent.username} (Club JAQK): ${playerCount} players + self + buffer`,
            `Funded by Union Owner (KingFish): ${playerCount} players allocation + agent chips`
        );
        console.log(`    ${agent.username}: ${fundAmount} chips (${playerCount} players × ${CHIPS_PER_PLAYER} + ${CHIPS_PER_PLAYER} self + ${AGENT_BUFFER} buffer)`);
    }

    // ─── STEP 10: Fund Players from their Agents ────────────────────────────
    console.log('\n\nSTEP 10: Funding players from agents...\n');

    // Create name lookup
    const nameMap = new Map(horses.map(h => [h.id, h.username]));

    // SHARK CLUB
    console.log('  SHARK CLUB:');
    let sharkFunded = 0;
    for (let i = 0; i < sharkPlayers.length; i++) {
        const agentIdx = i % 5;
        const agent = sharkAgents[agentIdx];
        const playerId = sharkPlayers[i];
        const playerName = nameMap.get(playerId) || playerId.slice(-6);

        await transfer(
            agent.id, playerId, CHIPS_PER_PLAYER, 'transfer',
            `Agent ${agent.username} → ${playerName}: player funding (SHARK CLUB)`,
            `Funded by Agent ${agent.username} (SHARK CLUB): ${CHIPS_PER_PLAYER} initial chips`
        );
        sharkFunded++;

        if (sharkFunded % 20 === 0) console.log(`    ...funded ${sharkFunded}/${sharkPlayers.length}`);
    }
    console.log(`    Funded ${sharkFunded} players`);

    // JAQK
    console.log('\n  Club JAQK:');
    let jaqkFunded = 0;
    for (let i = 0; i < jaqkPlayers.length; i++) {
        const agentIdx = i % 5;
        const agent = jaqkAgents[agentIdx];
        const playerId = jaqkPlayers[i];
        const playerName = nameMap.get(playerId) || playerId.slice(-6);

        await transfer(
            agent.id, playerId, CHIPS_PER_PLAYER, 'transfer',
            `Agent ${agent.username} → ${playerName}: player funding (Club JAQK)`,
            `Funded by Agent ${agent.username} (Club JAQK): ${CHIPS_PER_PLAYER} initial chips`
        );
        jaqkFunded++;

        if (jaqkFunded % 20 === 0) console.log(`    ...funded ${jaqkFunded}/${jaqkPlayers.length}`);
    }
    console.log(`    Funded ${jaqkFunded} players`);

    // ─── STEP 11: VERIFICATION ──────────────────────────────────────────────
    console.log('\n\n╔══════════════════════════════════════════════════════════════╗');
    console.log('║                    VERIFICATION                              ║');
    console.log('╚══════════════════════════════════════════════════════════════╝\n');

    // KingFish balance
    const { data: kfFinal } = await supabase
        .from('wallets')
        .select('balance')
        .eq('user_id', KINGFISH_ID)
        .eq('wallet_type', 'PLAYER')
        .single();
    console.log(`  KingFish (Union Owner) balance: ${kfFinal?.balance}`);

    // Agent balances
    console.log('\n  SHARK CLUB Agents:');
    for (const agent of sharkAgents) {
        const { data: aw } = await supabase.from('wallets')
            .select('balance').eq('user_id', agent.id).eq('wallet_type', 'PLAYER').single();
        console.log(`    ${agent.username}: ${aw?.balance} chips remaining`);
    }
    console.log('\n  Club JAQK Agents:');
    for (const agent of jaqkAgents) {
        const { data: aw } = await supabase.from('wallets')
            .select('balance').eq('user_id', agent.id).eq('wallet_type', 'PLAYER').single();
        console.log(`    ${agent.username}: ${aw?.balance} chips remaining`);
    }

    // Total horse chips
    const { data: allWallets } = await supabase
        .from('wallets')
        .select('user_id, balance')
        .eq('wallet_type', 'PLAYER')
        .in('user_id', horseIds);

    const totalHorseChips = (allWallets || []).reduce((s, w) => s + Number(w.balance), 0);
    const playersAt5k = (allWallets || []).filter(w => w.balance === CHIPS_PER_PLAYER).length;
    console.log(`\n  Total horse chips in wallets: ${totalHorseChips}`);
    console.log(`  Horses with exactly ${CHIPS_PER_PLAYER} chips: ${playersAt5k}`);
    console.log(`  Expected total minted: ${totalMint}`);
    console.log(`  Chips accounted for: ${kfFinal?.balance + totalHorseChips}`);

    // Transaction count
    const { count: txCount } = await supabase
        .from('wallet_transactions')
        .select('id', { count: 'exact', head: true })
        .gte('created_at', new Date(Date.now() - 30 * 60 * 1000).toISOString());
    console.log(`  Transactions logged (last 30 min): ${txCount}`);

    // Verify ledger integrity
    const { data: mintTxs } = await supabase
        .from('wallet_transactions')
        .select('amount')
        .eq('type', 'credit')
        .eq('category', 'mint');
    const totalMinted = (mintTxs || []).reduce((s, t) => s + Number(t.amount), 0);

    const { data: allSystemWallets } = await supabase
        .from('wallets')
        .select('balance, locked_balance');
    const totalInWallets = (allSystemWallets || []).reduce((s, w) => s + Number(w.balance), 0);

    console.log(`\n  LEDGER CHECK:`);
    console.log(`    Total minted (all time): ${totalMinted}`);
    console.log(`    Total in all wallets: ${totalInWallets}`);
    console.log(`    Difference: ${exact(totalMinted - totalInWallets)}`);

    console.log('\n╔══════════════════════════════════════════════════════════════╗');
    console.log('║                    COMPLETE                                  ║');
    console.log('╚══════════════════════════════════════════════════════════════╝');
}

main().catch(err => {
    console.error('\nFATAL:', err.message);
    console.error(err.stack);
    process.exit(1);
});
