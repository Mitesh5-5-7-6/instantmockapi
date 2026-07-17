import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { goldenFixtureIPS } from '../../__tests__/golden-fixture.js';
import { generateExportReadme, generateExportZip } from './export.js';

const files = {
  'zod/blogpost.zod.ts': 'export const BlogPostSchema = {};',
  'typescript/blogpost.types.ts': 'export interface BlogPost {}',
  'mock_data/blogpost.mock.json': '[{"id":"1"}]',
};
const included = ['zod', 'typescript', 'mock_data'];

describe('generateExportReadme (Worker G)', () => {
  it('notes project, IPS version, entities, and included artifacts', () => {
    const readme = generateExportReadme(goldenFixtureIPS, included);
    expect(readme).toContain('Project: proj_golden');
    expect(readme).toContain('IPS version: 1');
    expect(readme).toContain('Entities: BlogPost');
    expect(readme).toContain('- zod');
    expect(readme).toContain('- mock_data');
  });

  it('handles an empty bundle honestly', () => {
    const readme = generateExportReadme(goldenFixtureIPS, []);
    expect(readme).toContain('none — no artifacts had completed');
  });
});

describe('generateExportZip (Worker G)', () => {
  it('bundles all files plus README.md and round-trips through a zip reader', async () => {
    const bytes = await generateExportZip(goldenFixtureIPS, files, included);
    const zip = await JSZip.loadAsync(bytes);

    const paths = Object.values(zip.files)
      .filter((entry) => !entry.dir)
      .map((entry) => entry.name)
      .sort();
    expect(paths).toEqual([
      'README.md',
      'mock_data/blogpost.mock.json',
      'typescript/blogpost.types.ts',
      'zod/blogpost.zod.ts',
    ]);

    const readme = await zip.file('README.md')?.async('string');
    expect(readme).toContain('IPS version: 1');

    const zod = await zip.file('zod/blogpost.zod.ts')?.async('string');
    expect(zod).toBe(files['zod/blogpost.zod.ts']);
  });

  it('is byte-deterministic for identical inputs', async () => {
    const a = await generateExportZip(goldenFixtureIPS, files, included);
    const b = await generateExportZip(goldenFixtureIPS, files, included);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it('produces a README-only zip when nothing was generated', async () => {
    const bytes = await generateExportZip(goldenFixtureIPS, {}, []);
    const zip = await JSZip.loadAsync(bytes);
    expect(Object.keys(zip.files)).toEqual(['README.md']);
  });
});
