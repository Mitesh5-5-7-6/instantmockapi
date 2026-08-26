'use client';

/**
 * Quick Start tiles.
 *
 * Every tile goes somewhere that exists today. The design's fourth tile is "Make
 * Request", which in this product means opening a generated project's playground
 * — there is no standalone request composer — so it points at the project list
 * rather than at a screen that would have to be invented.
 */

import Link from 'next/link';
import { Card, IconTile, type IconName, type Tone } from '@instantmockapi/ui';

interface QuickStartTile {
  href: string;
  icon: IconName;
  tone: Tone;
  title: string;
  description: string;
}

const TILES: QuickStartTile[] = [
  {
    href: '/new/project',
    icon: 'plus',
    tone: 'violet',
    title: 'New Project',
    description: 'Model several entities and the relationships between them',
  },
  {
    href: '/new/single',
    icon: 'cloud-upload',
    tone: 'cyan',
    title: 'Import a spec',
    description: 'Paste JSON or an OpenAPI document to start from',
  },
  {
    href: '/templates',
    icon: 'code',
    tone: 'warning',
    title: 'Use a template',
    description: 'Begin from a ready-made schema',
  },
  {
    href: '/projects',
    icon: 'play',
    tone: 'success',
    title: 'Try an API',
    description: 'Open a project and call its hosted endpoints',
  },
];

export function QuickStartCard() {
  return (
    <Card className="ui-stack">
      <h2>Quick Start</h2>
      <div className="ui-grid-cards">
        {TILES.map((tile) => (
          <Link key={tile.href} href={tile.href} style={{ textDecoration: 'none' }}>
            <Card interactive className="ui-stack">
              <IconTile icon={tile.icon} tone={tile.tone} size="lg" />
              <div className="ui-stack" style={{ gap: 'var(--space-1)' }}>
                <strong>{tile.title}</strong>
                <span className="ui-meta">{tile.description}</span>
              </div>
            </Card>
          </Link>
        ))}
      </div>
    </Card>
  );
}
