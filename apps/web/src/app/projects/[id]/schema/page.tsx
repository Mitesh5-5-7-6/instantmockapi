'use client';

/**
 * The Schema tab.
 *
 * Was a modal on the old page, behind a "View schema" button. A modal is the wrong
 * container for a reference document: it cannot be linked to, cannot be kept open
 * beside the endpoint list, and closes on a stray Escape while you are reading it.
 */

import { useParams } from 'next/navigation';
import Link from 'next/link';
import { Card, EmptyState, Icon, SchemaTree, type SchemaTreeEntity } from '@instantmockapi/ui';
import { useProject } from '../../../../lib/hooks';

export default function SchemaPage() {
  const { id } = useParams<{ id: string }>();
  const project = useProject(id);

  if (!project.data) {
    return <div className="ui-skeleton" />;
  }

  // `ips` is `unknown` on the wire because the API serializes the stored document
  // as-is; every consumer narrows it at the edge like this.
  const entities = (project.data.ips as { entities?: SchemaTreeEntity[] })?.entities ?? [];

  return (
    <Card className="ui-stack">
      <div className="ui-row ui-row--between">
        <div>
          <h2>Schema</h2>
          <p className="ui-meta">
            The internal project schema every generator reads. Entities become API resources; fields
            define each record&rsquo;s shape.
          </p>
        </div>
        {/*
          The only way into the editor. Editing opens a draft; this view stays a
          read-only picture of what is actually generated, so the two can be held
          side by side while a change is being reasoned about.
        */}
        <Link className="ui-btn" href={`/projects/${id}/edit`}>
          Edit data model <Icon name="chevron-right" size={16} />
        </Link>
      </div>
      {entities.length === 0 ? (
        <EmptyState title="No entities yet">
          Parse an input source or use the editor to define this project&rsquo;s data model.
        </EmptyState>
      ) : (
        <SchemaTree entities={entities} />
      )}
    </Card>
  );
}
