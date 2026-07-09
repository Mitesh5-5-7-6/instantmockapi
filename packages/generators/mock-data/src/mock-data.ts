/**
 * Mock Data generator (Worker D).
 *
 * Emits Faker-based mock data conforming to IPS structures and rules (doc 04 §F7, doc 09 §4).
 * Supports deterministic generation via seed inputs (for golden-file tests).
 */

import { Faker, en } from '@faker-js/faker';
import type { InternalProjectSchema, Field } from '@instantmockapi/ips';

/**
 * Generates mock JSON arrays for each entity in the schema.
 * Returns a dictionary mapping filename to a JSON string array of mock records.
 */
export function generateMockData(
  ips: InternalProjectSchema,
  seed?: number,
): Record<string, string> {
  const result: Record<string, string> = {};

  // Setup seeded or random Faker instance
  const faker = new Faker({ locale: [en] });
  if (seed !== undefined) {
    faker.seed(seed);
  }

  const recordCount = ips.generationConfig.mockRecords ?? 25;

  for (const entity of ips.entities) {
    const records: Record<string, any>[] = [];
    for (let i = 0; i < recordCount; i++) {
      records.push(generateRecord(entity.fields, faker));
    }
    result[`${entity.name.toLowerCase()}.mock.json`] = JSON.stringify(records, null, 2);
  }

  return result;
}

function generateRecord(fields: Field[], faker: Faker): Record<string, any> {
  const record: Record<string, any> = {};

  for (const field of fields) {
    record[field.name] = generateFieldValue(field, faker);
  }

  return record;
}

function generateFieldValue(field: Field, faker: Faker): any {
  // Respect nullable/optional probability if not required
  if (!field.required && faker.number.float() < 0.1) {
    return field.default !== undefined ? field.default : null;
  }

  const rules = field.validation;

  switch (field.type) {
    case 'string':
      // Check field name pattern matching for richer mock data
      const name = field.name.toLowerCase();
      if (name.includes('firstname')) return faker.person.firstName();
      if (name.includes('lastname')) return faker.person.lastName();
      if (name.includes('fullname') || name === 'name') return faker.person.fullName();
      if (name.includes('phone') || name.includes('mobile')) return faker.phone.number();
      if (name.includes('company')) return faker.company.name();
      if (name.includes('city')) return faker.location.city();
      if (name.includes('country')) return faker.location.country();
      if (name.includes('zip') || name.includes('postal')) return faker.location.zipCode();
      if (name.includes('street') || name.includes('address')) return faker.location.streetAddress();

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

    case 'number':
    case 'decimal':
      const minNum = rules.min ?? 0;
      const maxNum = rules.max ?? 10000;
      return faker.number.float({ min: minNum, max: maxNum, multipleOf: 0.01 });

    case 'integer':
      const minInt = rules.min ?? 0;
      const maxInt = rules.max ?? 10000;
      return faker.number.int({ min: minInt, max: maxInt });

    case 'boolean':
      return faker.datatype.boolean();

    case 'date':
      return faker.date.recent({ days: 30 }).toISOString();

    case 'email':
      return faker.internet.email();

    case 'url':
      return faker.internet.url();

    case 'uuid':
      return faker.string.uuid();

    case 'enum':
      const values = rules.enum ?? [];
      if (values.length === 0) return '';
      return faker.helpers.arrayElement(values);

    case 'object':
      return generateRecord(field.children, faker);

    case 'array':
      const minArr = rules.arrayLength?.min ?? 1;
      const maxArr = rules.arrayLength?.max ?? 3;
      const count = faker.number.int({ min: minArr, max: maxArr });
      
      const arrayItems: any[] = [];
      if (field.children.length > 0) {
        const itemField = field.children[0]!;
        for (let i = 0; i < count; i++) {
          arrayItems.push(generateFieldValue(itemField, faker));
        }
      }
      return arrayItems;

    default:
      return null;
  }
}
