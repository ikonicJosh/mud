/**
 * Ikonic's ideal customer profile, lifted from the ghl-hot-leads-outreach skill.
 *
 * Ikonic sells marketing and commercial wraps to local service businesses.
 * NOT a detailing shop — that distinction matters in every draft the agent writes.
 */

export const CORE_INDUSTRIES = [
  'HVAC',
  'plumbing',
  'electrical',
  'landscaping',
  'pest control',
  'roofing',
  'cleaning',
  'garage door',
  'septic',
  'paving',
  'tree service',
  'pool service',
] as const;

/** Service businesses without a vehicle fleet — still viable, lower fit. */
export const ADJACENT_INDUSTRIES = [
  'general contracting',
  'remodeling',
  'flooring',
  'painting',
  'restoration',
  'security systems',
] as const;

export const TARGET_TITLES = [
  'owner',
  'co-owner',
  'founder',
  'president',
  'general manager',
  'operations manager',
  'vice president',
] as const;

/** Titles that indicate we've found an employee, not a decision maker. */
export const EXCLUDE_TITLES = [
  'intern',
  'student',
  'apprentice',
  'technician',
  'installer',
  'dispatcher',
  'recruiter',
] as const;

export const FIRMOGRAPHICS = {
  /** Fleet size sweet spot — enough trucks to matter, small enough that Josh talks to the owner. */
  fleetSize: { min: 1, max: 20, ideal: { min: 3, max: 12 } },
  employeeCount: { min: 3, max: 100 },
  revenue: { min: 500_000, max: 5_000_000 },
};

/** Geography. Empty means no geographic filter. */
export const TARGET_GEOS: string[] = [];

/**
 * Feeds for engagement mining — groups, hashtags, and company pages where ICP
 * owners actually post. Josh should extend this; it is the highest-signal,
 * lowest-footprint source in the system.
 */
export const MINING_FEEDS: Array<{ label: string; url: string; kind: 'hashtag' | 'company' | 'group' }> = [
  { label: 'HVAC contractors', url: 'https://www.linkedin.com/feed/hashtag/hvaccontractor/', kind: 'hashtag' },
  { label: 'Plumbing business', url: 'https://www.linkedin.com/feed/hashtag/plumbingbusiness/', kind: 'hashtag' },
  { label: 'Home service business', url: 'https://www.linkedin.com/feed/hashtag/homeservicebusiness/', kind: 'hashtag' },
  { label: 'Fleet graphics', url: 'https://www.linkedin.com/feed/hashtag/fleetgraphics/', kind: 'hashtag' },
  { label: 'Contractor marketing', url: 'https://www.linkedin.com/feed/hashtag/contractormarketing/', kind: 'hashtag' },
];

/** Search queries used to gap-fill the list. Kept few — search is capped hardest. */
export const SEARCH_QUERIES: string[] = [
  'HVAC owner',
  'plumbing company owner',
  'electrical contractor owner',
  'landscaping business owner',
  'roofing company owner',
];
