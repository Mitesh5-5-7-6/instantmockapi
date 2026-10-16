/**
 * The InstantMockAPI emblem, as an image. One component so every lockup (the
 * sidebar, the sign-in card, the demo) uses the same file at the same shape.
 *
 * The file is a cropped export of the source artwork, kept in `public/brand`.
 * `alt` is empty: the wordmark beside it already names the product, and a
 * screen reader would otherwise say the name twice.
 */
export function BrandMark({ size = 32 }: { size?: number }) {
  return (
    <img
      className="ui-brand-mark"
      src={size > 48 ? '/brand/logo-256.png' : '/brand/logo-64.png'}
      alt=""
      width={size}
      height={size}
    />
  );
}
