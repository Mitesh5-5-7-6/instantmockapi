/**
 * Images attached to a prompt: a whiteboard sketch, a hand-drawn ER diagram, a
 * screenshot of a form or a table. They go to the model beside the text.
 *
 * The browser shrinks each one before upload (long side ≤ 1600 px), so the
 * byte limit here is a backstop against a client that skipped that step, not
 * the expected size.
 */

export const PROMPT_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export type PromptImageType = (typeof PROMPT_IMAGE_TYPES)[number];

export interface PromptImage {
  mimeType: PromptImageType;
  /** Base64, no `data:` prefix. */
  data: string;
}

export const MAX_IMAGES = 3;
/** Per image, decoded. */
export const MAX_IMAGE_BYTES = 1_500_000;

export type ImageCheck =
  { ok: true; images: PromptImage[] } | { ok: false; path: string; issue: string };

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** Does the file start with the signature of the type it claims? */
function signatureMatches(type: string, bytes: Buffer): boolean {
  switch (type) {
    case 'image/png':
      return bytes
        .subarray(0, 8)
        .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case 'image/jpeg':
      return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    case 'image/webp':
      return (
        bytes.subarray(0, 4).toString('latin1') === 'RIFF' &&
        bytes.subarray(8, 12).toString('latin1') === 'WEBP'
      );
    default:
      return false;
  }
}

/**
 * Validate images from a request. The declared type is the client's word; the
 * file's own signature decides, so an SVG (which can carry script) or anything
 * else renamed to `.png` is refused.
 */
export function checkPromptImages(
  images: readonly { mimeType: string; data: string }[],
): ImageCheck {
  if (images.length > MAX_IMAGES) {
    return { ok: false, path: 'images', issue: `at most ${MAX_IMAGES} images` };
  }
  for (const [index, image] of images.entries()) {
    const path = `images[${index}]`;
    if (!BASE64.test(image.data)) {
      return { ok: false, path, issue: 'is not base64 data' };
    }
    const bytes = Buffer.from(image.data, 'base64');
    if (bytes.length > MAX_IMAGE_BYTES) {
      return {
        ok: false,
        path,
        issue: `is too large (${Math.ceil(bytes.length / 1000)} KB; the limit is ${MAX_IMAGE_BYTES / 1000} KB)`,
      };
    }
    if (!signatureMatches(image.mimeType, bytes)) {
      return { ok: false, path, issue: 'is not a PNG, JPEG or WebP image' };
    }
  }
  return { ok: true, images: images as PromptImage[] };
}
