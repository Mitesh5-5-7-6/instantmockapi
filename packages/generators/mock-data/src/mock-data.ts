/**
 * Mock Data generator (Worker D).
 *
 * Emits Faker-based mock data conforming to IPS structures and rules (doc 04 §F7, doc 09 §4).
 * Supports deterministic generation via seed inputs (for golden-file tests).
 *
 * Entities are seeded in dependency order so that foreign keys resolve to real
 * parent records (doc 19 §Phase A): an owning-side reference draws from the ids
 * the target actually received. Entities that declare neither `identity` nor
 * `relations` take exactly the path they took before relations existed — same
 * Faker draws, in the same order, so their output is byte-identical.
 */

import { Faker, en } from '@faker-js/faker';
import { AVATAR_TRAITS, AVATAR_TRAIT_NAMES, avatarUrl } from '@instantmockapi/shared';
import {
  entityIdentity,
  entityRelations,
  isOwningRelation,
  topologicalEntityOrder,
  type Entity,
  type Field,
  type InternalProjectSchema,
  type Relation,
} from '@instantmockapi/ips';

/** An issued identity value — `int` style yields numbers, `uuid` strings. */
type IdentityValue = string | number;

/**
 * Reference point for `date` fields when a seed is supplied.
 *
 * `faker.date.recent()` is relative to *now*, so without a fixed reference two
 * seeded runs milliseconds apart produce different dates — which contradicts the
 * seeded-generation contract this module documents and makes any golden-file
 * comparison of a date field flaky. Seeded runs therefore pin the reference;
 * unseeded runs keep drawing relative to the real clock.
 */
const SEEDED_REF_DATE = new Date('2026-01-01T00:00:00.000Z');

type MockRecord = Record<string, unknown>;

interface SeedPlan {
  /** null when the entity declares no identity: seed it exactly as before. */
  identityField: string | null;
  identityStyle: 'int' | 'uuid';
  /** localField → relation, owning sides only. */
  references: Map<string, Relation>;
}

/** A reference whose target pool was empty at draw time; revisited in pass 2. */
interface Deferred {
  record: MockRecord;
  field: Field;
  relation: Relation;
}

function seedPlan(entity: Entity): SeedPlan {
  // Gated on the explicit declaration, NOT on entityIdentity()'s default: a
  // pre-relations entity must draw exactly the values it drew before.
  const identity = entity.identity ? entityIdentity(entity) : null;
  const references = new Map<string, Relation>();
  for (const relation of entityRelations(entity)) {
    if (isOwningRelation(relation) && relation.localField) {
      references.set(relation.localField, relation);
    }
  }
  return {
    identityField: identity?.field ?? null,
    identityStyle: identity?.style ?? 'uuid',
    references,
  };
}

/**
 * Pick foreign-key value(s) from the identity values the target actually issued.
 *
 * `resolved: false` means the target's pool was empty — a `belongsTo` cycle, a
 * self-reference, or a `manyToMany` target ordered later — and the caller must
 * defer this reference to pass 2.
 */
function drawReference(
  relation: Relation,
  field: Field,
  pool: ReadonlyMap<string, IdentityValue[]>,
  faker: Faker,
): { value: unknown; resolved: boolean } {
  const values = pool.get(relation.target) ?? [];

  if (relation.kind === 'manyToMany') {
    // Link count honours the field's own arrayLength rules, so the generated data
    // still validates against the generated Zod/JSON Schema.
    const min = field.validation.arrayLength?.min ?? 1;
    const max = field.validation.arrayLength?.max ?? 3;
    const count = faker.number.int({ min, max });
    if (values.length === 0) {
      return { value: [], resolved: false };
    }
    // Distinct picks: a join pair must not repeat inside one record.
    return {
      value: faker.helpers.arrayElements(values, Math.min(count, values.length)),
      resolved: true,
    };
  }

  if (values.length === 0) {
    return { value: null, resolved: false };
  }
  // Optional relations get an occasional null so consumers exercise the
  // "no parent" branch — mirrors generateFieldValue's optional-null rule.
  if (!relation.required && faker.number.float() < 0.1) {
    return { value: null, resolved: true };
  }
  return { value: faker.helpers.arrayElement(values), resolved: true };
}

