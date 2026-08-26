'use client';

/**
 * Footer strip below the main content.
 *
 * The mockup's tip describes Environments, which do not exist in this product —
 * a tip about a feature nobody can use is doubly wrong — so this points at
 * Templates, which does. The mockup's Documentation and Support links are
 * likewise omitted: there are no URLs to give them, and a link to nowhere is
 * worse than no link. They belong here the moment real destinations exist.
 */

import Link from 'next/link';
import { Icon } from '@instantmockapi/ui';

export function AppFooter() {
  return (
    <footer className="ui-footer">
      <span className="ui-row" style={{ gap: 'var(--space-2)', alignItems: 'center' }}>
        <Icon name="lightbulb" size={16} />
        <span className="ui-meta">
          <strong>Pro tip:</strong> start from a template to see a working mock API in under a
          minute.
        </span>
      </span>
      <Link href="/templates" className="ui-meta">
        Browse templates
      </Link>
    </footer>
  );
}
