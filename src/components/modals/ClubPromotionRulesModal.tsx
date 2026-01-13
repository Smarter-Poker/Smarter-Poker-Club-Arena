/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * 🎰 CLUB ENGINE — Club Promotion Rules Modal
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

export default function ClubPromotionRulesModal({ isOpen, onClose, onAccept }: ClubPromotionRulesModalProps) {
    const [hasAgreed, setHasAgreed] = useState(false);
    const [hasScrolledToBottom, setHasScrolledToBottom] = useState(false);
    const scrollRef = useRef<HTMLDivElement>(null);

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
            <div className={styles.modal}>
                <header className={styles.header}>
                    <h2>Club Promotion Rules</h2>
                    <button className={styles.closeButton} onClick={onClose}>✕</button>
                </header>

                <div className={styles.content} ref={scrollRef} onScroll={handleScroll}>
                    {/* Preamble */}
                    <p className={styles.preamble}>
                        For the purposes of these Club Promotion Rules, Smarter.Poker shall mean Smarter Poker LLC,
                        its partners, parent companies, subsidiaries, licensees, licensors and affiliates
                        (also collectively referred to herein as "Company", "we", "our" or "us").
                    </p>

                    <p className={styles.preamble}>
                        All Smarter.Poker product content, including but not limited to logos, trademarks, videos,
                        software, and online products, are copyrighted materials and protected by applicable
                        copyright and/or trademark law. Without express written permission from Smarter Poker LLC,
                        you shall never copy, modify, reproduce, translate, or tailor products, or create new
                        products or derivative works using the products in any written, visual, or audio form,
                        or by any means, whether electronic or mechanical. Any such activity constitutes an
                        infringement of Smarter Poker LLC copyrights, trademarks, or proprietary property, is
                        strictly prohibited by us, and may result in legal action and termination of your account
                        with Smarter.Poker.
                    </p>

                    {/* General Rules */}
                    <h3>General Rules</h3>
                    <p>
                        All users should participate in a way that promotes a legal and positive experience for
                        users and their followers. These Club Promotion Rules apply to all Fanpages/Club
                        Fanpages/Agency Pages/Clubs or any similar sites.
                    </p>
                    <p>
                        We may amend these Club Promotion Rules at any time and you agree to be subject to them.
                        If you do not wish to be subject to these Club Promotion Rules, any Smarter.Poker
                        Fanpages/Club Fanpages/Agency Pages/Clubs or any similar sites must be deleted.
                    </p>

                    {/* Section 1 */}
                    <h3>1. Compliance with Law</h3>
                    <p>
                        You must abide by all applicable local, state, national and international laws and
                        regulations. Any content or activity featuring, encouraging, offering, or soliciting
                        illegal activity is prohibited. We reserve the right to take action to the fullest
                        extent possible including removing players' access to the Service.
                    </p>

                    {/* Section 2 */}
                    <h3>2. Suspensions and Termination</h3>
                    <p>
                        Any and all suspensions or terminations are in the sole discretion of Smarter.Poker.
                        Any attempt to circumvent a termination or suspension through any means, including but
                        not limited to using other accounts or identities, domains, or webpages, will result
                        in suspension or termination.
                    </p>

                    {/* Section 3 */}
                    <h3>3. Violence, Threats and Other Expressly Prohibited Conduct</h3>
                    <p>
                        Smarter.Poker expressly prohibits acts and threats of violence. Any accounts, pages,
                        or clubs containing such content are not allowed and will be suspended (until remedied
                        at our direction) or terminated. We also prohibit hateful conduct, which includes
                        content or activity that promotes, encourages, or facilitates discrimination,
                        denigration, harassment or violence, including such actions based on race, ethnicity,
                        national origin, religion, sex, gender, gender identity, sexual orientation, age,
                        disability, or veteran status. In our sole discretion, we will take action against
                        any accounts, pages, or clubs that we believe contain such prohibited content. Our
                        actions may include suspension or termination of user accounts.
                    </p>

                    {/* Section 4 */}
                    <h3>4. Personal Information</h3>
                    <p>
                        If you share your personal information, you do so at your own risk. We prohibit the
                        sharing of content that contains the private information of another person without
                        such person's express permission. Private information includes a person's full name,
                        address, phone numbers, location, log-in identification/username and password. You
                        may also not share content that violates another person's reasonable expectation of
                        privacy (such as including people in videos who do not consent to be in those videos
                        and/or who do not consent to those videos being shared online). Including any personal
                        information (including photos or videos) of children (persons under 18) is strictly
                        prohibited.
                    </p>

                    {/* Section 5 */}
                    <h3>5. Identification and Impersonation</h3>
                    <p>
                        You are prohibited from misrepresenting yourself. This includes impersonating an
                        individual or an organization or your association with an organization (including
                        Smarter.Poker). Any attempt to misrepresent yourself as associated with Smarter.Poker
                        will result in adverse action, including suspension or termination of your account,
                        in our sole discretion.
                    </p>

                    {/* Section 6 */}
                    <h3>6. Other Prohibited Conduct</h3>
                    <p>
                        You may not engage in any activity that disrupts, interrupts, harms or otherwise
                        violates the integrity of Smarter.Poker's services or another user's use or enjoyment
                        of our services. This includes defrauding others, spreading misinformation, and
                        tampering with or defacing websites or social media pages (including posting
                        inappropriate content). We also prohibit content that is obscene or sexually explicit
                        and content that contains excessive gore or violence, as determined in our sole
                        discretion. We will take such action as we determine appropriate in our sole discretion
                        against those engaging in prohibited conduct, including the suspension or termination
                        of user accounts.
                    </p>

                    {/* Section 7 */}
                    <h3>7. Intellectual Property</h3>
                    <p>
                        You may only share content that you own or have permission to share. If you share
                        content that you do not own or have the right to share (such as music), you may be
                        infringing another party's intellectual property rights. If you share unauthorized
                        content, the content may be removed, and we may suspend or terminate your account.
                    </p>

                    {/* Section 8 */}
                    <h3>8. Cheating</h3>
                    <p>
                        We expressly prohibit any activities such as cheating, hacking, or tampering, that
                        give an individual or entity an unfair advantage in an online game or promotion.
                    </p>

                    {/* Brand Usage Section */}
                    <h3 className={styles.highlightHeader}>Use of Official Smarter.Poker Logos and Brand Elements</h3>
                    <p className={styles.highlight}>
                        1. You may not use any official Smarter.Poker logos and/or brand elements on your
                        Fanpage/Club Fanpage/Agency Page/Club on promotional materials in a way that implies
                        that Smarter.Poker is endorsing your promotional activities or is directly involved
                        in the Fanpage/Club Fanpage/Agency Page/Club that you promote.
                    </p>
                    <p>
                        2. In promoting your own Fanpage/Club Page please make sure that your advertising
                        material and other content is focused on your own brand materials such as your Club
                        logo, Fanpage logo, etc. You are specifically prohibited from using Smarter.Poker
                        elements without Smarter.Poker's permission.
                    </p>
                    <p>
                        3. It is permissible to add the Smarter.Poker logo and download link to the footer
                        of a page, but only if you include the following disclaimers:
                    </p>
                    <p className={styles.disclaimer}>
                        <strong>Smarter.Poker is an online social gaming platform and does not provide any
                            real-money service.</strong>
                    </p>
                    <p className={styles.disclaimer}>
                        <strong>Smarter.Poker is not a sponsor of or in any way involved with this promotional
                            activity, nor does Smarter.Poker endorse it.</strong>
                    </p>
                    <p className={styles.highlight}>
                        4. It is specifically forbidden to promote, directly or indirectly, in any manner,
                        Smarter.Poker as a real money application. Smarter.Poker reserves the right to suspend
                        or terminate your account at our sole discretion if we believe you are in violation
                        of this prohibition.
                    </p>
                    <p>
                        5. Club Owners, Managers and Agents must clarify when promoting their Club that
                        Smarter.Poker does not in any way involve itself with the operation of the Club/Union.
                    </p>

                    {/* Fair Usage */}
                    <h3>Fair Usage of Smarter.Poker Brand Elements</h3>
                    <p>
                        1. Subject to the Club Promotion Rules, fair use allows you to use some Smarter.Poker
                        brand elements on your Page. <strong>Examples of uses that likely fall under fair use,
                            provided the uses comply with these Club Promotion Rules:</strong>
                    </p>
                    <ul>
                        <li>A. Your Fanpage/Club Fanpage/Agency Page/Club discusses Smarter.Poker's new
                            features or discusses Club activities that use Smarter.Poker to organize friendly
                            games. Such pages must include proper disclaimers (see above, Use of Official
                            Smarter.Poker Logos and Brand Elements, section 3).</li>
                        <li>B. You are sharing screenshots of your own gameplay with your friends.</li>
                    </ul>
                    <p>
                        2. <strong>Examples of uses that likely do NOT fall under fair use:</strong>
                    </p>
                    <ul>
                        <li>A. Use that is misleading to visitors as to your affiliation with Smarter.Poker,
                            Smarter Poker LLC or any other brands provided by our Company</li>
                        <li>B. Using Smarter.Poker brand elements to promote your Club/Agency</li>
                        <li>C. Use that encourages violating our Terms of Service or these Rules</li>
                    </ul>
                    <p>
                        3. If you have questions regarding permissible, fair use, please refer to our Media
                        Guidelines or contact us via email at <a href="mailto:compliance@smarter.poker">compliance@smarter.poker</a>
                    </p>

                    {/* Naming */}
                    <h3>Naming and Brand Usage</h3>
                    <p>
                        <strong>1. Fansite Indication:</strong> In naming your Fanpage/Club Fanpage/Agency
                        Page etc., please include a term that indicates your site's status as a Club or Union
                        Fansite. Suggestions include "Fansite," "Union Unofficial Fanpage," "Unofficial Site,"
                        "Unofficial Community Site," or any other designation that has been approved by our
                        Compliance Team.
                    </p>
                    <p>
                        <strong>2. Domain Names:</strong> Do not use domain names that closely imitate official
                        Smarter.Poker domains. Make it clear and easily recognizable that your business is in
                        no way affiliated with Smarter.Poker.
                    </p>

                    {/* Legal Notice */}
                    <h3 className={styles.highlightHeader}>Legal Notice and Disclaimer</h3>
                    <p>
                        1. As stated in <strong>Use of Official Smarter.Poker Logos and Brand Elements</strong>,
                        section 3, you must incorporate the following disclaimers in all of your Fanpage's/Club
                        Fanpage's/Agency Page's/Club's publicity materials:
                    </p>
                    <p className={styles.disclaimer}>
                        <strong>Smarter.Poker is an online social gaming platform and does not provide any
                            real money service.</strong>
                    </p>
                    <p className={styles.disclaimer}>
                        <strong>Smarter.Poker is not a sponsor of or in any way involved with this promotional
                            activity, nor does Smarter.Poker endorse it.</strong>
                    </p>
                    <p>
                        2. If you have any questions about disclosures or any of these Club Promotion Rules,
                        or would like to obtain written permission to use brand elements, please email{' '}
                        <a href="mailto:compliance@smarter.poker">compliance@smarter.poker</a>.
                    </p>
                    <p>
                        3. If we become aware that any website, social media page, "app" or other media or
                        online site is breaching the terms of the Smarter.Poker Club Promotion Rules, we
                        reserve the right to take action to the fullest extent possible. Believing that these
                        Club Promotion Rules are being violated, we may take any and all actions possible in
                        our sole discretion, including, but not limited to, suspending and removing the
                        responsible Clubs.
                    </p>
                    <p>
                        4. We reserve the right to take legal action to the fullest extent of the law,
                        including reporting individuals in the applicable jurisdictions.
                    </p>

                    <div className={styles.scrollIndicator}>
                        {!hasScrolledToBottom && <span>↓ Scroll to read all rules ↓</span>}
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
                        <span>I have read and agree with the rules.</span>
                    </label>

                    <button
                        className={styles.confirmButton}
                        onClick={onAccept}
                        disabled={!hasAgreed}
                    >
                        Confirm
                    </button>
                </footer>
            </div>
        </div>
    );
}
