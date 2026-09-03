import type {
  ArenaGameCardFamilyRegistry,
  ArenaGameCardPresentationTemplate,
  ArenaGameCardSkin,
  ArenaGameCardTemplateRegistry,
  ArenaGameCardTemplateValidationIssue,
  ArenaGameFamily,
  ArenaGamePresentation,
  ArenaGameStatus,
  ResolveArenaGameCardTemplateInput,
  ResolvedArenaGameCardTemplate,
} from './arenaGameCardTypes';

const asset = (path: string) => `${import.meta.env.BASE_URL}assets/club-buttons/game-cards/${path}`;

const ALL_STATES: readonly ArenaGameStatus[] = [
  'open',
  'running',
  'filling',
  'registering',
  'late-reg',
  'full',
  'waitlist',
  'closed',
  'starting',
  'paused',
];

const REQUIRED_ZONES: Record<ArenaGameFamily, readonly string[]> = {
  mtt: ['title', 'buyIn', 'registered', 'status', 'primaryAction'],
  nlh: ['title', 'gameType', 'stakes', 'players', 'buyIn', 'status', 'primaryAction'],
  plo: ['title', 'gameType', 'stakes', 'players', 'buyIn', 'status', 'primaryAction'],
  spins: ['title', 'gameType', 'buyIn', 'registered', 'status', 'primaryAction'],
  'heads-up': ['title', 'gameType', 'buyIn', 'registered', 'status', 'primaryAction'],
};

const FAMILY_ZONES: Record<ArenaGameFamily, readonly string[]> = {
  mtt: [
    'title',
    'subtitle',
    'status',
    'guarantee',
    'startsIn',
    'startingTime',
    'buyIn',
    'registered',
    'startingStack',
    'currentLevel',
    'blinds',
    'featuredBadge',
    'registeredBadge',
    'rules',
    'secondaryAction',
    'primaryAction',
  ],
  nlh: [
    'title',
    'subtitle',
    'status',
    'gameType',
    'stakes',
    'players',
    'buyIn',
    'rules',
    'secondaryAction',
    'primaryAction',
  ],
  plo: [
    'title',
    'subtitle',
    'status',
    'gameType',
    'stakes',
    'players',
    'buyIn',
    'rules',
    'secondaryAction',
    'primaryAction',
  ],
  spins: [
    'title',
    'subtitle',
    'status',
    'promotion',
    'maxPayout',
    'topPrize',
    'gameType',
    'buyIn',
    'registered',
    'startingStack',
    'blindLevels',
    'format',
    'primaryAction',
  ],
  'heads-up': [
    'title',
    'subtitle',
    'status',
    'gameType',
    'buyIn',
    'registered',
    'startingStack',
    'blindLevels',
    'format',
    'rules',
    'primaryAction',
  ],
};

function zoneMap(family: ArenaGameFamily) {
  return Object.fromEntries(
    FAMILY_ZONES[family].map((name, order) => [name, { order }])
  ) as ArenaGameCardPresentationTemplate['zones'];
}

function presentation(
  family: ArenaGameFamily,
  variant: 'desktop' | 'mobile',
  path: string,
  aspectRatio: string,
  minWidth: number,
  layoutVersion = 'v1'
): ArenaGameCardPresentationTemplate {
  return {
    asset: asset(path),
    aspectRatio,
    minWidth,
    layout: `${family}-${variant}-machine-${layoutVersion}`,
    zones: zoneMap(family),
  };
}

function skin(
  family: ArenaGameFamily,
  id: string,
  name: string,
  desktop: ArenaGameCardPresentationTemplate,
  mobile: ArenaGameCardPresentationTemplate,
  lifecycle: ArenaGameCardSkin['lifecycle'] = 'draft'
): ArenaGameCardSkin {
  return {
    id,
    family,
    version: Number(id.match(/-v(\d+)$/)?.[1] || 1),
    name,
    lifecycle,
    desktop,
    mobile,
    statusSlots: ['status'],
    actionSlots: ['primaryAction', 'secondaryAction'],
    badgeSlots: family === 'mtt' ? ['featuredBadge', 'registeredBadge'] : [],
    ruleSlots: ['rules'],
    supportedStates: ALL_STATES,
    supportedActions: [
      'details',
      'register',
      'unregister',
      'view-table',
      'join-table',
      'join-waitlist',
      'sit-down',
    ],
    dynamicTextRules: {
      title: { maxLines: 2, overflow: 'ellipsis' },
      subtitle: { maxLines: 1, overflow: 'ellipsis' },
      value: { maxLines: 2, overflow: 'wrap' },
    },
  };
}

