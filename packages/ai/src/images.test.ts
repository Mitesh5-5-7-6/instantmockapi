import { describe, expect, it } from 'vitest';
import { MAX_IMAGE_BYTES, MAX_IMAGES, checkPromptImages } from './images.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const WEBP = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.from([0, 0, 0, 0]),
  Buffer.from('WEBPVP8 '),
]);
const b64 = (bytes: Buffer) => bytes.toString('base64');

describe('checkPromptImages', () => {
  it('accepts PNG, JPEG and WebP whose bytes match their declared type', () => {
    const images = [
      { mimeType: 'image/png', data: b64(PNG) },
      { mimeType: 'image/jpeg', data: b64(JPEG) },
      { mimeType: 'image/webp', data: b64(WEBP) },
    ];
    expect(checkPromptImages(images)).toEqual({ ok: true, images });
  });

  it('rejects a file whose bytes are not the type it claims', () => {
    // The declared type is the client's word; the bytes decide.
    const result = checkPromptImages([{ mimeType: 'image/png', data: b64(JPEG) }]);
    expect(result).toEqual({
      ok: false,
      path: 'images[0]',
      issue: 'is not a PNG, JPEG or WebP image',
    });
  });

  it('rejects other types, including SVG', () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>');
    expect(checkPromptImages([{ mimeType: 'image/svg+xml', data: b64(svg) }]).ok).toBe(false);
  });

  it('rejects data that is not base64', () => {
    expect(checkPromptImages([{ mimeType: 'image/png', data: 'not base64!!' }]).ok).toBe(false);
  });

  it(`rejects an image over ${MAX_IMAGE_BYTES} bytes`, () => {
    const big = Buffer.concat([PNG, Buffer.alloc(MAX_IMAGE_BYTES)]);
    expect(checkPromptImages([{ mimeType: 'image/png', data: b64(big) }])).toMatchObject({
      ok: false,
      issue: expect.stringMatching(/too large/),
    });
  });

  it(`rejects more than ${MAX_IMAGES} images`, () => {
    const many = Array.from({ length: MAX_IMAGES + 1 }, () => ({
      mimeType: 'image/png',
      data: b64(PNG),
    }));
    expect(checkPromptImages(many)).toMatchObject({ ok: false, path: 'images' });
  });
});
