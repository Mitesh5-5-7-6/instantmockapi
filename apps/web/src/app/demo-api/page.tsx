'use client';

import { useMemo, useState } from 'react';
import { Button, Card, FlowScope, Icon, Stepper } from '@instantmockapi/ui';
import { EntityCard } from '../../components/builder/entity-card';
import { ErDiagram, ErLegend } from '../../components/er-diagram';
import {
  newEntity,
  newField,
  newRelation,
  type BuilderEntity,
  type BuilderField,
  type BuilderRelation,
} from '../../lib/builder';
import { relationTargets, validateRelations } from '../../lib/relations';

const field = (
  name: string,
  type = 'string',
  validation: BuilderField['validation'] = {},
): BuilderField => ({
  ...newField(name, type),
  validation,
  showRules: Object.keys(validation).length > 0,
});

const relation = (
  name: string,
  target: string,
  kind: BuilderRelation['kind'] = 'belongsTo',
  onDelete: BuilderRelation['onDelete'] = 'restrict',
): BuilderRelation => ({ ...newRelation(), name, target, kind, onDelete });

function demoEntity(
  name: string,
  fields: BuilderField[],
  relations: BuilderRelation[] = [],
): BuilderEntity {
  return { ...newEntity(name), fields, relations, identityStyle: 'int' };
}

function createDemoEntities(): BuilderEntity[] {
  return [
    demoEntity('Role', [field('name'), field('permissions', 'array')]),
    demoEntity(
      'User',
      [
        field('email', 'string', { email: true, unique: true }),
        field('status', 'enum', { enum: ['active', 'suspended'] }),
      ],
      [relation('role', 'Role', 'belongsTo', 'restrict')],
    ),
    demoEntity(
      'Customer',
      [
        field('firstName'),
        field('lastName'),
        field('phone'),
        field('email', 'string', { email: true, unique: true }),
      ],
      [relation('user', 'User', 'belongsTo', 'cascade')],
    ),
    demoEntity(
      'Address',
      [field('line1'), field('city'), field('country'), field('postalCode')],
      [relation('customer', 'Customer', 'belongsTo', 'cascade')],
    ),
    demoEntity('Brand', [field('name'), field('slug', 'string', { unique: true })]),
    demoEntity(
      'Category',
      [field('name'), field('slug', 'string', { unique: true })],
      [relation('parent', 'Category', 'belongsTo', 'setNull')],
    ),
    demoEntity(
      'Product',
      [
        field('sku', 'string', { unique: true }),
        field('name'),
        field('price', 'decimal'),
        field('active', 'boolean'),
      ],
      [
        relation('category', 'Category', 'belongsTo', 'restrict'),
        relation('brand', 'Brand', 'belongsTo', 'restrict'),
      ],
    ),
    demoEntity(
      'Inventory',
      [
        field('available', 'integer'),
        field('reserved', 'integer'),
        field('reorderLevel', 'integer'),
      ],
      [relation('product', 'Product', 'belongsTo', 'cascade')],
    ),
    demoEntity(
      'Cart',
      [field('status', 'enum', { enum: ['active', 'converted', 'abandoned'] })],
      [relation('customer', 'Customer', 'belongsTo', 'cascade')],
    ),
    demoEntity(
      'CartItem',
      [field('quantity', 'integer'), field('unitPrice', 'decimal')],
      [
        relation('cart', 'Cart', 'belongsTo', 'cascade'),
        relation('product', 'Product', 'belongsTo', 'restrict'),
      ],
    ),
    demoEntity(
      'Order',
      [
        field('status', 'enum', { enum: ['pending', 'paid', 'shipped', 'delivered', 'cancelled'] }),
        field('total', 'decimal'),
        field('placedAt', 'date'),
      ],
      [
        relation('customer', 'Customer', 'belongsTo', 'restrict'),
        relation('shippingAddress', 'Address', 'belongsTo', 'setNull'),
      ],
    ),
    demoEntity(
      'OrderItem',
      [field('quantity', 'integer'), field('unitPrice', 'decimal')],
      [
        relation('order', 'Order', 'belongsTo', 'cascade'),
        relation('product', 'Product', 'belongsTo', 'restrict'),
      ],
    ),
    demoEntity(
      'Payment',
      [
        field('provider'),
        field('status', 'enum', { enum: ['pending', 'captured', 'failed', 'refunded'] }),
        field('amount', 'decimal'),
      ],
      [relation('order', 'Order', 'belongsTo', 'cascade')],
    ),
    demoEntity(
      'Shipment',
      [
        field('carrier'),
        field('trackingNumber'),
        field('status', 'enum', { enum: ['labelCreated', 'inTransit', 'delivered'] }),
      ],
      [
        relation('order', 'Order', 'belongsTo', 'cascade'),
        relation('address', 'Address', 'belongsTo', 'setNull'),
      ],
    ),
    demoEntity('Coupon', [
      field('code', 'string', { unique: true }),
      field('discount', 'decimal'),
      field('active', 'boolean'),
    ]),
    demoEntity(
      'Review',
      [field('rating', 'integer'), field('body')],
      [
        relation('product', 'Product', 'belongsTo', 'cascade'),
        relation('customer', 'Customer', 'belongsTo', 'cascade'),
      ],
    ),
    demoEntity(
      'Notification',
      [field('channel', 'enum', { enum: ['email', 'sms', 'push'] }), field('read', 'boolean')],
      [relation('customer', 'Customer', 'belongsTo', 'cascade')],
    ),
  ];
}

