import { describe, it, expect } from 'vitest';
import {
  SNIPPET_LANGUAGES,
  buildSnippet,
  countEndpoints,
  endpointUrl,
  entityEndpoints,
  exampleBody,
  exampleQuery,
  projectEndpoints,
  pythonLiteral,
  type EndpointRow,
  type IpsEntity,
} from './endpoints';

/**
 * The behaviour of this module is proved in `packages/shared/src/endpoints.test.ts`,
 * where the code now lives. What remains here is the thing that suite CANNOT
 * cover: that the re-export barrel actually resolves across the package
 * boundary at runtime.
 *
 * That is a real failure mode rather than a theoretical one — `apps/web` has no
 * path mapping to `packages/shared/src`, so it resolves through the built
 * `dist`. A symbol dropped from either barrel, or a stale build, breaks the
 * Explore and Ready screens while every test in `shared` still passes.
 */
describe('endpoints barrel', () => {
  const student: IpsEntity = {
    name: 'Student',
    identity: { field: 'id', style: 'int' },
    fields: [
      { name: 'id', type: 'integer', required: false, meta: { identity: true } },
      { name: 'name', type: 'string', required: true },
    ],
  };

  it('re-exports every symbol its consumers import, and they work', () => {
    // snippet-tabs, apis/page and ready/page between them use all of these.
    expect(countEndpoints([student], ['GET'])).toBe(3);
    expect(projectEndpoints([student], [])).toHaveLength(1);
    expect(entityEndpoints(student, ['GET']).map((row) => row.path)).toEqual([
      '/student',
      '/student/{id}',
    ]);
    expect(exampleBody(student)).toEqual({ name: 'example name' });
    expect(exampleQuery({ sort: true })).toContain('sort=-id');
    expect(pythonLiteral(true)).toBe('True');
    expect(SNIPPET_LANGUAGES.map((entry) => entry.id)).toEqual(['curl', 'javascript', 'python']);

    const row: EndpointRow = {
      method: 'GET',
      path: '/student/{id}',
      summary: '',
      target: 'item',
    };
    const url = endpointUrl('https://api.dev/p/x', row, { entity: student });
    expect(url).toBe('https://api.dev/p/x/student/1');
    expect(buildSnippet({ language: 'curl', method: 'GET', url })).toContain(`--url '${url}'`);
  });
});
