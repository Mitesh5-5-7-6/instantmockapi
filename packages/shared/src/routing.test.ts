import { describe, it, expect } from 'vitest';

import { entitySlug } from './routing.js';
import { entityEndpoints, projectEndpoints } from './endpoints.js';

describe('entitySlug', () => {
  /**
   * These exact outputs are load-bearing. Every project already hosted was
   * generated under this rule, so a "nicer" scheme here silently moves live URLs
   * for existing users. Changing any of these expectations is a breaking change
   * to deployed APIs, not a refactor.
   */
  it('lowercases and otherwise leaves the name alone', () => {
    expect(entitySlug({ name: 'User' })).toBe('user');
    expect(entitySlug({ name: 'OrderItem' })).toBe('orderitem');
    expect(entitySlug({ name: 'API' })).toBe('api');
    expect(entitySlug({ name: 'product' })).toBe('product');
  });

  it('does not kebab-case, pluralise, or escape', () => {
    // Each of these would be a defensible design and none of them is what the
    // deployed runtime does.
    expect(entitySlug({ name: 'OrderItem' })).not.toBe('order-item');
    expect(entitySlug({ name: 'User' })).not.toBe('users');
    expect(entitySlug({ name: 'Order Item' })).toBe('order item');
  });

  it('is stable under repeated application', () => {
    const once = entitySlug({ name: 'OrderItem' });
    expect(entitySlug({ name: once })).toBe(once);
  });
});

describe('every route consumer agrees with it', () => {
  /**
   * The drift this seam exists to prevent. The runtime, the OpenAPI document and
   * the Postman collection each build paths independently; if any one of them
   * lowercased separately, the docs would advertise a URL the runtime answers 404
   * on and nobody debugging it would suspect a `toLowerCase()`.
   *
   * The generators cannot be imported here (`shared` sits below them), so this
   * pins the two consumers inside this package and the generator tests assert
   * their own paths against `entitySlug`.
   */
  it('derives endpoint paths from the slug', () => {
    const entity = {
      name: 'OrderItem',
      fields: [],
      identity: { field: 'id' as const, style: 'int' as const },
    };
    const slug = entitySlug(entity);

    for (const row of entityEndpoints(entity, ['GET', 'POST', 'DELETE'])) {
      expect(row.path.startsWith(`/${slug}`), `${row.path} is not under /${slug}`).toBe(true);
    }
  });

  it('keeps the discovery document at the base URL, outside any slug', () => {
    const rows = projectEndpoints([{ name: 'User', fields: [] }], ['GET']);
    expect(rows[0]).toMatchObject({ path: '', target: 'index' });
  });
});