function familyRegistry(
  family: ArenaGameFamily,
  defaultSkin: string,
  cardSkins: readonly ArenaGameCardSkin[]
): ArenaGameCardFamilyRegistry {
  return {
    family,
    defaultSkin,
    fallbackSkin: defaultSkin,
    requiredZones: REQUIRED_ZONES[family],
    skins: Object.fromEntries(cardSkins.map((cardSkin) => [cardSkin.id, cardSkin])),
  };
}

const mttV1 = skin(
  'mtt',
  'shark-mtt-v1',
  'Shark MTT V1 - Draft',
  presentation('mtt', 'desktop', 'mtt/desktop.png', '754 / 944', 360),
  presentation('mtt', 'mobile', 'mtt/mobile.png', '754 / 944', 280)
);
const mttV2 = skin(
  'mtt',
  'shark-mtt-v2',
  'Shark MTT V2 - Premium Approved',
  presentation('mtt', 'desktop', 'mtt/shell-desktop-v2.webp', '1085 / 1450', 360, 'v2'),
  presentation(
    'mtt',
    'mobile',
    'mtt/shell-mobile-v4-reference-clean.png',
    '1088 / 1445',
    280,
    'v4'
  ),
  'approved'
);
const nlhV1 = skin(
  'nlh',
  'shark-nlh-v1',
  'Shark NLH V1 - Draft',
  presentation('nlh', 'desktop', 'nlh/desktop.png', '722 / 930', 360),
  presentation('nlh', 'mobile', 'nlh/mobile.png', '754 / 823', 280)
);
const nlhV2 = skin(
  'nlh',
  'shark-nlh-v2',
  'Shark NLH V2 - Premium Approved',
  presentation('nlh', 'desktop', 'nlh/shell-desktop-v2.webp', '1109 / 1418', 360, 'v2'),
  presentation('nlh', 'mobile', 'nlh/shell-mobile-v4-reference-clean.png', '1 / 1', 280, 'v4'),
  'approved'
);
const nlhPremiumV1 = skin(
  'nlh',
  'spade-nlh-premium-v1',
  'Spade NLH Premium V1 - Approved',
  presentation('nlh', 'desktop', 'nlh/shell-desktop-v2.webp', '1109 / 1418', 360, 'v2'),
  presentation(
    'nlh',
    'mobile',
    'nlh/spade-nlh-premium-v1/chassis.png',
    '729 / 945',
    280,
    'premium-v1'
  ),
  'approved'
);
const nlhTallV2 = skin(
  'nlh',
  'shark-nlh-tall-v2',
  'Shark NLH Tall Reference V2',
  presentation('nlh', 'desktop', 'nlh/shell-desktop-v2.webp', '1109 / 1418', 360, 'v2'),
  presentation(
    'nlh',
    'mobile',
    'nlh/shell-mobile-v4-tall-reference.png',
    '1099 / 1431',
    280,
    'v4-tall'
  ),
  'approved'
);
const ploV1 = skin(
  'plo',
  'shark-plo-v1',
  'Shark PLO V1 - Draft',
  presentation('plo', 'desktop', 'plo/desktop.png', '706 / 856', 360),
  presentation('plo', 'mobile', 'plo/mobile.png', '754 / 944', 280)
);
const ploV2 = skin(
  'plo',
  'shark-plo-v2',
  'Shark PLO V2 - Premium Approved',
  presentation('plo', 'desktop', 'plo/shell-desktop-v2.webp', '1148 / 1370', 360, 'v2'),
  presentation(
    'plo',
    'mobile',
    'plo/shell-mobile-v4-reference-clean.png',
    '1117 / 1408',
    280,
    'v4'
  ),
  'approved'
);
/* THE FOUR-BAY OMAHA CONSOLE (Dan 2026-09-03): every PLO / PLO5 / PLO6 / PLO8
   card on a phone is the shark-crest four-bay master with the variant first
   ("PLO5 25/50") and the table name under it. Layered renderer:
   PloFourBayCard.tsx. */
