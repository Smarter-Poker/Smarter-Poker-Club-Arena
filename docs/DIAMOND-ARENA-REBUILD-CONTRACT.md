# What the diamond books need from the new Diamond Arena

2026-09-08. For whoever is rebuilding the arena from scratch.

**Nothing in here asks you to keep any old arena code.** Tear all of it out. This
is the short list of what the platform's accounting expects from whatever
replaces it, so the rebuild does not silently re-create the three defects the old
one shipped with.

## 1. The books no longer depend on you existing

Three accounting surfaces used to call `fn_ca_arena_diamonds()` directly:

- `fn_ca_diamond_trial_balance` - proves every diamond is accounted for
- `fn_ca_diamond_snapshot` - the hourly deploy gate
- `fn_ca_diamond_economy` - the economy report

Dropping that one function would have taken all three down, and the deploy gate's
first symptom would have been silence. They now read
**`fn_ca_diamond_offledger_float()`**, which the accounting side owns.

**You can delete every arena object freely. The books keep working.**

## 2. The one hook, if diamonds can sit outside the player wallet

`profiles.diamonds` is the canonical store. If your arena parks diamonds anywhere
else - a table stack, an arena wallet, an escrow - the books have to count them or
the supply will not reconcile.

The contract is one function:

```sql
public.fn_ca_arena_diamonds() RETURNS numeric
```

returning the total held outside `profiles.diamonds`. Provide it and the books
pick it up with no other change. **If your arena parks nothing outside the player
wallet, provide nothing** - the float reads 0, which is then the truth.

What it must never do is exist and fail. `fn_ca_diamond_offledger_float()`
returns 0 when no arena exists, and RAISES when one exists and cannot be read,
because a float that cannot be measured is not a float of zero.

## 3. Declare your journal movement kinds, or they get misclassified

Every diamond movement writes a journal row, and
`fn_ca_diamond_journal_origin()` decides what that row MEANS - money created,
money retired, or money moved. Get this wrong and the platform's diamond supply
becomes fiction.

The old arena got it wrong in both directions, and both were live:

- a deposit was classified `spend`, so the register **burned** every diamond
  parked on a table while the diamonds still existed;
- a withdrawal was classified `arena`, which reads as a mint, so taking your own
  diamonds back out **created them again**.

A deposit and a withdrawal are **transfers**: the same player still owns the
money, so nothing is created and nothing is retired. The classifier currently
knows two kinds by name, `arena_deposit` and `arena_withdraw`.

**If your new movements use different names, tell me and I will add them.** A
movement kind the classifier does not recognise is not a small problem - it is
either invisible to the supply or counted as issuance.

## 4. Two traps the old arena fell into, so you can design around them

**It borrowed the chip machinery, and the chip machinery is asset-blind.**
Creating the old arena as a club would have minted **100,000 chips** inside a
diamond room, because the club-creation trigger sets a chip opening bank with no
reference to the asset. The chip supply snapshot also counted diamond wallets as
chips, because arena member wallets lived in `club_members.chip_balance`. Both are
fixed for the old shape, but every one of those bugs came from reusing tables
built for a different currency. **Its own tables would have had none of them.**

**One shared row is a bottleneck, not a counter.** Three separate places on this
platform kept a running total on a single row and updated it on every
transaction, holding the row lock until the caller committed. All three broke on
2026-09-08 under ordinary load; one silently lost 5,860 player rewards. If the
new arena keeps a house balance, a pot, or a rake total, **append rows and sum
them** rather than incrementing one row. `ca_diamond_engine_spend` is the worked
example.

Related: `ca_diamond_house.balance` is still a single row today. If the new arena
sends rake there, fix that first - it will jam the day rake starts flowing.

## 5. Horses are players, and they are 83% of the diamonds

1,000 horses hold **2,765,170 diamonds** against humans' 566,291, and have spent
**7,165 in total**. Whatever the arena charges for, horses are most of the
customers, and CLAUDE.md 10.5 means they enter, pay and are paid through the
identical path a human uses - never a parallel one.

A horse has no browser, so the engine supplies what a click would. That is the
only legitimate difference, and it exists to make a horse equal, not different.

## Who to ask

Anything about diamond issuance, counting, caps or the books: that is the diamond
economy work, and it is not being rebuilt. The arena is yours.
