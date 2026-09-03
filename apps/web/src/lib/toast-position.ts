/**
 * Where notifications appear, as a per-person preference.
 *
 * One position for the whole application, changeable in Settings — the thing
 * this replaces is a product where each screen invented its own placement, so
 * the value of the setting is entirely in it being global.
 *
 * `bottom-right` is the default because it is where developer tooling has put
 * this for years, and because it is the corner least likely to cover what
 * someone is reading: page content starts top-left, and the primary action of a
 * form is usually the last thing above the fold rather than the last thing on
 * the right.
 */

export const TOAST_POSITIONS = [
  'top-left',
  'top-center',
  'top-right',
  'bottom-left',
  'bottom-center',
  'bottom-right',
] as const;

export type ToastPosition = (typeof TOAST_POSITIONS)[number];

export const DEFAULT_TOAST_POSITION: ToastPosition = 'bottom-right';

export const TOAST_POSITION_KEY = 'instantmockapi.toastPosition';

/**
 * Event fired after the preference is written, for the viewport to follow.
 *
 * A tab does not receive its own `storage` events, so without this, changing the
 * position in Settings would appear to do nothing until a reload. Named here
 * beside the key so the writer and the listener cannot disagree on the string —
 * the usual way a custom-event channel silently stops working.
 */
export const TOAST_POSITION_CHANGED = 'instantmockapi:toast-position-changed';

/** Human labels, in the reading order the settings control uses. */
export const TOAST_POSITION_LABELS: Record<ToastPosition, string> = {
  'top-left': 'Top left',
  'top-center': 'Top centre',
  'top-right': 'Top right',
  'bottom-left': 'Bottom left',
  'bottom-center': 'Bottom centre',
  'bottom-right': 'Bottom right',
};

export function isToastPosition(value: unknown): value is ToastPosition {
  return typeof value === 'string' && (TOAST_POSITIONS as readonly string[]).includes(value);
}

/**
 * Read a stored value into a position.
 *
 * Anything unrecognised falls back to the default rather than throwing. The
 * stored string comes from `localStorage`, which is editable by hand, shared
 * across app versions, and may hold a value a previous release wrote — none of
 * which should be able to stop notifications rendering at all.
 */
export function parseToastPosition(stored: unknown): ToastPosition {
  return isToastPosition(stored) ? stored : DEFAULT_TOAST_POSITION;
}

/**
 * Read the preference from storage.
 *
 * Wrapped because `localStorage` throws, not merely returns null, in a Safari
 * private window and wherever site data is blocked — and a notification system
 * that crashes the page when it cannot read a cosmetic preference is worse than
 * one that ignores it.
 */
export function readToastPosition(): ToastPosition {
  try {
    return parseToastPosition(window.localStorage.getItem(TOAST_POSITION_KEY));
  } catch {
    return DEFAULT_TOAST_POSITION;
  }
}

export function writeToastPosition(position: ToastPosition): void {
  try {
    window.localStorage.setItem(TOAST_POSITION_KEY, position);
  } catch {
    // Preference not persisted; the session still honours the choice in memory.
  }
  // Announced even if the write failed, so the choice takes effect immediately
  // either way. A setting that only applies after a reload reads as broken.
  try {
    window.dispatchEvent(new Event(TOAST_POSITION_CHANGED));
  } catch {
    // No window (a server render); nothing is listening yet in that case.
  }
}

/**
 * Whether a position stacks upward.
 *
 * A bottom-anchored column has to grow away from the edge, so the newest toast
 * sits nearest the corner the eye is already on. Rendering the same DOM order at
 * both ends would put the newest message furthest from the anchor at the bottom.
 */
export function stacksUpward(position: ToastPosition): boolean {
  return position.startsWith('bottom');
}