const ploFourBayV1 = skin(
  'plo',
  'shark-plo-four-bay-v1',
  'Shark PLO Four-Bay V1 - Layered',
  presentation('plo', 'desktop', 'plo/shell-desktop-v2.webp', '1148 / 1370', 360, 'v2'),
  presentation('plo', 'mobile', 'plo/shark-four-bay-v1/chassis.png', '1 / 1', 280, 'four-bay-v1'),
  'approved'
);
const spinsV1 = skin(
  'spins',
  'shark-spins-v1',
  'Shark Spins V1 - Draft',
  presentation('spins', 'desktop', 'spins/desktop.png', '754 / 944', 360),
  presentation('spins', 'mobile', 'spins/mobile.png', '754 / 944', 280)
);
const spinsV2 = skin(
  'spins',
  'shark-spins-v2',
  'Shark Spins V2 - Premium Approved',
  presentation('spins', 'desktop', 'spins/shell-desktop-v2.webp', '1111 / 1416', 360, 'v2'),
  presentation(
    'spins',
    'mobile',
    'spins/shell-mobile-v4-reference-clean.png',
    '1122 / 1402',
    280,
    'v4'
  ),
  'approved'
);
/* The approved Spins master, dynamic words lifted out (SpinsPremiumCard.tsx). */
const spinsPremiumV1 = skin(
  'spins',
  'shark-spins-premium-v1',
  'Shark Spins Premium V1 - Layered',
  presentation('spins', 'desktop', 'spins/shell-desktop-v2.webp', '1111 / 1416', 360, 'v2'),
  presentation(
    'spins',
    'mobile',
    'spins/shark-spins-premium-v1/chassis.png',
    '734 / 949',
    280,
    'premium-v1'
  ),
  'approved'
);
const headsUpV1 = skin(
  'heads-up',
  'shark-headsup-v1',
  'Shark Heads-Up V1 - Draft',
  presentation('heads-up', 'desktop', 'heads-up/desktop.png', '754 / 944', 360),
  presentation('heads-up', 'mobile', 'heads-up/mobile.png', '754 / 944', 280)
);
const headsUpV2 = skin(
  'heads-up',
  'shark-headsup-v2',
  'Shark Heads-Up V2 - Premium Approved',
  presentation('heads-up', 'desktop', 'heads-up/shell-desktop-v2.webp', '1085 / 1450', 360, 'v2'),
  presentation(
    'heads-up',
    'mobile',
    'heads-up/shell-mobile-v4-reference-clean.png',
    '1087 / 1447',
    280,
    'v4'
  ),
  'approved'
);

/* The approved Heads-Up master, dynamic words lifted out (HeadsUpPremiumCard.tsx). */
const headsUpPremiumV1 = skin(
  'heads-up',
  'shark-headsup-premium-v1',
  'Shark Heads-Up Premium V1 - Layered',
  presentation('heads-up', 'desktop', 'heads-up/shell-desktop-v2.webp', '1085 / 1450', 360, 'v2'),
  presentation(
    'heads-up',
    'mobile',
    'heads-up/shark-headsup-premium-v1/chassis.png',
    '733 / 979',
    280,
    'premium-v1'
  ),
  'approved'
);

/** The one canonical source of truth for Club Arena lobby-card visual skins. */
export const ARENA_GAME_CARD_TEMPLATE_REGISTRY: ArenaGameCardTemplateRegistry = {
  mtt: familyRegistry('mtt', mttV2.id, [mttV2, mttV1]),
  nlh: familyRegistry('nlh', nlhPremiumV1.id, [nlhPremiumV1, nlhV2, nlhTallV2, nlhV1]),
  /* Approved by Dan 2026-09-03 (side-by-side review): the layered masters are
     the mobile defaults for Omaha, Spins and Heads-Up; the V2 CSS shells stay
     registered for desktop and as fallbacks. */
  plo: familyRegistry('plo', ploFourBayV1.id, [ploFourBayV1, ploV2, ploV1]),
  spins: familyRegistry('spins', spinsPremiumV1.id, [spinsPremiumV1, spinsV2, spinsV1]),
  'heads-up': familyRegistry('heads-up', headsUpPremiumV1.id, [
    headsUpPremiumV1,
    headsUpV2,
    headsUpV1,
  ]),
};

