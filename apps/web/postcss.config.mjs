/**
 * Tailwind v4 runs as a PostCSS plugin, which Next picks up automatically.
 *
 * v4 rather than v3 deliberately: it is configured from CSS with `@theme`, so
 * the palette this product already designed stays in one file next to the
 * `.ui-*` rules it shares a stylesheet with, instead of being duplicated into a
 * `tailwind.config.js` that then has to be kept in step.
 */
const config = {
  plugins: {
    '@tailwindcss/postcss': {},
  },
};

export default config;
