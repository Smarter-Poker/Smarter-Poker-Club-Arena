import { useState } from 'react';
import {
  ArenaActionButton,
  ArenaBadge,
  ArenaIconButton,
  ArenaInput,
  ArenaJackpotDisplay,
  ArenaModalFrame,
  ArenaPanel,
  ArenaSelect,
  ArenaTabs,
  ArenaToggle,
  ArenaValueDisplay,
  ArenaWalletRow,
  ClubButtonsSurface,
  type ClubButtonsDataState,
  type ClubButtonsMode,
  type ClubIconName,
} from '../../components/club-buttons';
import './ClubButtonsShowcasePage.css';

const modes: ReadonlyArray<{ value: ClubButtonsMode; label: string }> = [
  { value: 'arena', label: 'Club Arena' },
  { value: 'hub', label: 'World Hub' },
  { value: 'commander', label: 'Club Commander' },
];

const tabs = [
  { value: 'overview', label: 'Overview' },
  { value: 'players', label: 'Players' },
  { value: 'payouts', label: 'Payouts' },
  { value: 'blinds', label: 'Blinds' },
  { value: 'levels', label: 'Levels' },
];

const utilityControls: Array<{ icon: ClubIconName; label: string }> = [
  { icon: 'chat', label: 'Chat' },
  { icon: 'stats', label: 'Stats' },
  { icon: 'timer', label: 'Time Bank' },
  { icon: 'rabbit', label: 'Rabbit Hunt' },
  { icon: 'previous', label: 'Prev Hand' },
  { icon: 'menu', label: 'Menu' },
  { icon: 'sound', label: 'Sound' },
  { icon: 'info', label: 'Info' },
];

const moneyValues = ['$0.00', '$9.99', '$480.00', '$12,850', '$1,376,644.87', '$123,456,789.99'];

