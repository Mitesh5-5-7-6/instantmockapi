'use client';

/**
 * Choose which kind of API to create.
 *
 * The three flows differ in more than styling: a Project models several
 * entities and the relationships between them, a Single API is one focused
 * surface, and an Auth API is the sign-up/sign-in flow on its own with no
 * entities at all. That choice sets `kind`, which decides the hosted URL prefix
 * (`prj_` / `sng_` / `aut_`) and cannot be changed afterwards — so it is asked
 * once, up front, rather than inferred from what the author happens to build.
 */

import Link from 'next/link';
import { Button, Card, Icon } from '@instantmockapi/ui';

const CHOICES = [
  {
    href: '/new/ai',
    flow: 'ai' as const,
    title: 'Describe it',
    tagline: 'Natural-language project creation',
    points: [
      'Describe the API you want in plain English',
      'The app proposes entities, fields and relations',
      'The generated blueprint still passes through the same validation pipeline',
    ],
  },
  {
    href: '/new/project',
    flow: 'project' as const,
    title: 'Project API',
    tagline: 'Multiple entities with relationships',
    points: [
      'Design a data model and relate entities to each other',
      'Foreign keys and ?include= expansion derived for you',
      'Search, filter, sort and pagination across every entity',
    ],
  },
  {
    href: '/new/single',
    flow: 'single' as const,
    title: 'Single API',
    tagline: 'One focused API',
    points: [
      'Paste JSON, import a Swagger spec, or build a schema by hand',
      'Validators, types and mock data for one resource',
      'The fastest path to a hosted endpoint',
    ],
  },
  {
    href: '/new/auth',
    flow: 'auth' as const,
    title: 'Auth API',
    tagline: 'Sign-up and sign-in, nothing else',
    // Written for someone deciding between the three, so it says what this one
    // is *for* rather than listing its endpoints — the wizard shows those.
    points: [
      'A working login flow to build a front end against',
      'Real accounts, real tokens, real 401s',
      'No data model to design first',
    ],
  },
];

export default function NewPage() {
  return (
    <div className="ui-stack" style={{ gap: 'var(--space-6)' }}>
      <div className="ui-stack" style={{ gap: 'var(--space-2)' }}>
        <h1>What are you building?</h1>
        <p className="ui-meta">This sets how the API is addressed and cannot be changed later.</p>
      </div>

      <div
        className="ui-row"
        style={{ alignItems: 'stretch', gap: 'var(--space-4)', flexWrap: 'wrap' }}
      >
        {CHOICES.map((choice) => (
          <div key={choice.href} data-flow={choice.flow} style={{ flex: '1 1 320px' }}>
            <Link href={choice.href} style={{ textDecoration: 'none', color: 'inherit' }}>
              <Card interactive className="ui-stack">
                <div className="ui-stack" style={{ gap: 'var(--space-1)' }}>
                  <h2 style={{ color: 'var(--accent)' }}>{choice.title}</h2>
                  <span className="ui-meta">{choice.tagline}</span>
                </div>
                <ul className="ui-stack" style={{ gap: 'var(--space-2)', paddingLeft: '1.1em' }}>
                  {choice.points.map((point) => (
                    <li key={point} className="ui-meta">
                      {point}
                    </li>
                  ))}
                </ul>
              </Card>
            </Link>
          </div>
        ))}
      </div>

      {/*
       * Importing is not a fourth kind.
       *
       * The three cards answer "what are you building", and that answer sets
       * `kind` permanently. A blueprint has already answered it — the file
       * decides the kind — so this is a different sort of action and sits below
       * the choice rather than inside it.
       */}
      <Card className="ui-stack">
        <div className="ui-stack" style={{ gap: 'var(--space-1)' }}>
          <h2 style={{ margin: 0 }}>Already have a blueprint?</h2>
          <span className="ui-meta">
            A blueprint is the JSON file you can export from any project&rsquo;s Docs tab. It holds
            the whole definition — entities, relationships, authentication and generation settings —
            so importing one recreates the project in a couple of minutes. Useful when a hosted API
            has expired, when moving a project between accounts, or when someone sends you theirs.
          </span>
        </div>
        <div className="ui-row">
          <Link href="/new/import" style={{ textDecoration: 'none' }}>
            <Button variant="secondary">
              <Icon name="cloud-upload" size={16} /> Import a blueprint
            </Button>
          </Link>
        </div>
      </Card>
    </div>
  );
}
