/**
 * Avatar URLs for the `avatar` field type.
 *
 * Generated mock data for an avatar field is a **getavataaars.com URL**, not a
 * component and not a package dependency. The reason is what consumes it: a
 * hosted mock API answers JSON to an Angular app, a curl, a Postman run and a
 * React app alike, and only a URL is a value all four can render. Shipping the
 * `avataaars` React component instead would make the data useless to three of
 * them, and would put a rendering library in the dependency tree of a JSON
 * generator.
 *
 * ## Why the trait lists are short
 *
 * Avataaars exposes far more options than these. A generator that drew from all
 * of them produces faces that read as noise — horns beside business suits — and
 * makes two records of the same entity look like they came from different
 * products. These lists are the subset that stays coherent when combined at
 * random, which is what a seeded fixture set needs.
 *
 * `mouthType` is the deliberate exception: **fixed to `Tongue`**, chosen by the
 * user as the house style, so every avatar this platform emits is recognisably
 * from the same set however the other traits fall.
 */

/** Trait values drawn at random, one list per avataaars parameter. */
export const AVATAR_TRAITS = {
  topType: [
    'ShortHairShortFlat',
    'ShortHairShortCurly',
    'ShortHairDreads01',
    'ShortHairTheCaesar',
    'LongHairStraight',
    'LongHairBob',
    'LongHairCurly',
    'LongHairDreads',
    'LongHairMiaWallace',
    'Hat',
    'WinterHat1',
  ],
  accessoriesType: [
    'Blank',
    'Blank',
    'Blank',
    'Prescription01',
    'Prescription02',
    'Round',
    'Wayfarers',
  ],
  hairColor: ['Auburn', 'Black', 'Blonde', 'Brown', 'BrownDark', 'PastelPink', 'Platinum', 'Red'],
  facialHairType: ['Blank', 'Blank', 'Blank', 'BeardLight', 'BeardMedium', 'MoustacheFancy'],
  clotheType: [
    'BlazerShirt',
    'BlazerSweater',
    'CollarSweater',
    'GraphicShirt',
    'Hoodie',
    'Overall',
    'ShirtCrewNeck',
    'ShirtVNeck',
  ],
  clotheColor: [
    'Black',
    'Blue01',
    'Blue02',
    'Gray01',
    'Heather',
    'PastelBlue',
    'PastelGreen',
    'PastelOrange',
    'Pink',
    'Red',
    'White',
  ],
  eyeType: ['Default', 'Happy', 'Hearts', 'Side', 'Squint', 'Wink'],
  eyebrowType: ['Default', 'DefaultNatural', 'FlatNatural', 'RaisedExcited', 'UpDown'],
  skinColor: ['Tanned', 'Yellow', 'Pale', 'Light', 'Brown', 'DarkBrown', 'Black'],
} as const;

export type AvatarTrait = keyof typeof AVATAR_TRAITS;

/** Trait names in the order the URL lists them — alphabetical, as the site emits. */
export const AVATAR_TRAIT_NAMES = Object.keys(AVATAR_TRAITS).sort() as AvatarTrait[];

/**
 * Traits every avatar carries regardless of the draw.
 *
 * `Circle` because an avatar is rendered in a round frame almost everywhere it
 * appears, and `Transparent` would show the page behind it. `Tongue` is the
 * house style described above.
 */
export const AVATAR_FIXED = {
  avatarStyle: 'Circle',
  mouthType: 'Tongue',
} as const;

export const AVATAR_BASE_URL = 'https://getavataaars.com/';

/**
 * Build the URL for a set of traits.
 *
 * Parameters are emitted in sorted order so the same traits always produce a
 * byte-identical URL — a seeded fixture set has to be diffable, and a query
 * string whose key order wanders defeats that.
 */
export function avatarUrl(traits: Partial<Record<AvatarTrait, string>> = {}): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries({ ...AVATAR_FIXED, ...traits }).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    params.set(key, value);
  }
  return `${AVATAR_BASE_URL}?${params.toString()}`;
}

/**
 * A stable avatar, for documentation examples and empty states.
 *
 * Exactly the combination the user supplied when asking for this type, so the
 * OpenAPI example and the screenshot they were looking at agree.
 */
export const EXAMPLE_AVATAR_URL = avatarUrl({
  topType: 'LongHairDreads',
  accessoriesType: 'Wayfarers',
  hairColor: 'PastelPink',
  facialHairType: 'Blank',
  clotheType: 'ShirtVNeck',
  clotheColor: 'PastelOrange',
  eyeType: 'Hearts',
  eyebrowType: 'FlatNatural',
  skinColor: 'Light',
});

/** True for a URL this module could have produced. Used by the runtime's validator. */
export function isAvatarUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}
