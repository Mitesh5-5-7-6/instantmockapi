import { describe, it, expect } from 'vitest';
import { newField } from './builder';
import {
  basePathToSlug,
  endpointPath,
  endpointsToEntities,
  entityNameFor,
  newEndpoint,
  previewPath,
  validateEndpoints,
  type SingleEndpoint,
} from './single-api';

function endpoint(name: string, overrides: Partial<SingleEndpoint> = {}): SingleEndpoint {
  return { ...newEndpoint(name), ...overrides };
}

describe('endpointPath / entityNameFor', () => {
  it('routes an endpoint at its lowercased name', () => {
    expect(endpointPath('Current')).toBe('current');
    expect(endpointPath('  Forecast  ')).toBe('forecast');
  });

  it('capitalises the entity name so generated types are PascalCase', () => {
    // The TypeScript generator takes this verbatim: `interface current` would
    // be the alternative.
    expect(entityNameFor('current')).toBe('Current');
    expect(entityNameFor('  cities ')).toBe('Cities');
  });

  it('leaves an already-capitalised name alone', () => {
    expect(entityNameFor('Forecast')).toBe('Forecast');
  });
});

describe('validateEndpoints', () => {
  it('accepts a well-formed set', () => {
    expect(validateEndpoints([endpoint('current'), endpoint('forecast')])).toEqual([]);
  });

  it('requires a name', () => {
    const issues = validateEndpoints([endpoint('')]);
    expect(issues[0]?.message).toContain('URL segment');
  });

  it('rejects a name that is not a usable URL segment', () => {
    expect(validateEndpoints([endpoint('my endpoint')])[0]?.message).toContain('letters, digits');
    expect(validateEndpoints([endpoint('2fast')])[0]?.message).toContain('starting with a letter');
  });

  it('catches two endpoints that collapse to the same route', () => {
    // The runtime indexes entities by path in a Map, so one would silently win
    // and the other 404 with nothing on screen to explain it.
    const issues = validateEndpoints([endpoint('Current'), endpoint('current')]);
    expect(issues).toHaveLength(2);
    expect(issues[0]?.message).toContain('/current');
    expect(issues[0]?.message).toContain('differing only in case');
  });

  it('does not report a collision for genuinely distinct names', () => {
    expect(validateEndpoints([endpoint('current'), endpoint('currentDay')])).toEqual([]);
  });

  it('does not report a collision between two unnamed endpoints', () => {
    // They already have their own "needs a name" issue; a phantom path clash
    // on the empty string would be noise.
    const issues = validateEndpoints([endpoint(''), endpoint('')]);
    expect(issues).toHaveLength(2);
    expect(issues.every((issue) => issue.message.includes('URL segment'))).toBe(true);
  });
});

describe('endpointsToEntities', () => {
  it('maps each endpoint to an entity with no relations', () => {
    const entities = endpointsToEntities([endpoint('current'), endpoint('forecast')]);
    expect(entities.map((entity) => entity.name)).toEqual(['Current', 'Forecast']);
    expect(entities.every((entity) => Array.isArray(entity.relations))).toBe(true);
    expect(entities[0]?.relations).toEqual([]);
  });

  it('carries the description through so it reaches the generated docs', () => {
    const entities = endpointsToEntities([
      endpoint('current', { description: '  Get current weather  ' }),
    ]);
    expect(entities[0]).toMatchObject({ description: 'Get current weather' });
  });

  it('omits the description key entirely when none was written', () => {
    // An empty string would show up as a blank tag description in the spec.
    expect(endpointsToEntities([endpoint('current')])[0]).not.toHaveProperty('description');
  });

  it('drops unnamed endpoints and unnamed fields', () => {
    // Neither can be routed or generated, and the API would reject the payload.
    const withBlank = endpoint('current', {
      fields: [newField('city'), newField(''), newField('temperature')],
    });
    const entities = endpointsToEntities([withBlank, endpoint('  ')]);
    expect(entities).toHaveLength(1);
    expect((entities[0]?.fields as { name: string }[]).map((field) => field.name)).toEqual([
      'city',
      'temperature',
    ]);
  });

  it('serializes fields through the shared IPS mapper', () => {
    const typed = endpoint('current', {
      fields: [{ ...newField('temperature', 'integer'), default: '18' }],
    });
    expect((endpointsToEntities([typed])[0]?.fields as Record<string, unknown>[])[0]).toMatchObject(
      {
        name: 'temperature',
        type: 'integer',
        default: 18,
      },
    );
  });
});

describe('basePathToSlug', () => {
  it('accepts what someone would type into a Base Path field', () => {
    expect(basePathToSlug('/weather')).toBe('weather');
    expect(basePathToSlug('weather')).toBe('weather');
    expect(basePathToSlug('  /Weather/  ')).toBe('weather');
  });

  it('collapses a nested path rather than truncating it', () => {
    // The slug is a single segment; silently keeping only `api` would address a
    // different API than the one that was typed.
    expect(basePathToSlug('/api/weather')).toBe('api-weather');
  });

  it('normalises spaces and punctuation to hyphens', () => {
    expect(basePathToSlug('My Weather API')).toBe('my-weather-api');
    expect(basePathToSlug('weather__v2')).toBe('weather-v2');
  });

  it('returns empty when nothing usable survives, so the server derives one', () => {
    expect(basePathToSlug('')).toBe('');
    expect(basePathToSlug('///')).toBe('');
    expect(basePathToSlug('!!!')).toBe('');
  });

  it('never ends in a hyphen, which the slug pattern rejects', () => {
    expect(basePathToSlug('weather-')).toBe('weather');
    expect(basePathToSlug('a'.repeat(59) + ' tail')).not.toMatch(/-$/);
  });

  it('stays inside the slug length limit', () => {
    expect(basePathToSlug('x'.repeat(200)).length).toBeLessThanOrEqual(60);
  });
});

describe('previewPath', () => {
  it('shows the hosted shape the endpoint will answer on', () => {
    expect(previewPath('/weather', 'current')).toBe('/p/{publicId}/weather/current');
  });

  it('falls back to placeholders before either value is chosen', () => {
    expect(previewPath('', '')).toBe('/p/{publicId}/{slug}/{endpoint}');
  });
});
