'use client';

import { useState } from 'react';
import { Button, Card, Icon, MethodBadge } from '@instantmockapi/ui';
import {
  demoEndpoints,
  demoEntities,
  demoGroups,
  demoRelationships,
  type DemoEntity,
} from '../../lib/demo-ecommerce';

const diagramPositions: Record<string, { left: number; top: number }> = {
  roles: { left: 2, top: 3 },
  users: { left: 28, top: 3 },
  customers: { left: 54, top: 3 },
  addresses: { left: 80, top: 3 },
  categories: { left: 2, top: 47 },
  products: { left: 28, top: 47 },
  inventory: { left: 54, top: 47 },
  reviews: { left: 80, top: 47 },
  orders: { left: 15, top: 76 },
  order_items: { left: 41, top: 76 },
  payments: { left: 67, top: 76 },
  shipments: { left: 80, top: 47 },
};

const diagramLines = [
  { x1: 11, y1: 22, x2: 34, y2: 22 },
  { x1: 45, y1: 22, x2: 60, y2: 22 },
  { x1: 69, y1: 22, x2: 86, y2: 22 },
  { x1: 11, y1: 60, x2: 34, y2: 60 },
  { x1: 45, y1: 60, x2: 60, y2: 60 },
  { x1: 69, y1: 60, x2: 86, y2: 60 },
  { x1: 34, y1: 66, x2: 25, y2: 78 },
  { x1: 45, y1: 66, x2: 47, y2: 78 },
  { x1: 60, y1: 66, x2: 72, y2: 78 },
  { x1: 86, y1: 66, x2: 86, y2: 78 },
];

function EntityCard({
  entity,
  selected,
  onSelect,
}: {
  entity: DemoEntity;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      className={`demo-entity-card${selected ? ' is-selected' : ''}`}
      style={{ '--entity-color': entity.color } as React.CSSProperties}
      onClick={onSelect}
      type="button"
    >
      <span className="demo-entity-card__heading">
        <span className="demo-entity-card__dot" />
        <strong>{entity.label}</strong>
      </span>
      <span className="demo-entity-card__count">{entity.recordCount} records</span>
      <span className="demo-entity-card__key">
        {entity.fields[0]?.name}: {entity.fields[0]?.type}
      </span>
    </button>
  );
}

function EntityDetails({ entity }: { entity: DemoEntity }) {
  return (
    <Card className="demo-detail-card">
      <div className="demo-section-heading">
        <div>
          <span className="demo-eyebrow">Selected entity</span>
          <h3>{entity.label}</h3>
        </div>
        <span className="demo-record-badge">{entity.recordCount} records</span>
      </div>
      <p className="ui-meta">{entity.description}</p>
      <div className="demo-field-list">
        {entity.fields.map((field) => (
          <div className="demo-field-row" key={field.name}>
            <span className="demo-field-name">
              {field.key ? (
                <span className={`demo-key demo-key--${field.key}`}>
                  {field.key === 'primary' ? 'PK' : 'FK'}
                </span>
              ) : null}
              {field.name}
            </span>
            <span className="ui-mono demo-field-type">
              {field.type}
              {field.nullable ? ' | null' : ''}
            </span>
          </div>
        ))}
      </div>
    </Card>
  );
}

function RelationshipExplorer({ selected }: { selected: string }) {
  const relationships = demoRelationships.filter(
    (relationship) => relationship.from === selected || relationship.to === selected,
  );
  return (
    <Card className="demo-detail-card">
      <div className="demo-section-heading">
        <div>
          <span className="demo-eyebrow">Relationship explorer</span>
          <h3>Connected resources</h3>
        </div>
        <Icon name="layers" size={20} />
      </div>
      <div className="demo-relationship-list">
        {relationships.map((relationship) => (
          <div
            className="demo-relationship-row"
            key={`${relationship.from}-${relationship.to}-${relationship.label}`}
          >
            <span className="demo-relationship-nodes">
              <span>{relationship.from}</span>
              <span className="demo-cardinality">{relationship.cardinality}</span>
              <span>{relationship.to}</span>
            </span>
            <span className="ui-meta">{relationship.label}</span>
          </div>
        ))}
      </div>
    </Card>
  );
}

