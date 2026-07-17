import { describe, it, expect } from 'vitest';
import { createMemoryStorage } from './memory.js';
import { artifactKey, bundleKey, decodeBundle, encodeBundle, isBundleKey } from './keys.js';

describe('artifact keys', () => {
  it('lays out keys as projects/{id}/v{version}/{type}/{filename}', () => {
    expect(artifactKey('p1', 3, 'zod', 'customer.zod.ts')).toBe(
      'projects/p1/v3/zod/customer.zod.ts',
    );
  });

  it('bundle keys are recognizable', () => {
    const key = bundleKey('p1', 1, 'mock_data');
    expect(key).toBe('projects/p1/v1/mock_data/mock_data.bundle.json');
    expect(isBundleKey(key)).toBe(true);
    expect(isBundleKey(artifactKey('p1', 1, 'openapi', 'openapi.json'))).toBe(false);
  });

  it('bundles round-trip through encode/decode', () => {
    const files = { 'a.ts': 'export {}', 'b.json': '[]' };
    expect(decodeBundle(encodeBundle(files)).files).toEqual(files);
    expect(decodeBundle(new TextEncoder().encode(encodeBundle(files))).files).toEqual(files);
  });

  it('decodeBundle rejects malformed payloads', () => {
    expect(() => decodeBundle('{"nope":true}')).toThrow(/Malformed artifact bundle/);
  });
});

describe('memory storage', () => {
  it('puts, gets, and deletes objects with content types', async () => {
    const storage = createMemoryStorage();
    await storage.put('k1', 'hello', 'text/plain');
    await storage.put('k2', new TextEncoder().encode('bytes'), 'application/octet-stream');

    const k1 = await storage.get('k1');
    expect(new TextDecoder().decode(k1?.body)).toBe('hello');
    expect(k1?.contentType).toBe('text/plain');
    expect(storage.keys()).toEqual(['k1', 'k2']);

    await storage.delete('k1');
    expect(await storage.get('k1')).toBeNull();
    expect(storage.keys()).toEqual(['k2']);
  });
});
