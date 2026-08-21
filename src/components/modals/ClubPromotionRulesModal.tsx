/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB ENGINE — Club Promotion Rules Modal
 * ═══════════════════════════════════════════════════════════════════════════════
 * Complete legal disclaimer for club owners and operators
 * MUST be acknowledged before creating a club
 */

import { useState, useRef, useEffect } from 'react';
import styles from './ClubPromotionRulesModal.module.css';

interface ClubPromotionRulesModalProps {
  isOpen: boolean;
  onClose: () => void;
  onAccept: () => void;
}

export default function ClubPromotionRulesModal({
  isOpen,
  onClose,
  onAccept,
}: ClubPromotionRulesModalProps) {
  const [hasAgreed, setHasAgreed] = useState(false);
  const [hasScrolledToBottom, setHasScrolledToBottom] = useState(false);
  const [mounted, setMounted] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isOpen) {
      // BUG FIX (mount-timer): track timer so it cancels on unmount — prevents stale setState
      const _mountTimer = setTimeout(() => setMounted(true), 50);
      return () => clearTimeout(_mountTimer);
    } else {
      setMounted(false);
    }
  }, [isOpen]);

  // Track scroll to enable checkbox
  const handleScroll = () => {
    if (scrollRef.current) {
      const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
      if (scrollTop + clientHeight >= scrollHeight - 20) {
        setHasScrolledToBottom(true);
      }
    }
  };

  // Reset state when modal opens
  useEffect(() => {
    if (isOpen) {
      setHasAgreed(false);
      setHasScrolledToBottom(false);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <div className={styles.overlay} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className={styles.modal}
        style={{
          opacity: mounted ? 1 : 0,
          transform: mounted ? 'translateY(0)' : 'translateY(8px)',
          transition: 'all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
        }}
      >
        <header className={styles.header}>
          <h2>Club Promotion Rules</h2>
          <button className={styles.closeButton} onClick={onClose}>
            ✕
          </button>
        </header>

        <div className={styles.content} ref={scrollRef} onScroll={handleScroll}>
          {/* Preamble */}
          <p className={styles.preamble}>
            For The Purposes Of These Club Promotion Rules, Club Arena Shall Mean Smarter Poker LLC,
            Its Partners, Parent Companies, Subsidiaries, Licensees, Licensors And Affiliates (Also
            Collectively Referred To Herein As "Company", "We", "Our" Or "Us").
          </p>

          <p className={styles.preamble}>
            All Club Arena Product Content, Including But Not Limited To Logos, Trademarks, Videos,
            Software, And Online Products, Are Copyrighted Materials And Protected By Applicable
            Copyright And/Or Trademark Law. Without Express Written Permission From Smarter Poker
            LLC, You Shall Never Copy, Modify, Reproduce, Translate, Or Tailor Products, Or Create
            New Products Or Derivative Works Using The Products In Any Written, Visual, Or Audio
            Form, Or By Any Means, Whether Electronic Or Mechanical. Any Such Activity Constitutes
            An Infringement Of Smarter Poker LLC Copyrights, Trademarks, Or Proprietary Property, Is
            Strictly Prohibited By Us, And May Result In Legal Action And Termination Of Your
            Account With Club Arena.
          </p>

          {/* General Rules */}
          <h3>General Rules</h3>
          <p>
            All Users Should Participate In A Way That Promotes A Legal And Positive Experience For
            Users And Their Followers. These Club Promotion Rules Apply To All Fanpages/Club
            Fanpages/Agency Pages/Clubs Or Any Similar Sites.
          </p>
          <p>
            We May Amend These Club Promotion Rules At Any Time And You Agree To Be Subject To Them.
            If You Do Not Wish To Be Subject To These Club Promotion Rules, Any Club Arena
            Fanpages/Club Fanpages/Agency Pages/Clubs Or Any Similar Sites Must Be Deleted.
          </p>

          {/* Section 1 */}
          <h3>1. Compliance With Law</h3>
          <p>
            You Must Abide By All Applicable Local, State, National And International Laws And
            Regulations. Any Content Or Activity Featuring, Encouraging, Offering, Or Soliciting
            Illegal Activity Is Prohibited. We Reserve The Right To Take Action To The Fullest
            Extent Possible Including Removing Players' Access To The Service.
          </p>

          {/* Section 2 */}
          <h3>2. Suspensions And Termination</h3>
          <p>
            Any And All Suspensions Or Terminations Are In The Sole Discretion Of Club Arena. Any
            Attempt To Circumvent A Termination Or Suspension Through Any Means, Including But Not
            Limited To Using Other Accounts Or Identities, Domains, Or Webpages, Will Result In
            Suspension Or Termination.
          </p>

          {/* Section 3 */}
          <h3>3. Violence, Threats And Other Expressly Prohibited Conduct</h3>
          <p>
            Club Arena Expressly Prohibits Acts And Threats Of Violence. Any Accounts, Pages, Or
            Clubs Containing Such Content Are Not Allowed And Will Be Suspended (Until Remedied At
            Our Direction) Or Terminated. We Also Prohibit Hateful Conduct, Which Includes Content
            Or Activity That Promotes, Encourages, Or Facilitates Discrimination, Denigration,
            Harassment Or Violence, Including Such Actions Based On Race, Ethnicity, National
            Origin, Religion, Sex, Gender, Gender Identity, Sexual Orientation, Age, Disability, Or
            Veteran Status. In Our Sole Discretion, We Will Take Action Against Any Accounts, Pages,
            Or Clubs That We Believe Contain Such Prohibited Content. Our Actions May Include
            Suspension Or Termination Of User Accounts.
          </p>

          {/* Section 4 */}
          <h3>4. Personal Information</h3>
          <p>
            If You Share Your Personal Information, You Do So At Your Own Risk. We Prohibit The
            Sharing Of Content That Contains The Private Information Of Another Person Without Such
            Person's Express Permission. Private Information Includes A Person's Full Name, Address,
            Phone Numbers, Location, Log-In Identification/Username And Password. You May Also Not
            Share Content That Violates Another Person's Reasonable Expectation Of Privacy (Such As
            Including People In Videos Who Do Not Consent To Be In Those Videos And/Or Who Do Not
            Consent To Those Videos Being Shared Online). Including Any Personal Information
            (Including Photos Or Videos) Of Children (Persons Under 18) Is Strictly Prohibited.
          </p>

          {/* Section 5 */}
          <h3>5. Identification And Impersonation</h3>
          <p>
            You Are Prohibited From Misrepresenting Yourself. This Includes Impersonating An
            Individual Or An Organization Or Your Association With An Organization (Including Club
            Arena). Any Attempt To Misrepresent Yourself As Associated With Club Arena Will Result
            In Adverse Action, Including Suspension Or Termination Of Your Account, In Our Sole
            Discretion.
          </p>

          {/* Section 6 */}
          <h3>6. Other Prohibited Conduct</h3>
          <p>
            You May Not Engage In Any Activity That Disrupts, Interrupts, Harms Or Otherwise
            Violates The Integrity Of Club Arena's Services Or Another User's Use Or Enjoyment Of
            Our Services. This Includes Defrauding Others, Spreading Misinformation, And Tampering
            With Or Defacing Websites Or Social Media Pages (Including Posting Inappropriate
            Content). We Also Prohibit Content That Is Obscene Or Sexually Explicit And Content That
            Contains Excessive Gore Or Violence, As Determined In Our Sole Discretion. We Will Take
            Such Action As We Determine Appropriate In Our Sole Discretion Against Those Engaging In
            Prohibited Conduct, Including The Suspension Or Termination Of User Accounts.
          </p>

          {/* Section 7 */}
          <h3>7. Intellectual Property</h3>
          <p>
            You May Only Share Content That You Own Or Have Permission To Share. If You Share
            Content That You Do Not Own Or Have The Right To Share (Such As Music), You May Be
            Infringing Another Party's Intellectual Property Rights. If You Share Unauthorized
            Content, The Content May Be Removed, And We May Suspend Or Terminate Your Account.
          </p>

          {/* Section 8 */}
          <h3>8. Cheating</h3>
          <p>
            We Expressly Prohibit Any Activities Such As Cheating, Hacking, Or Tampering, That Give
            An Individual Or Entity An Unfair Advantage In An Online Game Or Promotion.
          </p>

          {/* Brand Usage Section */}
          <h3 className={styles.highlightHeader}>
            Use Of Official Club Arena Logos And Brand Elements
          </h3>
          <p className={styles.highlight}>
            1. You May Not Use Any Official Club Arena Logos And/Or Brand Elements On Your
            Fanpage/Club Fanpage/Agency Page/Club On Promotional Materials In A Way That Implies
            That Club Arena Is Endorsing Your Promotional Activities Or Is Directly Involved In The
            Fanpage/Club Fanpage/Agency Page/Club That You Promote.
          </p>
          <p>
            2. In Promoting Your Own Fanpage/Club Page Please Make Sure That Your Advertising
            Material And Other Content Is Focused On Your Own Brand Materials Such As Your Club
            Logo, Fanpage Logo, Etc. You Are Specifically Prohibited From Using Club Arena Elements
            Without Club Arena's Permission.
          </p>
          <p>
            3. It Is Permissible To Add The Club Arena Logo And Download Link To The Footer Of A
            Page, But Only If You Include The Following Disclaimers:
          </p>
          <p className={styles.disclaimer}>
            <strong>
              Club Arena Is An Online Social Gaming Platform And Does Not Provide Any Real-Money
              Service.
            </strong>
          </p>
          <p className={styles.disclaimer}>
            <strong>
              Club Arena Is Not A Sponsor Of Or In Any Way Involved With This Promotional Activity,
              Nor Does Club Arena Endorse It.
            </strong>
          </p>
          <p className={styles.highlight}>
            4. It Is Specifically Forbidden To Promote, Directly Or Indirectly, In Any Manner, Club
            Arena As A Real Money Application. Club Arena Reserves The Right To Suspend Or Terminate
            Your Account At Our Sole Discretion If We Believe You Are In Violation Of This
            Prohibition.
          </p>
          <p>
            5. Club Owners, Managers And Agents Must Clarify When Promoting Their Club That Club
            Arena Does Not In Any Way Involve Itself With The Operation Of The Club/Union.
          </p>

          {/* Fair Usage */}
          <h3>Fair Usage Of Club Arena Brand Elements</h3>
          <p>
            1. Subject To The Club Promotion Rules, Fair Use Allows You To Use Some Club Arena Brand
            Elements On Your Page.{' '}
            <strong>
              Examples Of Uses That Likely Fall Under Fair Use, Provided The Uses Comply With These
              Club Promotion Rules:
            </strong>
          </p>
          <ul>
            <li>
              A. Your Fanpage/Club Fanpage/Agency Page/Club Discusses Club Arena's New Features Or
              Discusses Club Activities That Use Club Arena To Organize Friendly Games. Such Pages
              Must Include Proper Disclaimers (See Above, Use Of Official Club Arena Logos And Brand
              Elements, Section 3).
            </li>
            <li>B. You Are Sharing Screenshots Of Your Own Gameplay With Your Friends.</li>
          </ul>
          <p>
            2. <strong>Examples Of Uses That Likely Do NOT Fall Under Fair Use:</strong>
          </p>
          <ul>
            <li>
              A. Use That Is Misleading To Visitors As To Your Affiliation With Club Arena, Smarter
              Poker LLC Or Any Other Brands Provided By Our Company
            </li>
            <li>B. Using Club Arena Brand Elements To Promote Your Club/Agency</li>
            <li>C. Use That Encourages Violating Our Terms Of Service Or These Rules</li>
          </ul>
          <p>
            3. If You Have Questions Regarding Permissible, Fair Use, Please Refer To Our Media
            Guidelines Or Contact Us Via Email At{' '}
            <a href="mailto:compliance@smarter.poker">Compliance@Smarter.Poker</a>
          </p>

          {/* Naming */}
          <h3>Naming And Brand Usage</h3>
          <p>
            <strong>1. Fansite Indication:</strong> In Naming Your Fanpage/Club Fanpage/Agency Page
            Etc., Please Include A Term That Indicates Your Site's Status As A Club Or Union
            Fansite. Suggestions Include "Fansite," "Union Unofficial Fanpage," "Unofficial Site,"
            "Unofficial Community Site," Or Any Other Designation That Has Been Approved By Our
            Compliance Team.
          </p>
          <p>
            <strong>2. Domain Names:</strong> Do Not Use Domain Names That Closely Imitate Official
            Club Arena Domains. Make It Clear And Easily Recognizable That Your Business Is In No
            Way Affiliated With Club Arena.
          </p>

          {/* Legal Notice */}
          <h3 className={styles.highlightHeader}>Legal Notice And Disclaimer</h3>
          <p>
            1. As Stated In <strong>Use Of Official Club Arena Logos And Brand Elements</strong>,
            Section 3, You Must Incorporate The Following Disclaimers In All Of Your Fanpage's/Club
            Fanpage's/Agency Page's/Club's Publicity Materials:
          </p>
          <p className={styles.disclaimer}>
            <strong>
              Club Arena Is An Online Social Gaming Platform And Does Not Provide Any Real Money
              Service.
            </strong>
          </p>
          <p className={styles.disclaimer}>
            <strong>
              Club Arena Is Not A Sponsor Of Or In Any Way Involved With This Promotional Activity,
              Nor Does Club Arena Endorse It.
            </strong>
          </p>
          <p>
            2. If You Have Any Questions About Disclosures Or Any Of These Club Promotion Rules, Or
            Would Like To Obtain Written Permission To Use Brand Elements, Please Email{' '}
            <a href="mailto:compliance@smarter.poker">Compliance@Smarter.Poker</a>.
          </p>
          <p>
            3. If We Become Aware That Any Website, Social Media Page, "App" Or Other Media Or
            Online Site Is Breaching The Terms Of The Club Arena Club Promotion Rules, We Reserve
            The Right To Take Action To The Fullest Extent Possible. Believing That These Club
            Promotion Rules Are Being Violated, We May Take Any And All Actions Possible In Our Sole
            Discretion, Including, But Not Limited To, Suspending And Removing The Responsible
            Clubs.
          </p>
          <p>
            4. We Reserve The Right To Take Legal Action To The Fullest Extent Of The Law, Including
            Reporting Individuals In The Applicable Jurisdictions.
          </p>

          <div className={styles.scrollIndicator}>
            {!hasScrolledToBottom && <span>↓ Scroll To Read All Rules ↓</span>}
          </div>
        </div>

        <footer className={styles.footer}>
          <label className={`${styles.checkbox} ${!hasScrolledToBottom ? styles.disabled : ''}`}>
            <input
              type="checkbox"
              checked={hasAgreed}
              onChange={(e) => setHasAgreed(e.target.checked)}
              disabled={!hasScrolledToBottom}
            />
            <span className={styles.checkmark} />
            <span>I Have Read And Agree With The Rules.</span>
          </label>

          <button className={styles.confirmButton} onClick={onAccept} disabled={!hasAgreed}>
            Confirm
          </button>
        </footer>
      </div>
    </div>
  );
}