function RelationshipDiagram({
  selected,
  onSelect,
}: {
  selected: string;
  onSelect: (name: string) => void;
}) {
  return (
    <Card className="demo-diagram-card">
      <div className="demo-section-heading">
        <div>
          <span className="demo-eyebrow">Data architecture</span>
          <h2>Entity relationship diagram</h2>
        </div>
        <span className="demo-diagram-legend">
          <span className="demo-legend-line" /> Connected model
        </span>
      </div>
      <div className="demo-diagram-scroll">
        <div className="demo-diagram-canvas">
          <svg
            className="demo-diagram-lines"
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            {diagramLines.map((line, index) => (
              <line key={index} {...line} />
            ))}
          </svg>
          {demoEntities.map((entity) => {
            const position = diagramPositions[entity.name];
            if (!position) return null;
            return (
              <div
                className="demo-diagram-node"
                key={entity.name}
                style={{ left: `${position.left}%`, top: `${position.top}%` }}
              >
                <EntityCard
                  entity={entity}
                  selected={selected === entity.name}
                  onSelect={() => onSelect(entity.name)}
                />
              </div>
            );
          })}
        </div>
      </div>
      <p className="demo-diagram-note">
        <span className="demo-key demo-key--primary">PK</span> Primary key{' '}
        <span className="demo-key demo-key--foreign">FK</span> Foreign key{' '}
        <span className="demo-cardinality">1:N</span> Relationship cardinality
      </p>
    </Card>
  );
}

function EndpointExplorer() {
  const [group, setGroup] = useState('All endpoints');
  const [copied, setCopied] = useState('');
  const endpoints =
    group === 'All endpoints'
      ? demoEndpoints
      : demoEndpoints.filter((endpoint) => endpoint.group === group);

  async function copyPath(path: string) {
    await navigator.clipboard?.writeText(`https://demo.instantmockapi.com/v1${path}`);
    setCopied(path);
    window.setTimeout(() => setCopied(''), 1600);
  }

  return (
    <Card className="demo-endpoint-card">
      <div className="demo-section-heading demo-section-heading--wrap">
        <div>
          <span className="demo-eyebrow">API explorer</span>
          <h2>Endpoints you can build against</h2>
        </div>
        <div className="demo-filter-row" role="tablist" aria-label="Endpoint groups">
          {['All endpoints', ...demoGroups].map((item) => (
            <button
              className={`demo-filter${group === item ? ' is-active' : ''}`}
              key={item}
              onClick={() => setGroup(item)}
              type="button"
              role="tab"
              aria-selected={group === item}
            >
              {item}
            </button>
          ))}
        </div>
      </div>
      <div className="demo-endpoint-list">
        {endpoints.map((endpoint) => (
          <div className="demo-endpoint-row" key={endpoint.path}>
            <div className="demo-endpoint-main">
              <MethodBadge method={endpoint.method} />
              <span className="ui-mono demo-endpoint-path">{endpoint.path}</span>
              <span className="demo-endpoint-group">{endpoint.group}</span>
            </div>
            <p className="ui-meta">{endpoint.description}</p>
            <div className="demo-endpoint-example">
              <div className="demo-example-head">
                <span>Response example</span>
                <span>{endpoint.auth}</span>
              </div>
              <code>{endpoint.response}</code>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void copyPath(endpoint.path)}
              aria-label={`Copy ${endpoint.path}`}
            >
              <Icon name={copied === endpoint.path ? 'check' : 'code'} size={16} />{' '}
              {copied === endpoint.path ? 'Copied' : 'Copy URL'}
            </Button>
          </div>
        ))}
      </div>
    </Card>
  );
}