const warned = new Set<string>();

function developmentWarning(message: string) {
  if (!import.meta.env.DEV || warned.has(message)) return;
  warned.add(message);
  console.warn(`[ArenaGameCardTemplateRegistry] ${message}`);
}

export function resolveArenaGameCardTemplate(
  input: ResolveArenaGameCardTemplateInput
): ResolvedArenaGameCardTemplate {
  const registry = input.registry || ARENA_GAME_CARD_TEMPLATE_REGISTRY;
  const familyEntry = registry[input.family];
  const candidates = [
    input.skin || undefined,
    input.clubSkin || undefined,
    familyEntry.defaultSkin,
    familyEntry.fallbackSkin,
  ].filter((candidate): candidate is string => Boolean(candidate));
  const skinId =
    candidates.find((candidate) => Boolean(familyEntry.skins[candidate])) ||
    familyEntry.fallbackSkin;
  const selectedSkin = familyEntry.skins[skinId];
  if (!selectedSkin) throw new Error(`No valid fallback skin is registered for ${input.family}.`);

  const requestedSkin = input.skin || input.clubSkin || undefined;
  const didFallback = Boolean(requestedSkin && requestedSkin !== skinId);
  if (didFallback)
    developmentWarning(`Unknown ${input.family} skin “${requestedSkin}”; using “${skinId}”.`);

  const presentationName: ArenaGamePresentation =
    input.presentation ||
    (typeof input.viewportWidth === 'number' && input.viewportWidth >= 768 ? 'desktop' : 'mobile');

  return {
    family: input.family,
    skinId,
    skin: selectedSkin,
    presentation: presentationName,
    template: selectedSkin[presentationName],
    requestedSkin,
    didFallback,
  };
}

export function listArenaGameCardSkins(family: ArenaGameFamily) {
  return Object.values(ARENA_GAME_CARD_TEMPLATE_REGISTRY[family].skins);
}

export function validateArenaGameCardRegistry(
  registry: ArenaGameCardTemplateRegistry = ARENA_GAME_CARD_TEMPLATE_REGISTRY
): ArenaGameCardTemplateValidationIssue[] {
  const issues: ArenaGameCardTemplateValidationIssue[] = [];
  for (const family of Object.keys(registry) as ArenaGameFamily[]) {
    const entry = registry[family];
    if (!entry.skins[entry.defaultSkin])
      issues.push({ family, message: `Default skin “${entry.defaultSkin}” is missing.` });
    if (!entry.skins[entry.fallbackSkin])
      issues.push({ family, message: `Fallback skin “${entry.fallbackSkin}” is missing.` });
    for (const [skinId, cardSkin] of Object.entries(entry.skins)) {
      if (cardSkin.id !== skinId)
        issues.push({ family, skinId, message: 'Registry key and skin id do not match.' });
      if (cardSkin.family !== family)
        issues.push({ family, skinId, message: `Skin declares family “${cardSkin.family}”.` });
      for (const variant of ['desktop', 'mobile'] as const) {
        const template = cardSkin[variant];
        if (!template.asset)
          issues.push({ family, skinId, message: `${variant} asset is missing.` });
        if (!template.aspectRatio)
          issues.push({ family, skinId, message: `${variant} aspect ratio is missing.` });
        for (const zone of entry.requiredZones) {
          if (!template.zones[zone])
            issues.push({
              family,
              skinId,
              message: `${variant} mandatory zone “${zone}” is missing.`,
            });
        }
      }
    }
  }
  return issues;
}

if (import.meta.env.DEV) {
  for (const issue of validateArenaGameCardRegistry())
    developmentWarning(`${issue.family}/${issue.skinId || 'family'}: ${issue.message}`);
}
