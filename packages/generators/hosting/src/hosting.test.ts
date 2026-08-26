import { describe, it, expect } from 'vitest';
import {
  ALL_QUERY_FEATURES,
  NO_QUERY_FEATURES,
  materializeRelations,
  type QueryFeatures,
} from '@instantmockapi/ips';
import { goldenFixtureIPS } from '../../__tests__/golden-fixture.js';
import { goldenRelationsIPS } from '../../../ips/__tests__/golden-relations-fixture.js';
import { generateHostingConfig, type HostedEntityConfig, type HostingConfig } from './hosting.js';

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

  it('defaults identity and emits no relations for a pre-relations IPS', () => {
    expect(config.entities[0].identity).toEqual({ field: 'id', style: 'uuid' });
    expect(config.entities[0].relations).toEqual([]);
  });
});

describe('generateHostingConfig — relations (doc 19 §Phase A)', () => {
  const materialized = materializeRelations(goldenRelationsIPS);
  const config = JSON.parse(
    generateHostingConfig(materialized)['hosting.config.json'] ?? '{}',
  ) as HostingConfig;

  const byName = (name: string): HostedEntityConfig =>
    config.entities.find((entity) => entity.name === name)!;

  it('carries each entity identity descriptor', () => {
    expect(byName('Classroom').identity).toEqual({ field: 'id', style: 'int' });
    expect(byName('Course').identity).toEqual({ field: 'id', style: 'uuid' });
  });

  it('preserves field meta so the runtime can see identity and reference markers', () => {
    // fieldRule used to drop meta entirely — this is the regression guard.
    const student = byName('Student');
    expect(student.fields.find((f) => f.name === 'id')!.meta).toMatchObject({
      identity: true,
      readOnly: true,
    });
    expect(student.fields.find((f) => f.name === 'classroomId')!.meta).toMatchObject({
      reference: true,
      relation: 'Classroom',
    });
  });

  it('emits a resolved relation rule per relation, with the target path precomputed', () => {
    const student = byName('Student');
    expect(student.relations).toEqual([
      {
        name: 'classroom',
        kind: 'belongsTo',
        target: 'Classroom',
        targetPath: 'classroom',
        localField: 'classroomId',
        foreignField: 'id',
        collection: false,
        onDelete: 'restrict',
      },
      {
        name: 'courses',
        kind: 'manyToMany',
        target: 'Course',
        targetPath: 'course',
        localField: 'courseIds',
        foreignField: 'id',
        collection: true,
        onDelete: 'setNull',
      },
    ]);
  });

  it('marks the inverse side as a collection reading the FK on the target', () => {
    expect(byName('Classroom').relations).toEqual([
      {
        name: 'students',
        kind: 'hasMany',
        target: 'Student',
        targetPath: 'student',
        localField: 'id',
        foreignField: 'classroomId',
        collection: true,
        onDelete: 'restrict',
      },
    ]);
  });

  it('completes sparsely-authored relations without prior materialization', () => {
    // A hand-authored pack must be hostable directly.
    const raw = JSON.parse(
      generateHostingConfig(goldenRelationsIPS)['hosting.config.json'] ?? '{}',
    ) as HostingConfig;
    const student = raw.entities.find((entity) => entity.name === 'Student')!;
    expect(student.relations[0]).toMatchObject({
      localField: 'classroomId',
      foreignField: 'id',
    });
  });

  it('drops relations whose target is not a declared entity', () => {
    const dangling = JSON.parse(
      generateHostingConfig({
        ...goldenRelationsIPS,
        entities: [
          {
            ...goldenRelationsIPS.entities[2]!,
            relations: [
              {
                name: 'ghost',
                kind: 'belongsTo',
                target: 'Ghost',
                localField: '',
                foreignField: '',
                required: false,
                onDelete: 'restrict',
              },
            ],
          },
        ],
      })['hosting.config.json'] ?? '{}',
    ) as HostingConfig;
    expect(dangling.entities[0]!.relations).toEqual([]);
  });

  it('is deterministic', () => {
    expect(generateHostingConfig(materialized)).toEqual(generateHostingConfig(materialized));
  });
});

