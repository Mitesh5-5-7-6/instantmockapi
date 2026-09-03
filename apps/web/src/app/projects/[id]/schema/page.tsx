'use client';

/**
 * The Schema tab.
 *
 * Was a modal on the old page, behind a "View schema" button. A modal is the wrong
 * container for a reference document: it cannot be linked to, cannot be kept open
 * beside the endpoint list, and closes on a stray Escape while you are reading it.
 *
 * ## Two columns, because the schema tree is narrow
 *
 * A field list is intrinsically about 500px wide — a name and a type. Rendered
 * alone in the workspace's 1440px measure it is a tall thin ribbon with a screen
 * of empty space beside it. The right column carries what a reader of a schema
 * actually wants next to it: how much surface it produces, what the hosted API
 * accepts, and the way in to changing it.
 */

import { useParams } from 'next/navigation';
import Link from 'next/link';
import {
  Card,
  EmptyState,
  Icon,
  Note,
  SchemaTree,
  type SchemaTreeEntity,
} from '@instantmockapi/ui';
import { countEndpoints, type IpsEntity } from '../../../../lib/endpoints';
import { useProject } from '../../../../lib/hooks';

/** Every field, nested leaves included — what the schema actually describes. */
function countFields(entities: readonly SchemaTreeEntity[]): number {
  const walk = (fields: readonly { children?: unknown }[] | undefined): number => {
    if (!Array.isArray(fields)) {
      return 0;
    }
    return fields.reduce(
      (total, field) => total + 1 + walk(field.children as { children?: unknown }[] | undefined),
      0,
    );
  };
  return entities.reduce((total, entity) => total + walk(entity.fields), 0);
}

function Figure({ value, label }: { value: number | string; label: string }) {
  return (
    <div className="schema-figure">
      <strong>{value}</strong>
      <span className="ui-meta">{label}</span>
    </div>
  );
}

export default function SchemaPage() {
  const { id } = useParams<{ id: string }>();
  const project = useProject(id);

  if (!project.data) {
    return <div className="ui-skeleton" />;
  }

  const detail = project.data;
  // `ips` is `unknown` on the wire because the API serializes the stored document
  // as-is; every consumer narrows it at the edge like this.
  const entities = (detail.ips as { entities?: SchemaTreeEntity[] })?.entities ?? [];
  const methods = detail.generationConfig.methods;
  const features = detail.generationConfig.features;
  const enabledFeatures = Object.entries(features ?? {})
    .filter(([, on]) => on === true)
    .map(([name]) => name);

  if (entities.length === 0) {
    return (
      <Card className="ui-stack">
        <h2>Schema</h2>
        <EmptyState title="No entities yet">
          <p className="ui-meta">
            Parse an input source or use the editor to define this project&rsquo;s data model.
          </p>
          <Link className="ui-btn ui-btn--primary" href={`/projects/${id}/edit`}>
            <Icon name="layers" size={16} /> Edit data model
          </Link>
        </EmptyState>
      </Card>
    );
  }

  return (
    <div className="schema-layout">
      <Card className="ui-stack">
        <div>
          <h2>Schema</h2>
          <p className="ui-meta">
            The internal project schema every generator reads. Entities become API resources; fields
            define each record&rsquo;s shape.
          </p>
        </div>
        <SchemaTree entities={entities} />
      </Card>

      <div className="ui-stack schema-aside">
        <Card className="ui-stack ui-stack--tight">
          <h3>Edit this model</h3>
          {/*
            The flow spelled out where the button is. Users have been trained by
            other tools to expect a schema edit to take effect the moment they
            save, and the whole design of this feature is that it does not.
          */}
          <p className="ui-meta">
            Editing opens a draft. Nothing reaches your live API until you review what the change
            affects and commit it — so you can change your mind at any point before then.
          </p>
          <Link className="ui-btn ui-btn--primary" href={`/projects/${id}/edit`}>
            <Icon name="layers" size={16} /> Edit data model
          </Link>
        </Card>

        <Card className="ui-stack ui-stack--tight">
          <h3>What this produces</h3>
          <div className="schema-figures">
            <Figure value={entities.length} label={entities.length === 1 ? 'entity' : 'entities'} />
            <Figure value={countFields(entities)} label="fields" />
            <Figure
              value={countEndpoints(entities as unknown as IpsEntity[], methods)}
              label="endpoints"
            />
          </div>
        </Card>

        <Card className="ui-stack ui-stack--tight">
          <h3>Hosted API accepts</h3>
          <div className="ui-row" style={{ flexWrap: 'wrap', gap: 'var(--space-2)' }}>
            {methods.length > 0 ? (
              methods.map((method) => (
                <span key={method} className={`ui-method ui-method--${method}`}>
                  {method}
                </span>
              ))
            ) : (
              <span className="ui-meta">No methods selected.</span>
            )}
          </div>
          <p className="ui-meta">
            {enabledFeatures.length > 0
              ? `Query: ${enabledFeatures.join(' · ')}`
              : 'No query parameters are enabled.'}
          </p>
        </Card>

        {/*
          A rename moves every URL, and the Schema tab is where someone stands
          when they are about to do it. Saying so here is cheaper than saying it
          in a dialog after the fact.
        */}
        <Note>
          An entity&rsquo;s name is its URL segment, so renaming one moves its endpoints. The review
          step spells out exactly which.
        </Note>
      </div>
    </div>
  );
}