function generateEntityRecord(
  entity: Entity,
  index: number,
  plan: SeedPlan,
  pool: ReadonlyMap<string, IdentityValue[]>,
  deferrals: Deferred[],
  faker: Faker,
  refDate: Date | undefined,
): MockRecord {
  const record: MockRecord = {};

  // Identity first, at a stable position. `int` consumes zero Faker draws;
  // `uuid` consumes exactly one — and materializeRelations puts the identity
  // field at index 0, so the draw order matches the field order either way.
  if (plan.identityField !== null) {
    record[plan.identityField] = plan.identityStyle === 'int' ? index + 1 : faker.string.uuid();
  }

  for (const field of entity.fields) {
    if (field.name === plan.identityField) {
      continue; // assigned above
    }
    const relation = plan.references.get(field.name);
    if (relation) {
      const drawn = drawReference(relation, field, pool, faker);
      record[field.name] = drawn.value;
      if (!drawn.resolved) {
        deferrals.push({ record, field, relation });
      }
      continue;
    }
    record[field.name] = generateFieldValue(field, faker, refDate);
  }

  return record;
}

/**
 * Keep mutually-owning `manyToMany` pairs consistent.
 *
 * When both sides declare the relation, each drew its own array and the two can
 * disagree. The first-declared side is authoritative; the other is rebuilt from
 * it. Pure set arithmetic — no Faker draws, so determinism is unaffected.
 */
function mirrorManyToMany(
  seeded: { entity: Entity; plan: SeedPlan; records: MockRecord[] }[],
  order: readonly string[],
): void {
  const byName = new Map(seeded.map((item) => [item.entity.name, item]));

  for (const item of seeded) {
    for (const relation of entityRelations(item.entity)) {
      if (relation.kind !== 'manyToMany') {
        continue;
      }
      const other = byName.get(relation.target);
      if (!other || other.entity.name === item.entity.name) {
        continue;
      }
      const back = entityRelations(other.entity).find(
        (candidate) => candidate.kind === 'manyToMany' && candidate.target === item.entity.name,
      );
      if (!back) {
        continue;
      }
      // Only the authoritative side rebuilds its partner.
      if (order.indexOf(item.entity.name) > order.indexOf(other.entity.name)) {
        continue;
      }

      const sourceIdentity = item.plan.identityField;
      const targetIdentity = other.plan.identityField;
      if (!sourceIdentity || !targetIdentity) {
        continue;
      }

      const links = new Map<string, IdentityValue[]>();
      for (const record of item.records) {
        const own = record[sourceIdentity];
        if (typeof own !== 'string' && typeof own !== 'number') {
          continue;
        }
        for (const linked of Array.isArray(record[relation.localField])
          ? (record[relation.localField] as unknown[])
          : []) {
          const key = String(linked);
          const bucket = links.get(key) ?? [];
          bucket.push(own);
          links.set(key, bucket);
        }
      }

      for (const record of other.records) {
        const own = record[targetIdentity];
        record[back.localField] = links.get(String(own)) ?? [];
      }
    }
  }
}

/**
 * Generates mock JSON arrays for each entity in the schema.
 * Returns a dictionary mapping filename to a JSON string array of mock records.
 */