describe('generateHostingConfig — query layer (doc 19 §Phase 4)', () => {
  const withFeatures = (features: Partial<QueryFeatures>): HostingConfig =>
    JSON.parse(
      generateHostingConfig({
        ...materializeRelations(goldenRelationsIPS),
        generationConfig: {
          ...goldenRelationsIPS.generationConfig,
          features: { ...NO_QUERY_FEATURES, ...features },
        },
      })['hosting.config.json'] ?? '{}',
    ) as HostingConfig;

  it('stamps the toggle set from the generation config', () => {
    expect(withFeatures({ search: true, sort: true }).features).toEqual({
      search: true,
      filter: false,
      sort: true,
      include: false,
    });
  });

  it('resolves an absent toggle block to every feature off', () => {
    // A pre-query-layer IPS must produce a config the runtime reads as "off",
    // never as `undefined` it has to guess about.
    const legacy = JSON.parse(
      generateHostingConfig(goldenRelationsIPS)['hosting.config.json'] ?? '{}',
    ) as HostingConfig;
    expect(legacy.features).toEqual(NO_QUERY_FEATURES);
  });

  it('precomputes the field lists regardless of which toggles are on', () => {
    // The lists describe the schema, not the request surface — emitting them
    // unconditionally keeps the config diff-stable when a toggle flips, and the
    // runtime gates on `features`, not on the presence of a list.
    const off = withFeatures({});
    const on = withFeatures({ search: true, filter: true, sort: true, include: true });
    const student = (config: HostingConfig): HostedEntityConfig =>
      config.entities.find((entity) => entity.name === 'Student')!;
    expect(student(off).query).toEqual(student(on).query);
  });

  it('derives the lists from the materialized schema the runtime will see', () => {
    const config = withFeatures({ filter: true, include: true });
    const student = config.entities.find((entity) => entity.name === 'Student')!;
    // classroomId exists only because relation materialization created it, and
    // it is the field `?classroomId=` has to match.
    expect(student.query?.filterable).toContain('classroomId');
    expect(student.query?.sortable).toContain('classroomId');
    // The many-to-many key is an array, so it is filterable by neither name.
    expect(student.query?.filterable).not.toContain('courseIds');
    expect(student.query?.includable).toEqual(['classroom', 'courses']);
  });

  it('offers only textual fields to search when nothing is marked searchable', () => {
    const student = withFeatures({ search: true }).entities.find((e) => e.name === 'Student')!;
    // name is a string; enrolledAt is a date and classroomId an integer.
    expect(student.query?.searchable).toEqual(['name']);
  });

  it('lists no foreign key for a pack whose relations were never materialized', () => {
    // Relations are completed defensively here, but the *fields* they imply are
    // created by `materializeRelations` — which every API-borne IPS passes
    // through before storage. A hand-authored pack hosted directly therefore
    // resolves `?include=classroom` while `?classroomId=` is not a known
    // filter. Recorded so template packs (Phase 8) materialize on import.
    const raw = JSON.parse(
      generateHostingConfig({
        ...goldenRelationsIPS,
        generationConfig: { ...goldenRelationsIPS.generationConfig, features: ALL_QUERY_FEATURES },
      })['hosting.config.json'] ?? '{}',
    ) as HostingConfig;
    const student = raw.entities.find((entity) => entity.name === 'Student')!;
    expect(student.query?.filterable).not.toContain('classroomId');
    expect(student.query?.includable).toEqual(['classroom', 'courses']);
  });

  it('is deterministic with features enabled', () => {
    const ips = {
      ...materializeRelations(goldenRelationsIPS),
      generationConfig: { ...goldenRelationsIPS.generationConfig, features: ALL_QUERY_FEATURES },
    };
    expect(generateHostingConfig(ips)).toEqual(generateHostingConfig(ips));
  });
});
