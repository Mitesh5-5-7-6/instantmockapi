import { describe, it, expect } from 'vitest';
import { goldenFixtureIPS } from '../../__tests__/golden-fixture.js';
import { generateHostingConfig } from './hosting.js';

describe('generateHostingConfig (Worker F)', () => {
  const output = generateHostingConfig(goldenFixtureIPS);
  const config = JSON.parse(output['hosting.config.json'] ?? '{}');

  it('emits a single hosting.config.json file', () => {
    expect(Object.keys(output)).toEqual(['hosting.config.json']);
  });

  it('stamps project id and IPS version', () => {
    expect(config.projectId).toBe('proj_golden');
    expect(config.version).toBe(1);
  });

  it('routes each entity at its lowercased path with only the selected methods', () => {
    expect(config.entities).toHaveLength(1);
    const entity = config.entities[0];
    expect(entity.name).toBe('BlogPost');
    expect(entity.path).toBe('blogpost');
    // Fixture selects GET, POST, PUT, DELETE — not PATCH
    expect(entity.methods).toEqual(['GET', 'POST', 'PUT', 'DELETE']);
  });

  it('carries the full IPS validation model for the safe interpreter', () => {
    const fields = config.entities[0].fields;
    const title = fields.find((f: { name: string }) => f.name === 'title');
    expect(title.validation).toEqual({ min: 5, max: 200, message: 'Title must be 5-200 chars' });
    expect(title.required).toBe(true);

    const status = fields.find((f: { name: string }) => f.name === 'status');
    expect(status.validation.enum).toEqual(['draft', 'published', 'archived']);

    // Nested children preserved recursively
    const metadata = fields.find((f: { name: string }) => f.name === 'metadata');
    const keywords = metadata.children.find((f: { name: string }) => f.name === 'keywords');
    expect(keywords.type).toBe('array');
    expect(keywords.children[0].name).toBe('keyword');
  });

  it('references the mockStores seed store per entity', () => {
    expect(config.entities[0].seedStore).toEqual({ collection: 'mockStores', entity: 'blogpost' });
  });

  it('emits no methods when none are selected (mock runtime answers 405)', () => {
    const none = generateHostingConfig({
      ...goldenFixtureIPS,
      generationConfig: { ...goldenFixtureIPS.generationConfig, methods: [] },
    });
    const emptyConfig = JSON.parse(none['hosting.config.json'] ?? '{}');
    expect(emptyConfig.entities[0].methods).toEqual([]);
  });

  it('is deterministic', () => {
    expect(generateHostingConfig(goldenFixtureIPS)).toEqual(output);
  });
});