export function generateMockData(
  ips: InternalProjectSchema,
  seed?: number,
): Record<string, string> {
  // Setup seeded or random Faker instance
  const faker = new Faker({ locale: [en] });
  if (seed !== undefined) {
    faker.seed(seed);
  }

  const refDate = seed !== undefined ? SEEDED_REF_DATE : undefined;
  const recordCount = ips.generationConfig.mockRecords ?? 25;
  const pool = new Map<string, IdentityValue[]>();
  const deferrals: Deferred[] = [];
  const seeded: { entity: Entity; plan: SeedPlan; records: MockRecord[] }[] = [];
  const order: string[] = [];

  // Pass 1: parents before children, so children draw real foreign keys.
  for (const entity of topologicalEntityOrder(ips)) {
    const plan = seedPlan(entity);
    const records: MockRecord[] = [];
    const issued: IdentityValue[] = [];

    for (let i = 0; i < recordCount; i++) {
      const record = generateEntityRecord(entity, i, plan, pool, deferrals, faker, refDate);
      if (plan.identityField !== null) {
        const value = record[plan.identityField];
        if (typeof value === 'string' || typeof value === 'number') {
          issued.push(value);
        }
      }
      records.push(record);
    }

    pool.set(entity.name, issued);
    order.push(entity.name);
    seeded.push({ entity, plan, records });
  }

  // Pass 2: cycles and self-references, whose pools were empty first time round.
  for (const { record, field, relation } of deferrals) {
    const drawn = drawReference(relation, field, pool, faker);
    if (drawn.resolved) {
      record[field.name] = drawn.value;
    }
  }

  mirrorManyToMany(seeded, order);

  // Emit in declaration order — file keys stay stable regardless of seed order.
  const byName = new Map(seeded.map((item) => [item.entity.name, item.records]));
  const result: Record<string, string> = {};
  for (const entity of ips.entities) {
    const records = byName.get(entity.name) ?? [];
    result[`${entity.name.toLowerCase()}.mock.json`] = JSON.stringify(records, null, 2);
  }

  return result;
}

function generateRecord(
  fields: Field[],
  faker: Faker,
  refDate: Date | undefined,
): Record<string, unknown> {
  const record: Record<string, unknown> = {};

  for (const field of fields) {
    record[field.name] = generateFieldValue(field, faker, refDate);
  }

  return record;
}

/**
 * Field-name → realistic value, for `string` fields.
 *
 * ## Why this exists
 *
 * A field called `email` declared as `string` used to seed "Censura claro
 * defung". Lorem ipsum is a fine placeholder for a `description`; it is a bug
 * for anything a developer will paste into a form, render in a UI, or hand to a
 * library that parses it. The value of a mock API is that the fake data behaves
 * like the real data, and a mailto: link built from Latin does not.
 *
 * ## How the matching works, and its one rule
 *
 * The list is ordered, first match wins, and **the specific must precede the
 * general**. `firstName` has to be tested before `name`, or every name-ish
 * field collapses into a full name. Each entry that depends on its position says
 * so where it is not obvious.
 *
 * Matching is on a normalized name — lower-cased with `_`, `-` and spaces
 * removed — so `first_name`, `firstName` and `FIRST NAME` are one case rather
 * than three near-misses.
 *
 * ## What is deliberately NOT here
 *
 * `title`, `description`, `note`, `content`, `body` and friends. Those really
 * are free text and lorem is the honest answer; inventing a sentence that reads
 * like a product name would just move the surprise somewhere else.
 */
