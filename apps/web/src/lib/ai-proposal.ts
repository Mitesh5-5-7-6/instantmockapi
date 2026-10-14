/**
 * Pure helpers for the AI builder page — kept out of the component so they are
 * testable without React (see vitest.config.ts).
 */

const FAST_POLL_MS = 2_000;
const SLOW_POLL_MS = 5_000;
const FAST_WINDOW_MS = 30_000;

export function isSettled(status: string): boolean {
  return status !== 'generating' && status !== 'committing';
}

/** TanStack `refetchInterval`: quick at first, gentler once a generation is clearly slow. */
export function pollInterval(
  view: { status: string; createdAt: string } | undefined,
  now: number = Date.now(),
): number | false {
  if (!view || isSettled(view.status)) {
    return false;
  }
  return now - Date.parse(view.createdAt) < FAST_WINDOW_MS ? FAST_POLL_MS : SLOW_POLL_MS;
}

const STAGE_LABELS: Record<string, string> = {
  queued: 'Waiting in the queue…',
  generating: 'Designing your schema…',
  repairing: 'Fixing a few problems the validator found…',
  validating: 'Checking it against the platform rules…',
};

export function stageLabel(stage: string | null): string {
  return (stage && STAGE_LABELS[stage]) || 'Working…';
}

/** Languages the explanations can be written in. Identifiers are always English. */
export const RESPONSE_LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'hi', label: 'हिन्दी (Hindi)' },
  { code: 'gu', label: 'ગુજરાતી (Gujarati)' },
  { code: 'es', label: 'Español' },
  { code: 'fr', label: 'Français' },
  { code: 'de', label: 'Deutsch' },
] as const;

export function defaultResponseLanguage(browserLanguage: string | undefined): string {
  const primary = (browserLanguage ?? '').split('-')[0]?.toLowerCase() ?? '';
  return RESPONSE_LANGUAGES.some((language) => language.code === primary) ? primary : 'en';
}

/**
 * Starter prompts shown as clickable chips. UI copy, not domain logic: nothing
 * reads them, and the user can type anything at all.
 */
export const EXAMPLE_PROMPTS: Record<string, string[]> = {
  en: [
    'Create a gym membership API with members, trainers, plans and class bookings.',
    'Build a simple weather API returning temperature, humidity, location and forecast.',
  ],
  hi: ['उत्पादों और ऑर्डर के लिए एक API बनाएं।'],
  gu: ['મારે hospital management API જોઈએ જેમાં patients, doctors અને appointments હોય.'],
  es: ['Crea una API para gestionar productos y pedidos.'],
  fr: ['Créez une API de commerce électronique avec des produits et des commandes.'],
  de: ['Erstelle eine API für eine Krankenhausverwaltung.'],
};
