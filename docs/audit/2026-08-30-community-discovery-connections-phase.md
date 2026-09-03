# Club Arena Phase 5 — Community Discovery & Connections

Date: 2026-08-30  
Scope: `/search`, `/friends`, every addressable Friends state, friend challenge receive/send surfaces, player-profile transitions, and the local `/messages` handoff into the World Hub Messenger.

## Route and content inventory

| Route / surface                                           | Purpose                                           | Live sources and behavior                                                                                                                                                 | Before                                                                                                                                                                                                                   | Phase 5 disposition                                                                                                                                                                                                        |
| --------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/search`                                                 | Search the complete poker network                 | Supabase `clubs`, `profiles`, `tables`, and `tournaments`; current privacy/status hygiene; Master Bus club/profile/tournament refresh events; local recent-search history | Four independent queries ran serially. Query and category lived only in component state. Per-source errors were discarded and looked like no results. Result rows were click-only containers with nested symbol buttons. | Retained as **Community Search**. All independent indexes execute concurrently, partial and total failures are explicit and retryable, results use native controls, and query/category are shareable.                      |
| `/search?q=:query`                                        | Addressable search query                          | Same live search sources                                                                                                                                                  | Missing. A copied URL lost the query. Debounced partial keystrokes polluted recent history.                                                                                                                              | Added. URL updates with the stabilized query; history records only explicit submissions or opened results.                                                                                                                 |
| `/search?type=players`                                    | Player discovery                                  | `profiles` with Arena avatar authority                                                                                                                                    | The Friends empty state linked to `/search?tab=players`, but Search ignored that parameter.                                                                                                                              | Canonical player-discovery state. Legacy `tab` is still read, then subsequent state writes use `type`.                                                                                                                     |
| `/search?type=clubs`                                      | Club discovery                                    | Public/searchable club rows                                                                                                                                               | Local-only tab.                                                                                                                                                                                                          | Retained and addressable.                                                                                                                                                                                                  |
| `/search?type=tables`                                     | Public cash-table discovery                       | Non-deleted, non-closed, non-tournament, non-private tables                                                                                                               | Local-only tab.                                                                                                                                                                                                          | Retained and addressable; existing table privacy and lobby-hygiene filters are unchanged.                                                                                                                                  |
| `/search?type=tournaments`                                | Public active-tournament discovery                | Announced/registering/running, non-private tournaments                                                                                                                    | Local-only tab.                                                                                                                                                                                                          | Retained and addressable; advertised total buy-in calculation is unchanged.                                                                                                                                                |
| Search player actions                                     | Inspect, connect, or message a player             | `friendships` insert, `FRIEND_REQUEST_SENT`, router handoff                                                                                                               | Add and Message were `+` and envelope glyphs. Message incorrectly opened the public profile instead of Messenger.                                                                                                        | Named **Add Friend** and **Message** actions. Message now uses `/messages?compose=:playerId`; profile remains a separate primary result action.                                                                            |
| `/friends`                                                | Canonical relationship roster                     | Accepted sent/received `friendships`, batched profile enrichment, global presence, session SWR cache, realtime friend request channel, Master Bus refreshes, CSV export   | Suggestions appeared above navigation on every visit. Tabs were local-only. Rows depended on swipe-only symbol actions, nested click targets, and immediate removal.                                                     | Retained as **Connections**. Clear profile/message/challenge/remove buttons, confirmation before removal, live status, filtering, export, and existing data contracts are preserved.                                       |
| `/friends?tab=requests`                                   | Incoming request review                           | Pending received `friendships`; accepted update and recipient-scoped decline delete                                                                                       | Local `pending` tab. Actions were unlabeled check/cross glyphs.                                                                                                                                                          | Canonical addressable state with named profile, Accept, and Decline controls. Legacy `?tab=pending` redirects in place to `requests`.                                                                                      |
| `/friends?tab=activity`                                   | Relationship activity and discovery               | Friend achievements, daily challenge completions, Master Bus hand/friend/achievement events, live suggestion service                                                      | Local **Recent** tab combined Friend Activity with a `RecentPlayers` component whose loader always returned a hard-coded empty array. Suggestions duplicated discovery above all tabs.                                   | Renamed **Activity** and made addressable. Live feed and suggestions are consolidated here; errors and empty states are explicit. Legacy `?tab=recent` canonicalizes to `activity`. Dead `RecentPlayers` code was removed. |
| `/friends?tab=challenges`                                 | Challenge inbox, progress, and history            | `friend_challenges`, profile lookup, `fn_respond_friend_challenge`                                                                                                        | Local tab with inline visual styles. Query errors were discarded and rendered as an empty ledger. Cancelled/expired states could produce a blank panel.                                                                  | Addressable engineered ledger with incoming, active, sent, and full history groups; loading/error/retry states; semantic progress controls. RPC and storage contracts are unchanged.                                       |
| Friend challenge dialog                                   | Compose a friend challenge                        | Existing `friend_challenges` insert and notification Master Bus event                                                                                                     | Generic rounded/glass modal without dialog naming, Escape handling, focus trap/restore, or pressed-state semantics.                                                                                                      | Retained and rebuilt as a named, focus-trapped, Escape-dismissible engineered dialog. All four challenge types, duration, insert fields, and notification event remain intact.                                             |
| `/profile/:userId` transition                             | Inspect player credential before connecting       | Existing Phase 4 public profile and relationship services                                                                                                                 | Search and Friends linked here, but rows were not consistently keyboard-native.                                                                                                                                          | Preserved as the public-player authority. Search, Friends, requests, activity, and suggestions use explicit native links/buttons to it. No public-profile business logic was duplicated.                                   |
| `/messages`, `/messages/new`, `/messages/:conversationId` | Local compatibility bridge to World Hub Messenger | `NavigateToMessenger` preserves query parameters and maps `compose` to World Hub `uid`                                                                                    | Some community actions used `/messages/new?userId=`, while Search's Message did not message at all.                                                                                                                      | Routes retained. Community actions now use the canonical `/messages?compose=:playerId` contract, which the existing bridge carries to `/hub/messenger?uid=:playerId`. Messenger remains owned by World Hub.                |

## Duplicate, placeholder, and low-value findings

- `RecentPlayers` was a visible promise with no data owner: `loadRecentPlayers` assigned an empty array unconditionally. The component and stylesheet were removed rather than presenting a permanently empty product surface.
- Player suggestions were globally mounted above every Friends state and duplicated the purpose of the Recent tab. They now live with the renamed Activity & Discovery workspace.
- Search stored every debounced partial query in history. History now represents user intent: submitted searches and selected results.
- Search and Friends exposed three competing message contracts: public-profile navigation, `/messages/new?userId=`, and the actual Messenger bridge. All community compose actions now share one contract.
- Swipe-only Friend actions duplicated a visible Challenge button while concealing Message and Remove behind gesture discovery. One explicit action set replaces both versions.
- Friends summary cards repeated information already necessary in the hero. Counts now live in the cinematic connection header instead of a second dashboard row.

## Missing surfaces assessed

- Addressable search scope, request review, activity, and challenge states were missing; query-based subroutes now supply them without multiplying top-level routes.
- Search needed partial-source failure reporting because four independently permissioned data sources can fail differently. That state and a retry path now exist.
- Challenges and activity needed recoverable error states. They now distinguish loading, empty, partial history, and transport failure.
- A separate local Messenger implementation should **not** be added. World Hub Messenger is the established authority, and the local route remains a compatibility bridge.
- “Recently played with” remains a valuable future concept only after a server-owned hand/session co-participant contract exists. Phase 5 does not fabricate activity data to fill that slot.

## Before sitemap

```text
Community
├── /search                         local All / Clubs / Players / Tables / Tournaments
│   ├── player +                    friend request
│   └── player envelope             incorrectly opened profile
├── /friends
│   ├── global People You May Know
│   ├── local Friends               swipe Message / Remove + visible Challenge
│   ├── local Requests              glyph-only actions
│   ├── local Recent
│   │   ├── Friend Activity
│   │   └── Recent Players          permanent placeholder
│   └── local Challenges
└── /messages/new?userId=:id        inconsistent legacy handoff
```

## After sitemap

```text
Community
├── /search                         Community Search
│   ├── ?q=:query                   shareable query
│   ├── ?type=players               player discovery
│   ├── ?type=clubs                 club discovery
│   ├── ?type=tables                public table discovery
│   └── ?type=tournaments           active tournament discovery
├── /friends                        Connections roster
│   ├── ?tab=requests               incoming request review
│   ├── ?tab=activity               live activity + player discovery
│   └── ?tab=challenges             inbox + active + sent + history
├── /profile/:userId                public player authority
└── /messages?compose=:id           canonical bridge → World Hub Messenger
```

## Route change ledger

No top-level route was deleted.

- Added addressable states: `/search?q=`, `/search?type=players|clubs|tables|tournaments`, and `/friends?tab=requests|activity|challenges`.
- Preserved Search compatibility: the existing `?tab=players|clubs|tables|tournaments` input is read and canonical writes use `type`.
- Preserved Friends compatibility: `?tab=pending` canonicalizes to `requests`; `?tab=recent` canonicalizes to `activity`.
- Renamed UI only: **Recent** → **Activity**; **People You May Know** → **Players You May Know**.
- Removed the dead `RecentPlayers` component and stylesheet. It had no route, live query, storage, handler, or business logic to preserve.
- Standardized compose handoffs on `/messages?compose=:playerId`; all existing `/messages*` route declarations remain intact.

## Preserved contracts

- Friendship insert, accepted-row update/delete rules, reciprocal accepted queries, Supabase realtime friend-request subscription, global presence, SWR cache, retry behavior, visibility refresh, Master Bus events, and CSV export remain live.
- Search privacy filters for tables and tournaments, Arena avatar column authority, buy-in display calculation, and cross-page refresh events remain live.
- Challenge insert columns and `fn_respond_friend_challenge` RPC remain unchanged.
- Activity reads the same achievement and daily-challenge tables and listens to the same hand, friend, and achievement events; independent reads now run concurrently.
- Profile, club, table, and tournament destination routes are unchanged.
- The existing local-to-World-Hub Messenger redirect owns parameter translation; no chat API, realtime channel, or conversation handler was duplicated.

## #SmarterCasinoRealism implementation

- One shared cinematic Community header uses a generated photorealistic network-vault visual, near-black structure, machined steel borders, and restrained electric-blue scan energy.
- Search and Connections are editorial workspaces rather than repeated rounded stat cards: one visual anchor, one command surface, then precise rows and state-specific content.
- Borders are crisp, radii stay at 3–5px, chrome/gunmetal framing is structural, and blue is reserved for live focus, active rails, and primary actions.
- Glass blur, generic SaaS cards, arcade gradients, hover-dependent behavior, and symbol-only critical controls were removed.
- Responsive grids use `minmax(0, 1fr)`, mobile rails scroll inside their own width, action groups collapse deliberately, and interactive targets reach at least 44px on phone layouts.

## Validation target

- Targeted Community Command Center regression contract.
- TypeScript, changed-file ESLint, Prettier, title-case/UI-copy gates, hover-law suite, full Vitest suite, and production build.
- Authenticated browser verification at 1440×900, 834×1112, and 375×812 for every Search category, every Friends state, challenge dialog, profile transition, and Messenger compose handoff.
- Link and overflow checks after production publication; release handoff records the final results.
