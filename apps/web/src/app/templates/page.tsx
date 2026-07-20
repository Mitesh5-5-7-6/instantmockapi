'use client';

/**
 * S9 · Templates (doc 11): starter schemas that prefill the New Project
 * wizard. Selection stashes the payload and routes into S2.
 */

import { useRouter } from 'next/navigation';
import { Button, Card } from '@instantmockapi/ui';

const TEMPLATE_KEY = 'instantmockapi.template';

const TEMPLATES = [
  {
    name: 'CRM Backend',
    description: 'Customers with contact details and nested addresses.',
    entities: 'customer',
    json: {
      customer: {
        name: 'Ada Lovelace',
        email: 'ada@example.com',
        phone: '+44 20 7946 0958',
        company: 'Analytical Engines Ltd',
        address: { street: '12 Byron Row', city: 'London', zip: 'EC1A 1BB', country: 'UK' },
      },
    },
  },
  {
    name: 'Blog Platform',
    description: 'Posts with authors, tags, and publication state.',
    entities: 'post',
    json: {
      post: {
        title: 'Compilers for backends',
        slug: 'compilers-for-backends',
        body: 'Schemas in, infrastructure out.',
        published: true,
        publishedAt: '2026-07-01T09:00:00Z',
        author: { name: 'Grace Hopper', email: 'grace@example.com' },
        tags: ['engineering', 'apis'],
      },
    },
  },
  {
    name: 'E-commerce Catalog',
    description: 'Products with pricing, stock, and category data.',
    entities: 'product',
    json: {
      product: {
        sku: 'SKU-100482',
        name: 'Mechanical Keyboard',
        price: 129.99,
        currency: 'USD',
        inStock: true,
        stockCount: 42,
        category: { name: 'Peripherals', code: 'periph' },
        images: ['https://example.com/kb-front.jpg'],
      },
    },
  },
];

export default function TemplatesPage() {
  const router = useRouter();

  return (
    <div className="ui-stack" style={{ gap: 'var(--space-6)' }}>
      <div>
        <h1>Templates</h1>
        <p className="ui-meta">Start from a known-good schema and adjust in the wizard.</p>
      </div>
      <div className="ui-grid-cards">
        {TEMPLATES.map((template) => (
          <Card key={template.name} interactive className="ui-stack">
            <h3>{template.name}</h3>
            <p className="ui-meta">{template.description}</p>
            <span className="ui-meta ui-mono">entities: {template.entities}</span>
            <div>
              <Button
                size="sm"
                onClick={() => {
                  window.sessionStorage.setItem(
                    TEMPLATE_KEY,
                    JSON.stringify({
                      name: template.name,
                      json: JSON.stringify(template.json, null, 2),
                    }),
                  );
                  router.push('/new');
                }}
              >
                Use template
              </Button>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
