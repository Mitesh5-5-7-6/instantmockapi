/**
 * Photos and screenshots attached to an AI prompt.
 *
 * Every image is redrawn in the browser before upload: the long side is cut to
 * `MAX_SIDE` and the result is a JPEG. A phone photo of a whiteboard drops from
 * several megabytes to a few hundred kilobytes, which keeps the upload quick
 * and the model request small, while text on a sketch or screenshot stays
 * legible at that size. Redrawing also drops the file's metadata, such as the
 * location a phone photo carries.
 */

/** Matches the server's `MAX_IMAGES`. */
export const MAX_PROMPT_IMAGES = 3;
const MAX_SIDE = 1600;
const QUALITY = 0.85;
const ACCEPTED = ['image/png', 'image/jpeg', 'image/webp'];

/** For the file input's `accept` attribute. */
export const PROMPT_IMAGE_ACCEPT = ACCEPTED.join(',');

export interface PromptImageUpload {
  mimeType: 'image/jpeg';
  /** Base64 without the `data:` prefix: what the API takes. */
  data: string;
  /** A `data:` URL for the thumbnail. */
  previewUrl: string;
  name: string;
}

export function acceptsFile(file: { type: string }): boolean {
  return ACCEPTED.includes(file.type);
}

/** How many of `incoming` files still fit beside `current` attached ones. */
export function roomFor(current: number, incoming: number): number {
  return Math.max(0, Math.min(incoming, MAX_PROMPT_IMAGES - current));
}

/** Scale down to fit `max` on the long side; never scale up. */
export function fitWithin(
  width: number,
  height: number,
  max: number,
): { width: number; height: number } {
  const scale = Math.min(1, max / Math.max(width, height));
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

/** Redraw an image file at upload size. Browser only. */
export async function shrinkImage(file: File): Promise<PromptImageUpload> {
  const bitmap = await createImageBitmap(file);
  try {
    const size = fitWithin(bitmap.width, bitmap.height, MAX_SIDE);
    const canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext('2d');
    if (!context) {
      throw new Error('This browser cannot prepare the image.');
    }
    // JPEG has no transparency: a transparent PNG screenshot would turn black.
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, size.width, size.height);
    context.drawImage(bitmap, 0, 0, size.width, size.height);
    const previewUrl = canvas.toDataURL('image/jpeg', QUALITY);
    return {
      mimeType: 'image/jpeg',
      data: previewUrl.slice(previewUrl.indexOf(',') + 1),
      previewUrl,
      name: file.name,
    };
  } finally {
    bitmap.close();
  }
}