export default function ClubButtonsShowcasePage() {
  const [mode, setMode] = useState<ClubButtonsMode>('arena');
  const [tab, setTab] = useState('overview');
  const [selectedUtility, setSelectedUtility] = useState('Chat');
  const [toggle, setToggle] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [jackpotIndex, setJackpotIndex] = useState(4);
  const [jackpotState, setJackpotState] = useState<ClubButtonsDataState>('loaded');

  const nextJackpot = () => {
    setJackpotState('updating');
    setJackpotIndex((current) => (current + 1) % moneyValues.length);
    window.setTimeout(() => setJackpotState('loaded'), 260);
  };

  return (
    <ClubButtonsSurface mode={mode} className="cb-showcase">
      <header className="cb-showcase__masthead">
        <div>
          <p>#ClubButtons Production Laboratory</p>
          <h1>Same Factory. Different Parts.</h1>
          <span>Live Content Over Hyper-Realistic Production Shells</span>
        </div>
        <label className="cb-showcase__mode">
          <span>Product Mode</span>
          <select value={mode} onChange={(event) => setMode(event.target.value as ClubButtonsMode)}>
            {modes.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
      </header>

      <main>
        <section className="cb-showcase__hero" aria-labelledby="hero-title">
          <div className="cb-showcase__section-heading">
            <span>Hero Plaque</span>
            <h2 id="hero-title">Dynamic Jackpot Architecture</h2>
          </div>
          <ArenaJackpotDisplay
            badge="BBJ"
            eyebrow="Bad Beat Jackpot"
            value={moneyValues[jackpotIndex]}
            valueLabel={`Bad Beat Jackpot ${moneyValues[jackpotIndex]}`}
            label="Current Jackpot"
            dataState={jackpotState}
          />
          <div className="cb-showcase__hero-controls">
            <button type="button" onClick={nextJackpot}>
              Cycle Extreme Value
            </button>
            {(
              ['loaded', 'loading', 'empty', 'error', 'stale', 'offline'] as ClubButtonsDataState[]
            ).map((state) => (
              <button
                key={state}
                type="button"
                aria-pressed={jackpotState === state}
                onClick={() => setJackpotState(state)}
              >
                {state}
              </button>
            ))}
          </div>
        </section>

        <section className="cb-showcase__section" aria-labelledby="actions-title">
          <div className="cb-showcase__section-heading">
            <span>Primary Quality Gate</span>
            <h2 id="actions-title">Actions And Physical States</h2>
          </div>
          <div className="cb-showcase__action-grid">
            <div>
              <small>Default</small>
              <ArenaActionButton label="Join Table" icon="spade" />
            </div>
            <div>
              <small>Selected</small>
              <ArenaActionButton label="Register" icon="wallet" selected />
            </div>
            <div>
              <small>Secondary</small>
              <ArenaActionButton label="Table Options" icon="settings" variant="secondary" />
            </div>
            <div>
              <small>Danger</small>
              <ArenaActionButton label="Leave Table" icon="previous" variant="danger" />
            </div>
            <div>
              <small>Loading</small>
              <ArenaActionButton label="Joining Table" icon="spade" loading />
            </div>
            <div>
              <small>Disabled</small>
              <ArenaActionButton label="Join Table" icon="spade" disabled />
            </div>
            <div className="cb-showcase__wide">
              <small>Long Label</small>
              <ArenaActionButton
                label="Register For Tournament"
                sublabel="Closes in 08:00"
                icon="timer"
                size="large"
              />
            </div>
          </div>
        </section>

        <section className="cb-showcase__section" aria-labelledby="wallets-title">
          <div className="cb-showcase__section-heading">
            <span>Stack-Safe Embedded Rows</span>
            <h2 id="wallets-title">Wallet And Treasury States</h2>
          </div>
          <div className="cb-showcase__wallet-stack">
            <ArenaWalletRow icon="diamond" label="Diamonds" value="493,384" />
            <ArenaWalletRow
              icon="bank"
              label="Club Bank"
              value="$1,376,644.87"
              dataState="updating"
            />
            <ArenaWalletRow icon="wallet" label="Promo Wallet" value="$18,250.00" />
            <ArenaWalletRow
              icon="treasury"
              label="Rake Treasury"
              value="$186,440.22"
              dataState="stale"
              sublabel="Last update 4m ago"
            />
            <ArenaWalletRow
              icon="spade"
              label="Back Up BBJ Wallet With A Very Long Name"
              value="$123,456,789.99"
            />
            <ArenaWalletRow icon="treasury" label="Unknown Balance" dataState="loading" />
            <ArenaWalletRow icon="wallet" label="Disconnected Wallet" dataState="offline" />
          </div>
        </section>

        <section className="cb-showcase__section" aria-labelledby="values-title">
          <div className="cb-showcase__section-heading">
            <span>Live Value Stability</span>
            <h2 id="values-title">Numbers Never Resize The Shell</h2>
          </div>
          <div className="cb-showcase__value-grid">
            <ArenaValueDisplay value="$2,460.75" label="Currency" />
            <ArenaValueDisplay value="125,500" label="Chips" tone="gold" />
            <ArenaValueDisplay value="42 BB" label="Big Blinds" />
            <ArenaValueDisplay value="1,250" label="Players" tone="green" />
            <ArenaValueDisplay value="08:00" label="Time" />
            <ArenaValueDisplay value="Level 8" label="Level" tone="red" />
          </div>
        </section>

        <section className="cb-showcase__section" aria-labelledby="utility-title">
          <div className="cb-showcase__section-heading">
            <span>Varied Component Architecture</span>
            <h2 id="utility-title">Utility Controls, Tabs, And Statuses</h2>
          </div>
          <div className="cb-showcase__utilities">
            {utilityControls.map((control) => (
              <ArenaIconButton
                key={control.label}
                icon={control.icon}
                label={control.label}
                selected={selectedUtility === control.label}
                onClick={() => setSelectedUtility(control.label)}
              />
            ))}
            <ArenaIconButton icon="add" label="Add" disabled />
          </div>
          <ArenaTabs items={tabs} value={tab} onChange={setTab} />
          <div className="cb-showcase__badges">
            <ArenaBadge tone="red">Live</ArenaBadge>
            <ArenaBadge>Registering</ArenaBadge>
            <ArenaBadge tone="purple">Final Table</ArenaBadge>
            <ArenaBadge tone="red">PKO</ArenaBadge>
            <ArenaBadge>Deep Stack</ArenaBadge>
            <ArenaBadge tone="green">Insurance</ArenaBadge>
            <ArenaBadge tone="gold">Run It Twice</ArenaBadge>
          </div>
        </section>

        <section className="cb-showcase__two-column" aria-label="Panels And Form Controls">
          <ArenaPanel title="Tournament Info" action={<ArenaBadge>Live</ArenaBadge>}>
            <dl className="cb-showcase__facts">
              <div>
                <dt>Buy-In</dt>
                <dd>$150 + $15</dd>
              </div>
              <div>
                <dt>Players</dt>
                <dd>18 / 150</dd>
              </div>
              <div>
                <dt>Prize Pool</dt>
                <dd>$24,750</dd>
              </div>
              <div>
                <dt>Start Time</dt>
                <dd>8:00 PM</dd>
              </div>
              <div>
                <dt>Late Reg</dt>
                <dd>Level 8</dd>
              </div>
            </dl>
          </ArenaPanel>

          <ArenaPanel title="Production Form Controls">
            <form className="cb-showcase__form" onSubmit={(event) => event.preventDefault()}>
              <ArenaInput id="cb-player" label="Player Name" placeholder="Enter Player Name" />
              <ArenaSelect id="cb-option" label="Table Type" defaultValue="nlh">
                <option value="nlh">No Limit Hold'em</option>
                <option value="plo">Pot Limit Omaha</option>
                <option value="mtt">Multi-Table Tournament</option>
              </ArenaSelect>
              <ArenaToggle label="Insurance Enabled" checked={toggle} onChange={setToggle} />
              <ArenaActionButton
                label="Confirm"
                icon="spade"
                size="compact"
                onClick={() => setModalOpen(true)}
              />
            </form>
          </ArenaPanel>
        </section>

        <section className="cb-showcase__responsive" aria-labelledby="responsive-title">
          <div className="cb-showcase__section-heading">
            <span>Mobile First</span>
            <h2 id="responsive-title">320, 375, 390, And 430 Pixel Safe Zones</h2>
          </div>
          <div className="cb-showcase__device-row">
            {[320, 375, 390, 430].map((width) => (
              <div key={width} className="cb-showcase__device" style={{ width }}>
                <small>{width}px</small>
                <ArenaWalletRow icon="bank" label="Club Bank" value="$123,456,789.99" />
                <ArenaActionButton label="Join Table" />
              </div>
            ))}
          </div>
        </section>
      </main>

      {modalOpen && (
        <div
          className="cb-showcase__modal-layer"
          onMouseDown={(event) => event.target === event.currentTarget && setModalOpen(false)}
        >
          <ArenaModalFrame title="Tournament Registration" onClose={() => setModalOpen(false)}>
            <div className="cb-showcase__modal-content">
              <p>Buy-In Amount</p>
              <strong>$150.00</strong>
              <span>Your Balance</span>
              <b>$1,376,644.87</b>
              <div>
                <ArenaActionButton
                  label="Cancel"
                  variant="secondary"
                  size="compact"
                  onClick={() => setModalOpen(false)}
                />
                <ArenaActionButton
                  label="Confirm"
                  size="compact"
                  onClick={() => setModalOpen(false)}
                />
              </div>
            </div>
          </ArenaModalFrame>
        </div>
      )}
    </ClubButtonsSurface>
  );
}
