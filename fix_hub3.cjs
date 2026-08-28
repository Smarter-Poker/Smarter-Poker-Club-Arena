const fs = require('fs');
const file = '/Users/smarter.poker/Documents/.agent-trees/Smarter-Poker-World-Hub/antigravity-ads/src/components/ads/HubPromoRail.jsx';
let content = fs.readFileSync(file, 'utf8');

content = content.replace(
    'const [ads, setAds] = useState([]);',
    `const [ads, setAds] = useState([]);

    const handleDismiss = (e, adId) => {
        e.preventDefault();
        e.stopPropagation();
        import('../../services/adService').then(({ logDismiss }) => {
            logDismiss(adId, SLOT);
        });
        setAds((prev) => prev.filter((a) => a.adId !== adId));
    };`
);

content = content.replace(
    '<Link key={ad.adId} href={href} legacyBehavior>',
    '<div key={ad.adId} className="promo-card-wrapper">\n                    <Link href={href} legacyBehavior>'
);

content = content.replace(
    '                            {ad.ctaLabel ? <span className="promo-cta">{ad.ctaLabel}</span> : null}\n                        </a>\n                    </Link>',
    `                            {ad.ctaLabel ? <span className="promo-cta">{ad.ctaLabel}</span> : null}
                        </a>
                    </Link>
                    <button
                        type="button"
                        className="promo-dismiss"
                        aria-label="Dismiss promotion"
                        onClick={(e) => handleDismiss(e, ad.adId)}
                    >
                        ✕
                    </button>
                </div>`
);

content = content.replace(
    '.promo-card {',
    `.promo-card-wrapper {
                    position: relative;
                    display: flex;
                }
                .promo-card {
                    flex: 1;`
);

content = content.replace(
    '                .promo-cta {',
    `                .promo-dismiss {
                    position: absolute;
                    top: -8px;
                    right: -8px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    width: 24px;
                    height: 24px;
                    padding: 0;
                    border: 1px solid #dadde1;
                    background: #ffffff;
                    color: #8892a4;
                    font-size: 14px;
                    border-radius: 50%;
                    cursor: pointer;
                    box-shadow: 0 2px 4px rgba(0,0,0,0.1);
                    transition: color 0.15s ease, background 0.15s ease;
                    z-index: 2;
                }
                .promo-dismiss:hover, .promo-dismiss:focus-visible {
                    color: #050505;
                    background: #f7f8fa;
                    outline: none;
                }
                .promo-cta {`
);

fs.writeFileSync(file, content);