const STEPS = ['Create Project', 'Design Data Model', 'Configure APIs', 'Configure Generation'];

export default function DemoApiPage() {
  const [entities, setEntities] = useState<BuilderEntity[]>(createDemoEntities);
  const [step, setStep] = useState(2);
  const targets = useMemo(() => relationTargets(entities), [entities]);
  const relationIssues = useMemo(() => validateRelations(entities), [entities]);
  const updateEntity = (id: string, next: BuilderEntity) =>
    setEntities((current) => current.map((entity) => (entity.id === id ? next : entity)));

  return (
    <FlowScope flow="project">
      <div className="demo-builder-page">
        <div className="ui-row ui-row--between demo-builder-heading">
          <div>
            <span className="demo-eyebrow">Guided Project API</span>
            <h1>E-commerce Demo API</h1>
            <p className="ui-meta">
              Explore a complete commerce model. This is an editable demo project; your changes are
              not saved.
            </p>
          </div>
          <Stepper steps={STEPS} current={step} onGoTo={setStep} />
        </div>

        {step === 2 ? (
          <div className="ui-stack" style={{ gap: 'var(--space-4)' }}>
            <Card className="ui-stack demo-builder-intro">
              <div className="ui-row ui-row--between">
                <div>
                  <span className="demo-eyebrow">Data model / 17 entities</span>
                  <h2>Entities &amp; Relationships</h2>
                </div>
                <span className="demo-live-pill">
                  <span /> Demo data
                </span>
              </div>
              <p className="ui-meta">
                Entities become API resources. Fields define the shape of each record. Relationships
                connect resources so clients can request meaningful nested data.
              </p>
              <ErDiagram entities={entities} />
              <ErLegend />
            </Card>
            <Card className="demo-rule-guide">
              <div>
                <Icon name="layers" size={20} />
                <strong>How to read this model</strong>
                <span>
                  Click any entity card below to edit its fields and relationships. The diagram
                  updates as your model changes.
                </span>
              </div>
              <div>
                <span className="demo-rule-symbol demo-rule-symbol--key">PK</span>
                <strong>Keys and rules</strong>
                <span>
                  Every entity receives an ID. Fields can add email, unique, enum, numeric, and
                  required validation rules.
                </span>
              </div>
              <div>
                <span className="demo-rule-symbol demo-rule-symbol--relation">1:N</span>
                <strong>Relationship behavior</strong>
                <span>
                  Foreign keys are derived from the owning relation, then expanded through{' '}
                  <code>?include=...</code>.
                </span>
              </div>
            </Card>
            {entities.map((entity) => (
              <EntityCard
                key={entity.id}
                entity={entity}
                targets={targets}
                issues={relationIssues.filter((issue) => issue.entityId === entity.id)}
                removable={false}
                onChange={(next) => updateEntity(entity.id, next)}
                onRemove={() => undefined}
              />
            ))}
            <div className="ui-row demo-builder-actions">
              <Button variant="secondary" onClick={() => setStep(1)}>
                Back
              </Button>
              <div style={{ flex: 1 }} />
              <Button onClick={() => setStep(3)}>
                Next: Configure APIs <Icon name="chevron-right" size={16} />
              </Button>
            </div>
          </div>
        ) : (
          <Card className="ui-stack demo-coming-step">
            <span className="demo-eyebrow">Step {step}</span>
            <h2>{STEPS[step - 1]}</h2>
            <p className="ui-meta">
              This demo focuses on the data model. Return to Design Data Model to keep exploring the
              entities and their rules.
            </p>
            <Button onClick={() => setStep(2)}>Back to data model</Button>
          </Card>
        )}
      </div>
    </FlowScope>
  );
}
