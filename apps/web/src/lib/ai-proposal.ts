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

/**
 * TanStack `refetchInterval`: quick at first, gentler once a generation is clearly slow.
 * Measured from `updatedAt`, not `createdAt`, so a retried proposal starts fast again.
 */
export function pollInterval(
  view: { status: string; updatedAt: string; translation?: { status: string } | null } | undefined,
  now: number = Date.now(),
): number | false {
  if (!view) return false;
  // A ready proposal is still "moving" while its prose is being translated.
  const translating = view.translation?.status === 'pending';
  if (isSettled(view.status) && !translating) return false;
  return now - Date.parse(view.updatedAt) < FAST_WINDOW_MS ? FAST_POLL_MS : SLOW_POLL_MS;
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
  { code: 'auto', label: 'Same as my prompt' },
  { code: 'en', label: 'English' },
  { code: 'hi', label: 'हिन्दी (Hindi)' },
  { code: 'gu', label: 'ગુજરાતી (Gujarati)' },
  { code: 'es', label: 'Español' },
  { code: 'fr', label: 'Français' },
  { code: 'de', label: 'Deutsch' },
] as const;

/**
 * The review page's "Explain the result in" choices. The proposal can already be
 * in a language the list lacks (auto-detected `mr`, or `en-US`); it is offered
 * first as itself so the select shows the truth and every listed language is a
 * real change, never a no-op that only looks selected.
 */
export function languageOptions(current: string): { code: string; label: string }[] {
  const listed = RESPONSE_LANGUAGES.filter((option) => option.code !== 'auto').map(
    ({ code, label }) => ({ code, label }),
  );
  return listed.some((option) => option.code === current)
    ? listed
    : [{ code: current, label: `${current} (current)` }, ...listed];
}

/** `auto` sends no language, so the server answers in the language of the prompt. */
export function defaultResponseLanguage(): string {
  return 'auto';
}

/** The value for the API's `responseLanguage`: nothing when the user left it on `auto`. */
export function responseLanguageFor(selection: string): string | undefined {
  return selection === 'auto' ? undefined : selection;
}

/** Examples for the chips: the English ones, plus one from every other language when on `auto`. */
export function examplesFor(selection: string): string[] {
  if (selection !== 'auto') {
    return EXAMPLE_PROMPTS[selection] ?? EXAMPLE_PROMPTS['en'] ?? [];
  }
  return Object.entries(EXAMPLE_PROMPTS).flatMap(([code, list]) =>
    code === 'en' ? list : list.slice(0, 1),
  );
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

/**
 * Query options for the review page's proposal. The page initialises its form only from a
 * fetch made after it mounted (a cached view can predate the saved draft), so the mount
 * fetch must happen even when the cache is fresh — and it always is when /new/ai has just
 * replaced to the page, inside the app-wide staleTime.
 */
export const REVIEW_PROPOSAL_QUERY = { refetchOnMount: 'always' } as const;
