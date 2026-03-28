// Known chains and franchises to skip during lead generation
// These are large national/international brands that won't need Ardeno's services
// Add more as you find them slipping through

const CHAINS: string[] = [
  // ── International fast food ───────────────────────────────────────────────
  'kfc',
  'mcdonald',
  'burger king',
  'pizza hut',
  "domino's",
  'dominoes',
  'dominos',
  'subway',
  'starbucks',
  'costa coffee',
  'dairy queen',
  'dunkin',
  'dunkin donuts',
  'popeyes',
  "nando's",
  'nandos',
  'hardees',
  'baskin robbins',
  'krispy kreme',
  'papa johns',

  // ── Sri Lankan retail / supermarkets ──────────────────────────────────────
  'keells',
  'keels',
  'cargills',
  'arpico',
  'laugfs',
  'sathosa',
  'lanka sathosa',
  'glomark',
  'food city',
  'softlogic max',

  // ── Telecom ───────────────────────────────────────────────────────────────
  'dialog axiata',
  'dialog outlet',
  'dialog store',
  'dialog experience',
  'mobitel',
  'hutch',
  'airtel lanka',
  'slt mobitel',

  // ── Banks & finance ───────────────────────────────────────────────────────
  'bank of ceylon',
  'peoples bank',
  "people's bank",
  'commercial bank',
  'hatton national bank',
  'sampath bank',
  'nations trust bank',
  'dfcc bank',
  'hnb',
  'nsb',
  'panadura savings',
  'boc',
  'union bank',
  'amana bank',
  'mcb bank',

  // ── Hotel chains ──────────────────────────────────────────────────────────
  'hilton',
  'marriott',
  'sheraton',
  'radisson',
  'ibis',
  'novotel',
  'hyatt',
  'cinnamon grand',
  'cinnamon lake',
  'cinnamon red',
  'cinnamon wild',
  'cinnamon bey',
  'cinnamon citadel',
  'jetwing',
  'amaya',
  'chaaya',
  'uga',
  'anantara',
  'shangri-la',

  // ── Fitness chains ────────────────────────────────────────────────────────
  'fitness first',
  "gold's gym",
  'golds gym',
  'anytime fitness',

  // ── Sri Lankan conglomerates / large brands ───────────────────────────────
  'softlogic',
  'john keells',
  'aitken spence',
  'hemas',
  'damro',
  'singer',
  'abans',
  'softlogic holdings',
  'lolc',
  'haycarb',
  'cic holdings',
  'distilleries company',
  'lion brewery',
  'ceylon tobacco',
  'melsta',
  'expolanka',

  // ── Pharmacy chains ───────────────────────────────────────────────────────
  'osu sala',
  'national medicines',
  'keels pharma',

  // ── Fuel / utility ───────────────────────────────────────────────────────
  'ceypetco',
  'laugfs gas',
  'laugfs petroleum',
  'shell sri lanka',
  'ceylon electricity',
  'national water',

  // ── Courier / logistics ───────────────────────────────────────────────────
  'dhl',
  'fedex',
  'ups sri lanka',
  'kapruka',
  'ikman',

  // ── E-commerce / platforms ────────────────────────────────────────────────
  'daraz',
  'quickee',
]

// Pre-process: lowercase + trimmed for fast lookups
const CHAIN_SET = CHAINS.map(c => c.toLowerCase().trim())

/**
 * Returns true if the business name matches a known chain or franchise.
 * Checks word-boundary style: "KFC Colombo 3" → match, "KFCO" → no match.
 */
export function isChainOrFranchise(businessName: string): boolean {
  const name = businessName.toLowerCase().trim()
  return CHAIN_SET.some(chain => {
    // Exact match
    if (name === chain) return true
    // Chain name appears at the start: "kfc colombo 3"
    if (name.startsWith(chain + ' ') || name.startsWith(chain + '-')) return true
    // Chain name appears anywhere as a whole word: "colombo pizza hut express"
    const escaped = chain.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`\\b${escaped}\\b`).test(name)
  })
}
