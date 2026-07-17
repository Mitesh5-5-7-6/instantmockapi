/**
 * Canonical storage-key layout for generated artifacts.
 *
 * One stored object per artifact record: single-file artifacts (openapi,
 * postman, hosted_api, export_zip) store the file itself; multi-file
 * artifacts (json_schema, zod, yup, typescript, mock_data) store a JSON
 * bundle `{ "files": { "<filename>": "<content>" } }`.
 */

const BUNDLE_SUFFIX = '.bundle.json';

export function artifactKey(
  projectId: string,
  version: number,
  artifactType: string,
  filename: string,
): string {
  return `projects/${projectId}/v${version}/${artifactType}/${filename}`;
}

export function bundleKey(projectId: string, version: number, artifactType: string): string {
  return artifactKey(projectId, version, artifactType, `${artifactType}${BUNDLE_SUFFIX}`);
}

export function isBundleKey(key: string): boolean {
  return key.endsWith(BUNDLE_SUFFIX);
}

export interface ArtifactBundle {
  files: Record<string, string>;
}

export function encodeBundle(files: Record<string, string>): string {
  return JSON.stringify({ files } satisfies ArtifactBundle, null, 2);
}

export function decodeBundle(body: Uint8Array | string): ArtifactBundle {
  const text = typeof body === 'string' ? body : new TextDecoder().decode(body);
  const parsed = JSON.parse(text) as Partial<ArtifactBundle>;
  if (!parsed.files || typeof parsed.files !== 'object') {
    throw new Error('Malformed artifact bundle: missing files map');
  }
  return { files: parsed.files };
}
