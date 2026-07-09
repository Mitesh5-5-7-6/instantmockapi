import { describe, it, expect } from 'vitest';
import { parseJSONPayload } from './json-adapter.js';

describe('JSON Parser Adapter', () => {
  it('should parse flat primitive values correctly', () => {
    const payload = {
      username: 'johndoe',
      isActive: true,
      age: 30,
      balance: 125.5,
      createdAt: '2026-07-09T12:00:00Z',
    };

    const res = parseJSONPayload('proj_1', 'Project A', JSON.stringify(payload));
    expect(res.ok).toBe(true);
    if (res.ok) {
      const entity = res.value.entities[0]!;
      expect(entity.name).toBe('MainEntity');

      const username = entity.fields.find((f) => f.name === 'username')!;
      expect(username.type).toBe('string');
      expect(username.required).toBe(true);

      const isActive = entity.fields.find((f) => f.name === 'isActive')!;
      expect(isActive.type).toBe('boolean');

      const age = entity.fields.find((f) => f.name === 'age')!;
      expect(age.type).toBe('integer');

      const balance = entity.fields.find((f) => f.name === 'balance')!;
      expect(balance.type).toBe('decimal');

      const createdAt = entity.fields.find((f) => f.name === 'createdAt')!;
      expect(createdAt.type).toBe('date');
    }
  });

  it('should infer email, url, and uuid from values and keys', () => {
    const payload = {
      user_email: 'test@example.com',
      websiteUrl: 'https://google.com',
      token: 'd3b07384-d113-4956-a56e-214a1f6540d5',
    };

    const res = parseJSONPayload('proj_1', 'Project A', JSON.stringify(payload));
    expect(res.ok).toBe(true);
    if (res.ok) {
      const entity = res.value.entities[0]!;

      const email = entity.fields.find((f) => f.name === 'user_email')!;
      expect(email.type).toBe('email');
      expect(email.validation.email).toBe(true);

      const url = entity.fields.find((f) => f.name === 'websiteUrl')!;
      expect(url.type).toBe('url');
      expect(url.validation.url).toBe(true);

      const uuid = entity.fields.find((f) => f.name === 'token')!;
      expect(uuid.type).toBe('uuid');
      expect(uuid.validation.uuid).toBe(true);
    }
  });

  it('should parse nested objects recursively', () => {
    const payload = {
      profile: {
        firstName: 'John',
        address: {
          city: 'New York',
        },
      },
    };

    const res = parseJSONPayload('proj_1', 'Project A', JSON.stringify(payload));
    expect(res.ok).toBe(true);
    if (res.ok) {
      const entity = res.value.entities[0]!;
      const profile = entity.fields.find((f) => f.name === 'profile')!;
      expect(profile.type).toBe('object');
      expect(profile.children.length).toBe(2);

      const firstName = profile.children.find((f) => f.name === 'firstName')!;
      expect(firstName.type).toBe('string');

      const address = profile.children.find((f) => f.name === 'address')!;
      expect(address.type).toBe('object');

      const city = address.children.find((f) => f.name === 'city')!;
      expect(city.type).toBe('string');
    }
  });

  it('should merge objects within an array to construct a unified schema', () => {
    const payload = {
      contacts: [
        { name: 'John', phone: '123' },
        { name: 'Jane', email: 'jane@b.com' },
      ],
    };

    const res = parseJSONPayload('proj_1', 'Project A', JSON.stringify(payload));
    expect(res.ok).toBe(true);
    if (res.ok) {
      const entity = res.value.entities[0]!;
      const contacts = entity.fields.find((f) => f.name === 'contacts')!;
      expect(contacts.type).toBe('array');
      
      // The schema inside contacts must merge both elements -> name, phone, email
      expect(contacts.children.length).toBe(3);

      const name = contacts.children.find((f) => f.name === 'name')!;
      expect(name.type).toBe('string');
      expect(name.required).toBe(true); // present in all array elements

      const phone = contacts.children.find((f) => f.name === 'phone')!;
      expect(phone.type).toBe('string');
      expect(phone.required).toBe(false); // only in first element

      const email = contacts.children.find((f) => f.name === 'email')!;
      expect(email.type).toBe('email');
      expect(email.required).toBe(false); // only in second element
    }
  });
});
