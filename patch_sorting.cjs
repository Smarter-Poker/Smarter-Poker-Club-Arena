const fs = require('fs');
let code = fs.readFileSync('src/pages/ClubHomePage.tsx', 'utf-8');

const oldSwitch = `    const bb = (t: TableData) => Number(t.big_blind) || 0;
    switch (sortKey) {
      case 'stakes_high':
        return rows.sort((a, b) => bb(b) - bb(a));
      case 'stakes_low':
        return rows.sort((a, b) => bb(a) - bb(b));
      case 'players':
        return rows.sort((a, b) => (b.current_players || 0) - (a.current_players || 0));
      case 'starting_soon':
        // Cash tables have no start time. Rather than sorting them by an
        // absent field (which is a no-op that LOOKS like a sort), fall back to
        // the busiest first — the nearest cash equivalent of "starting soon".
        return rows.sort((a, b) => (b.current_players || 0) - (a.current_players || 0));
      case 'recommended':
      default:
        // Hold'em → Omaha → Mixed, busiest first inside each family.
        return rows.sort(
          (a, b) => cashRank(a) - cashRank(b) || (b.current_players || 0) - (a.current_players || 0)
        );
    }`;

const newSwitch = `    const bb = (t: TableData) => Number(t.big_blind) || 0;
    const cmpStakes = (a: TableData, b: TableData) => bb(b) - bb(a);
    const cmpStakesLow = (a: TableData, b: TableData) => bb(a) - bb(b);
    const cmpPlayers = (a: TableData, b: TableData) => (b.current_players || 0) - (a.current_players || 0);
    const cmpName = (a: TableData, b: TableData) => (a.name || '').localeCompare(b.name || '');

    switch (sortKey) {
      case 'stakes_high':
        return rows.sort((a, b) => cmpStakes(a, b) || cmpPlayers(a, b) || cmpName(a, b));
      case 'stakes_low':
        return rows.sort((a, b) => cmpStakesLow(a, b) || cmpPlayers(a, b) || cmpName(a, b));
      case 'players':
      case 'starting_soon':
        return rows.sort((a, b) => cmpPlayers(a, b) || cmpStakes(a, b) || cmpName(a, b));
      case 'recommended':
      default:
        return rows.sort(
          (a, b) => cashRank(a) - cashRank(b) || cmpStakes(a, b) || cmpPlayers(a, b) || cmpName(a, b)
        );
    }`;

code = code.replace(oldSwitch, newSwitch);

const oldTourneySwitch = `    const buyIn = (t: TournamentData) =>
      (Number(t.buy_in_amount) || 0) + (Number(t.buy_in_fee) || 0);
    switch (sortKey) {
      case 'stakes_high':
        return rows.sort((a, b) => buyIn(b) - buyIn(a));
      case 'stakes_low':
        return rows.sort((a, b) => buyIn(a) - buyIn(b));
      case 'players':
        return rows.sort((a, b) => (b.current_players || 0) - (a.current_players || 0));
      case 'starting_soon': {`;

const newTourneySwitch = `    const buyIn = (t: TournamentData) =>
      (Number(t.buy_in_amount) || 0) + (Number(t.buy_in_fee) || 0);
    const cmpBuyIn = (a: TournamentData, b: TournamentData) => buyIn(b) - buyIn(a);
    const cmpBuyInLow = (a: TournamentData, b: TournamentData) => buyIn(a) - buyIn(b);
    const cmpPlayersTourn = (a: TournamentData, b: TournamentData) => (b.current_players || 0) - (a.current_players || 0);
    const cmpNameTourn = (a: TournamentData, b: TournamentData) => (a.name || '').localeCompare(b.name || '');

    switch (sortKey) {
      case 'stakes_high':
        return rows.sort((a, b) => cmpBuyIn(a, b) || cmpPlayersTourn(a, b) || cmpNameTourn(a, b));
      case 'stakes_low':
        return rows.sort((a, b) => cmpBuyInLow(a, b) || cmpPlayersTourn(a, b) || cmpNameTourn(a, b));
      case 'players':
        return rows.sort((a, b) => cmpPlayersTourn(a, b) || cmpBuyIn(a, b) || cmpNameTourn(a, b));
      case 'starting_soon': {`;

code = code.replace(oldTourneySwitch, newTourneySwitch);

const oldTourneyEnd = `        return rows.sort((a, b) => {
          const ea = stillEnterable(a) ? 0 : 1;
          const eb = stillEnterable(b) ? 0 : 1;
          if (ea !== eb) return ea - eb;
          return at(a) - at(b);
        });
      }
      case 'recommended':
      default:
        return rows.sort(tournamentOpenFirst);
    }`;

const newTourneyEnd = `        return rows.sort((a, b) => {
          const ea = stillEnterable(a) ? 0 : 1;
          const eb = stillEnterable(b) ? 0 : 1;
          if (ea !== eb) return ea - eb;
          return at(a) - at(b) || cmpBuyIn(a, b) || cmpPlayersTourn(a, b) || cmpNameTourn(a, b);
        });
      }
      case 'recommended':
      default:
        return rows.sort((a, b) => tournamentOpenFirst(a, b) || cmpBuyIn(a, b) || cmpPlayersTourn(a, b) || cmpNameTourn(a, b));
    }`;

code = code.replace(oldTourneyEnd, newTourneyEnd);

fs.writeFileSync('src/pages/ClubHomePage.tsx', code);
