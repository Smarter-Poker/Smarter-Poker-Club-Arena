/**
 * /bonuses - the Daily Club Arena Bonus, as a page.
 *
 * The same sheet the shell raises on entry, rendered inline for the nav link,
 * the wallet door, the profile's Bonus Center and any old bookmark. Sits in
 * the Rewards Circuit family with the shared surface header.
 */
import StandardContentLayout from '../components/layouts/StandardContentLayout';
import RewardsSurfaceHeader from '../components/rewards/RewardsSurfaceHeader';
import DailyBonusSheet from '../components/daily-bonus/DailyBonusSheet';
import './DailyBonusPage.css';

export default function DailyBonusPage() {
  return (
    <StandardContentLayout className="daily-bonus-page">
      <RewardsSurfaceHeader
        eyebrow="Rewards Circuit / Daily Bonus"
        title="Daily Club Arena Bonus"
        description="Show Up Every Day And Claim Each Tile By Hand: Diamonds, Throwables, Rabbit Hunts And Time Bank, Paid To Your Account The Moment You Tap. Unclaimed Tiles Are Gone At Midnight Central."
        art="diamonds"
        status="DAILY SHEET // LIVE"
      />
      <div className="daily-bonus-page__sheet">
        <DailyBonusSheet mode="inline" />
      </div>
    </StandardContentLayout>
  );
}
