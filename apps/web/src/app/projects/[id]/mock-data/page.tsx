'use client';

/**
 * The Mock Data tab: query the hosted API against its seeded records.
 *
 * The playground was buried inside the hosted-API card on the old page, below the
 * artifact grid. It is the fastest way to confirm a generated API actually works,
 * so it gets a tab of its own.
 */

import { useParams } from 'next/navigation';
import { Card, EmptyState, Stat } from '@instantmockapi/ui';
import { useProject } from '../../../../lib/hooks';
import { HostedPlayground } from '../../../../components/hosted-playground';

export default function MockDataPage() {
  const { id } = useParams<{ id: string }>();
  const project = useProject(id);

  if (!project.data) {
    return <div className="ui-skeleton" />;
  }

  const detail = project.data;
  const hostedUrl = detail.hosted.url;

  // Entity path is `name.toLowerCase()`, mirroring generator-hosting's
  // generateHostingConfig — so the playground hits the routes the runtime serves.
  const entities = ((detail.ips as { entities?: { name: string }[] })?.entities ?? []).map(
    (entity) => ({ name: entity.name, path: entity.name.toLowerCase() }),
  );

  if (!hostedUrl) {
    return (
      <Card>
        <EmptyState title="Nothing hosted yet">
          Generate this project to bring its mock API up, then query it here.
        </EmptyState>
      </Card>
    );
  }

  return (
    <div className="ui-stack">
      <Card className="ui-stack">
        <div>
          <h2>Mock data</h2>
          <p className="ui-meta">
            Records are seeded at generation time and persist until the project is regenerated.
            Writes you make here change the hosted data.
          </p>
        </div>
        <div className="ui-stats">
          <Stat value={entities.length} label="Entities" />
          {/* The configured count, not a live one — the seeded record totals live
              in the mock store and are not served by any endpoint today. Labelled
              "per entity" so it cannot be read as a total. */}
          <Stat value={detail.generationConfig.mockRecords} label="Records per entity" />
        </div>
      </Card>

      <HostedPlayground
        baseUrl={hostedUrl}
        entities={entities}
        methods={detail.generationConfig.methods}
      />
    </div>
  );
}
