/**
 * /bonuses - the Daily Club Arena Bonus, as a page.
 *
 * The same sheet the shell raises on entry, rendered inline for the nav link,
 * the wallet door, the profile's Bonus Center and any old bookmark. Sits in
 * the Rewards Circuit family with the shared surface header, and the sheet
 * prints on that header's own glass (#ClubArenaConsole: one master per
 * surface, never a frame inside a frame), so the page is one picture.
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
        title="Daily Bonus"
        description="Show Up Every Day And Claim All Rewards With One Tap. Reward Types Change Daily, With No Repeat In The Same Slot On Consecutive Days. Unclaimed Rewards Are Gone At Midnight Central."
        art="diamonds"
        status="DAILY SHEET // LIVE"
        crest="diamond"
      >
        <DailyBonusSheet mode="inline" chassis="glass" />
      </RewardsSurfaceHeader>
    </StandardContentLayout>
  );
}
