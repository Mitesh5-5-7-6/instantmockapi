/**
 * Export bundle generator (Worker G, doc 09 §4).
 *
 * Pure in-memory ZIP of whatever artifacts were produced, plus a README
 * noting the IPS version. The orchestrator supplies the file map (it fetches
 * artifact contents from storage); this package never performs I/O.
 */

import JSZip from 'jszip';
import type { InternalProjectSchema } from '@instantmockapi/ips';

/** Fixed timestamp for all zip entries so identical inputs → identical bytes. */
const ZIP_EPOCH = new Date('2020-01-01T00:00:00.000Z');

/**
 * README.md content for the bundle. `includedArtifacts` lists the artifact
 * types actually present (G bundles what exists, doc 10 §4).
 */
export function generateExportReadme(
  ips: InternalProjectSchema,
  includedArtifacts: string[],
): string {
  const lines = [
    '# InstantMockAPI Export',
    '',
    `- Project: ${ips.projectId}`,
    `- IPS version: ${ips.version}`,
    `- Entities: ${ips.entities.map((e) => e.name).join(', ') || '(none)'}`,
    '',
    '## Included artifacts',
    '',
    ...(includedArtifacts.length > 0
      ? includedArtifacts.map((artifact) => `- ${artifact}`)
      : ['- (none — no artifacts had completed when this bundle was created)']),
    '',
    'All artifacts were generated from the same IPS snapshot, so they are',
    'consistent with each other and with the hosted mock API for this version.',
    '',
  ];
  return lines.join('\n');
}

/**
 * Bundle files into a ZIP. Keys are archive paths (e.g. `zod/blogpost.zod.ts`);
 * a README.md derived from the IPS is always included at the root.
 */
export async function generateExportZip(
  ips: InternalProjectSchema,
  files: Record<string, string | Uint8Array>,
  includedArtifacts: string[],
): Promise<Uint8Array> {
  const zip = new JSZip();

  zip.file('README.md', generateExportReadme(ips, includedArtifacts), { date: ZIP_EPOCH });
  for (const path of Object.keys(files).sort()) {
    zip.file(path, files[path] ?? '', { date: ZIP_EPOCH });
  }

  return zip.generateAsync({
    type: 'uint8array',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
}
