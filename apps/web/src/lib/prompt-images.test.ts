import { describe, expect, it } from 'vitest';
import { MAX_PROMPT_IMAGES, acceptsFile, fitWithin, roomFor } from './prompt-images';

describe('fitWithin', () => {
  it('shrinks the long side to the limit and keeps the aspect ratio', () => {
    expect(fitWithin(4000, 3000, 1600)).toEqual({ width: 1600, height: 1200 });
    expect(fitWithin(1000, 3000, 1600)).toEqual({ width: 533, height: 1600 });
  });

  it('never enlarges a small image', () => {
    expect(fitWithin(800, 600, 1600)).toEqual({ width: 800, height: 600 });
  });
});

describe('acceptsFile', () => {
  it('takes PNG, JPEG and WebP only', () => {
    expect(acceptsFile({ type: 'image/png' })).toBe(true);
    expect(acceptsFile({ type: 'image/jpeg' })).toBe(true);
    expect(acceptsFile({ type: 'image/webp' })).toBe(true);
    // SVG can carry script, and HEIC cannot be drawn by most browsers.
    expect(acceptsFile({ type: 'image/svg+xml' })).toBe(false);
    expect(acceptsFile({ type: 'image/heic' })).toBe(false);
    expect(acceptsFile({ type: 'application/pdf' })).toBe(false);
  });
});

describe('roomFor', () => {
  it(`stops at ${MAX_PROMPT_IMAGES} images in total`, () => {
    expect(roomFor(0, 5)).toBe(MAX_PROMPT_IMAGES);
    expect(roomFor(2, 5)).toBe(1);
    expect(roomFor(3, 1)).toBe(0);
  });
});