export function EcommerceDemo() {
  const [selectedEntity, setSelectedEntity] = useState('orders');
  const selected =
    demoEntities.find((entity) => entity.name === selectedEntity) ?? demoEntities[0]!;

  return (
    <main className="demo-page">
      <nav className="demo-nav" aria-label="Demo navigation">
        <a className="demo-brand" href="/">
          <span className="demo-brand-mark">
            <Icon name="code" size={18} />
          </span>
          Instant<span>Mock</span>API
        </a>
        <div className="demo-nav-links">
          <a href="#overview">Overview</a>
          <a href="#model">Data model</a>
          <a href="#endpoints">Endpoints</a>
        </div>
        <Button size="sm" variant="secondary" onClick={() => window.location.assign('/new')}>
          Build your own <Icon name="chevron-right" size={14} />
        </Button>
      </nav>

      <section className="demo-hero" id="overview">
        <div className="demo-hero-copy">
          <span className="demo-status">
            <span /> LIVE DEMO PROJECT API
          </span>
          <h1>E-commerce, mapped from identity to delivery.</h1>
          <p>
            Explore a production-shaped backend model with connected customers, catalog, orders,
            payments, and fulfillment. Every relationship is visible. Every endpoint has a response.
          </p>
          <div className="demo-hero-actions">
            <a className="demo-primary-action" href="#model">
              Explore data model <Icon name="chevron-right" size={16} />
            </a>
            <span className="ui-mono demo-base-url">GET https://demo.instantmockapi.com/v1</span>
          </div>
        </div>
        <div className="demo-hero-orbit" aria-hidden="true">
          <div className="demo-orbit-ring demo-orbit-ring--one" />
          <div className="demo-orbit-ring demo-orbit-ring--two" />
          <div className="demo-orbit-core">
            <Icon name="cube" size={28} />
            <strong>12</strong>
            <span>entities</span>
          </div>
        </div>
      </section>

      <section className="demo-stat-strip" aria-label="Project summary">
        <div>
          <span className="demo-stat-value">12</span>
          <span className="demo-stat-label">Entities</span>
        </div>
        <div>
          <span className="demo-stat-value">14</span>
          <span className="demo-stat-label">Relationships</span>
        </div>
        <div>
          <span className="demo-stat-value">28</span>
          <span className="demo-stat-label">Endpoints</span>
        </div>
        <div>
          <span className="demo-stat-value">7</span>
          <span className="demo-stat-label">Role policies</span>
        </div>
        <div className="demo-stat-highlight">
          <Icon name="globe" size={20} />
          <span>
            <strong>Hosted</strong> demo environment
          </span>
        </div>
      </section>

      <section className="demo-content" id="model">
        <div className="demo-section-intro">
          <span className="demo-eyebrow">01 / Model overview</span>
          <h2>A backend you can reason about.</h2>
          <p>
            Start with the domain map, select an entity, and inspect the fields and connections that
            make the API useful for a real storefront.
          </p>
        </div>
        <RelationshipDiagram selected={selectedEntity} onSelect={setSelectedEntity} />
        <div className="demo-detail-grid">
          <EntityDetails entity={selected} />
          <RelationshipExplorer selected={selectedEntity} />
        </div>
        <div className="demo-guide" aria-label="How the project model works">
          <div>
            <span className="demo-guide-number">01</span>
            <strong>Entities are resources</strong>
            <p>Each card becomes a REST resource with fields, IDs, records, and CRUD endpoints.</p>
          </div>
          <div>
            <span className="demo-guide-number">02</span>
            <strong>Relationships connect resources</strong>
            <p>Choose belongs to, has many, or many to many to make related records navigable.</p>
          </div>
          <div>
            <span className="demo-guide-number">03</span>
            <strong>Delete rules protect data</strong>
            <p>
              <b>Restrict</b> blocks deletion, <b>cascade</b> removes dependents, and{' '}
              <b>set null</b> keeps them without the link.
            </p>
          </div>
        </div>
      </section>

      <section className="demo-content demo-content--endpoints" id="endpoints">
        <div className="demo-section-intro">
          <span className="demo-eyebrow">02 / Request surface</span>
          <h2>Useful responses, ready to inspect.</h2>
          <p>
            These examples show the shape of the API contract your frontend would consume, including
            auth, filtering, includes, and fulfillment workflows.
          </p>
        </div>
        <EndpointExplorer />
        <div className="demo-cta">
          <div>
            <span className="demo-eyebrow">Ready to model yours?</span>
            <h2>Turn this reference into your Project API.</h2>
            <p>
              Start in the builder, define your entities and relationships, then generate the API
              surface.
            </p>
          </div>
          <a className="demo-primary-action" href="/new/project">
            Create a Project API <Icon name="chevron-right" size={16} />
          </a>
        </div>
      </section>

      <footer className="demo-footer">
        <span>
          Instant<span>Mock</span>API
        </span>
        <span>Project API demo · E-commerce reference model</span>
        <a href="/">
          Back to app <Icon name="chevron-right" size={14} />
        </a>
      </footer>
    </main>
  );
}
