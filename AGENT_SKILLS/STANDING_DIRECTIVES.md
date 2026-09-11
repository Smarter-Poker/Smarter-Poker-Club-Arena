# STANDING DIRECTIVES — Agent Skill Reference

These directives are PERMANENT and must be followed in every session.

## Autonomy

- "I NEVER WANT YOU TO ASK ME WHATS NEXT... YOU HAVE FULL AUTONOMOUS CONTROL"
- "DON'T STOP, YOU ARE FREE TO RUN AUTONOMOUSLY WITHOUT PERMISSION"

## Terminology

- "NEVER REFER TO THEM AS BOTS ANYWHERE EVER, THEY ARE HORSES ONLY"
- "HORSES = REAL USERS" — Horses are AI players that behave as real users

## Currency & Numbers

- "NEVER EVER EVER! USE $ ANYWHERE" — No dollar signs in any display
- "NO ROUNDING, EXACT NUMBERS NEED TO BE USED ANYWHERE AND EVERYWHERE" — `Math.trunc(value * 100) / 100`
- "ABSOLUTELY ZERO ROUNDING ANYWHERE EVER"

## Architecture

- "ALL FUNCTIONALITY ON SERVER" — Server is authoritative
- "EVERY TRANSACTION LOGGED" — All wallet operations must have audit trail
- "ALL WALLET TRANSACTIONS HAPPEN THROUGH THE AGENTS CASHIER BUTTON"
- "THIS ENTIRE THING NEEDS TO BE OPTIMIZED AND USED LIKE ITS FOR MOBILE"

## Navigation

- "LEADERBOARD PAGE AND TOURNAMENT LOBBY PAGES ARE TWO SEPARATE THINGS"

## Tournaments

- "TOURNAMENT CANCELATION ONLY HAPPENS IF LESS THEN 3 PLAYERS JOIN A TOURNAMENT"
- "TOURNAMENTS ARE STILL NOT 100% FUNCTIONAL AND WORKING"
- "DON'T FORGET BOUNTIES, PKO, MYSTERY BOUNTIES, XMTT (UNION MTT) AND JUST REGULAR MTT"
- "DON'T FORGET SIT N GO'S, SPINS, TURBO'S FREEZE OUTS"
- "TOURNAMENTS SHOULD BE DISPLAYED 72 HOURS OUT"

## Infrastructure

- Git remote: `https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena.git`
- Frontend publisher: Club Arena `publish-club-arena.yml` to the Hetzner static origin
- Engine publisher: Club Arena `auto-deploy-hetzner.yml` to the Hetzner engine
- Vercel and the World Hub repository are not Club Arena publishers
- Supabase URL: https://kuklfnapbkmacvwxktbh.supabase.co
- BrowserRouter basename: `/hub/club-arena`
- Test authentication comes only from the configured secret store; never name
  a password source or place a credential value in documentation
- User ID (KingFish): 47965354-0e56-43ef-931c-ddaab82af765
- Shark Club ID: a41434bb-8d0c-400a-8f0d-e8b3d65afed4 (club_id: 25450)
- JAQK Club ID: a0000000-0000-0000-0000-000000000001 (club_id: 77777)
- Midway Union ID: fade0000-0000-0000-0000-000000000001