const SEMANTIC_FIELDS: { test: (name: string) => boolean; value: (faker: Faker) => string }[] = [
  /* ── identity ──
   *
   * Before the `name` entry: a `firstName` matched by that rule becomes a
   * full name, and two columns of the same table then disagree about what a
   * person is called. */
  {
    test: (n) => n.includes('firstname') || n === 'fname' || n === 'givenname',
    value: (f) => f.person.firstName(),
  },
  {
    test: (n) => n.includes('lastname') || n === 'lname' || n === 'surname' || n === 'familyname',
    value: (f) => f.person.lastName(),
  },
  { test: (n) => n.includes('middlename'), value: (f) => f.person.middleName() },
  {
    test: (n) => n.includes('username') || n === 'login' || n === 'handle' || n === 'nickname',
    value: (f) => f.internet.username(),
  },
  {
    test: (n) =>
      n.includes('fullname') || n === 'name' || n === 'displayname' || n === 'contactname',
    value: (f) => f.person.fullName(),
  },
  { test: (n) => n === 'gender' || n === 'sex', value: (f) => f.person.sex() },
  {
    test: (n) => n === 'jobtitle' || n === 'designation' || n === 'occupation' || n === 'position',
    value: (f) => f.person.jobTitle(),
  },

  /* ── contact ──
   *
   * Avatar first: an `avatarUrl` field typed `string` should still be a
   * picture, not the random domain the `url` suffix rule below would give it. */
  {
    test: (n) =>
      n.includes('avatar') ||
      n.includes('profilepic') ||
      n.includes('profileimage') ||
      n === 'photo' ||
      n === 'picture',
    value: (faker) => randomAvatarUrl(faker),
  },
  { test: (n) => n.includes('email') || n === 'mail', value: (f) => f.internet.email() },
  {
    test: (n) =>
      n.includes('phone') ||
      n.includes('mobile') ||
      n.includes('contactnumber') ||
      n === 'tel' ||
      n === 'telephone' ||
      n === 'whatsapp',
    value: (f) => f.phone.number(),
  },
  {
    test: (n) =>
      n.includes('website') || n.includes('homepage') || n.endsWith('url') || n.endsWith('link'),
    value: (f) => f.internet.url(),
  },

  /* ── address ──
   *
   * The two numbered lines come before the general `address` rule, or
   * `addressLine1` and `address` would hold the same full address twice. */
  {
    test: (n) =>
      n.includes('zipcode') ||
      n === 'zip' ||
      n.includes('postalcode') ||
      n.includes('pincode') ||
      n === 'pin',
    value: (f) => f.location.zipCode(),
  },
  {
    test: (n) => n.includes('street') || n === 'addressline1' || n === 'line1',
    value: (f) => f.location.streetAddress(),
  },
  {
    test: (n) => n === 'addressline2' || n === 'line2',
    value: (f) => f.location.secondaryAddress(),
  },
  {
    test: (n) => n.includes('address'),
    value: (f) => f.location.streetAddress({ useFullAddress: true }),
  },
  {
    test: (n) => n === 'city' || n === 'town' || n === 'locality',
    value: (f) => f.location.city(),
  },
  {
    test: (n) => n === 'state' || n === 'province' || n === 'region',
    value: (f) => f.location.state(),
  },
  { test: (n) => n === 'country', value: (f) => f.location.country() },
  { test: (n) => n === 'countrycode', value: (f) => f.location.countryCode() },
  { test: (n) => n === 'timezone' || n === 'tz', value: (f) => f.location.timeZone() },

  /* ── company ── */
  {
    test: (n) =>
      n.includes('company') || n === 'organisation' || n === 'organization' || n === 'employer',
    value: (f) => f.company.name(),
  },
  { test: (n) => n === 'department' || n === 'team', value: (f) => f.commerce.department() },

  /* ── commerce ── */
  {
    test: (n) => n === 'productname' || n === 'product' || n === 'itemname',
    value: (f) => f.commerce.productName(),
  },
  {
    test: (n) => n === 'sku' || n === 'skucode',
    value: (f) => f.string.alphanumeric({ length: 8, casing: 'upper' }),
  },
  { test: (n) => n === 'currency' || n === 'currencycode', value: (f) => f.finance.currencyCode() },
  { test: (n) => n === 'iban', value: (f) => f.finance.iban() },
  { test: (n) => n === 'color' || n === 'colour', value: (f) => f.color.human() },

  /* ── web and system ── */
  {
    test: (n) => n === 'slug' || n === 'permalink',
    value: (f) => f.helpers.slugify(f.lorem.words(3)).toLowerCase(),
  },
  { test: (n) => n === 'ip' || n === 'ipaddress', value: (f) => f.internet.ipv4() },
  { test: (n) => n === 'macaddress' || n === 'mac', value: (f) => f.internet.mac() },
  { test: (n) => n === 'useragent', value: (f) => f.internet.userAgent() },
  {
    test: (n) => n === 'password' || n === 'passwordhash',
    value: (f) => f.internet.password({ length: 16 }),
  },
  {
    test: (n) => n === 'token' || n === 'apikey' || n === 'accesstoken',
    value: (f) => f.string.alphanumeric(32),
  },
  {
    test: (n) => n === 'language' || n === 'locale' || n === 'lang',
    value: (f) => f.location.countryCode(),
  },
];

/**
 * Normalize a field name for matching.
 *
 * Separators are stripped rather than kept, so `first_name`, `first-name`,
 * `firstName` and `First Name` all reduce to `firstname` and one entry above
 * covers every spelling a schema might use.
 */
function normalizeFieldName(name: string): string {
  return name.toLowerCase().replace(/[\s_-]/g, '');
}

/** The realistic value a field name implies, or null when the name says nothing. */
function semanticValue(name: string, faker: Faker): string | null {
  const normalized = normalizeFieldName(name);
  const match = SEMANTIC_FIELDS.find((entry) => entry.test(normalized));
  return match ? match.value(faker) : null;
}

/**
 * One avatar, drawn trait by trait.
 *
 * Every trait is one `arrayElement` call, in the fixed order of
 * `AVATAR_TRAIT_NAMES`, so a seeded run reproduces the same face — the same
 * contract every other value in this module keeps.
 */
function randomAvatarUrl(faker: Faker): string {
  const traits: Record<string, string> = {};
  for (const trait of AVATAR_TRAIT_NAMES) {
    traits[trait] = faker.helpers.arrayElement(AVATAR_TRAITS[trait] as readonly string[]);
  }
  return avatarUrl(traits);
}

function generateFieldValue(field: Field, faker: Faker, refDate: Date | undefined): unknown {
  // Respect nullable/optional probability if not required
  if (!field.required && faker.number.float() < 0.1) {
    return field.default !== undefined ? field.default : null;
  }

  const rules = field.validation;

  switch (field.type) {
    case 'string': {
      const semantic = semanticValue(field.name, faker);
      if (semantic !== null) {
        return semantic;
      }

      const minLen = rules.min ?? rules.length ?? 5;
      const maxLen = rules.max ?? rules.length ?? 20;

      let text = faker.lorem.sentence();

      if (text.length > maxLen) {
        text = text.slice(0, maxLen);
      }

      if (text.length < minLen) {
        text = text.padEnd(minLen, 'a');
      }

      return text;
    }
    case 'number':
    case 'decimal': {
      const minNum = rules.min ?? 0;
      const maxNum = rules.max ?? 10000;

      return faker.number.float({
        min: minNum,
        max: maxNum,
        multipleOf: 0.01,
      });
    }
    case 'integer': {
      const minInt = rules.min ?? 0;
      const maxInt = rules.max ?? 10000;

      return faker.number.int({
        min: minInt,
        max: maxInt,
      });
    }
    case 'boolean':
      return faker.datatype.boolean();

    case 'date':
      return faker.date.recent({ days: 30, refDate }).toISOString();

    case 'email':
      return faker.internet.email();

    case 'url':
      return faker.internet.url();

    case 'uuid':
      return faker.string.uuid();

    case 'avatar':
      return randomAvatarUrl(faker);

    case 'enum': {
      const values = rules.enum ?? [];

      if (values.length === 0) {
        return '';
      }

      return faker.helpers.arrayElement(values);
    }
    case 'object':
      return generateRecord(field.children, faker, refDate);

    case 'array': {
      const minArr = rules.arrayLength?.min ?? 1;
      const maxArr = rules.arrayLength?.max ?? 3;
      const count = faker.number.int({
        min: minArr,
        max: maxArr,
      });

      const arrayItems: unknown[] = [];

      if (field.children.length > 0) {
        const itemField = field.children[0]!;

        for (let i = 0; i < count; i++) {
          arrayItems.push(generateFieldValue(itemField, faker, refDate));
        }
      }

      return arrayItems;
    }
    default:
      return null;
  }
}
