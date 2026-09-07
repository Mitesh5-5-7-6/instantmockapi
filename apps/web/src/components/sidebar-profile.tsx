'use client';

/**
 * Profile block at the very bottom of the sidebar.
 *
 * Sign out is a **visible button**, not an item inside a dropdown. The design
 * puts it behind a chevron menu, but the `Menu` primitive is deliberately not
 * built yet — hiding the only way to sign out behind a control that does not
 * exist would strand people. It moves into the menu when that ships.
 */

import { Avatar, Button } from '@instantmockapi/ui';
import { avatarFor } from '../lib/avatar';
import { useLogout, useMe } from '../lib/hooks';

export function SidebarProfile() {
  const me = useMe();
  const logout = useLogout();

  if (!me.data) {
    return null;
  }

  const display = me.data.name ?? me.data.email;
  // Seeded on the user id so the colour survives a rename.
  const { initials, tone } = avatarFor(display, me.data.id);

  return (
    <div className="ui-stack" style={{ gap: 'var(--space-2)' }}>
      <div className="ui-row" style={{ gap: 'var(--space-2)', alignItems: 'center' }}>
        <Avatar initials={initials} tone={tone} size="md" online label={display} />
        <span className="ui-sidebar__collapsible min-w-0 flex-auto">
          <span className="block truncate text-foreground">{display}</span>
          {/* Only shown when it is not already the title, so an account with no
              display name does not render its email twice. */}
          {me.data.name ? (
            <span className="block truncate text-xs text-muted-foreground">{me.data.email}</span>
          ) : null}
        </span>
      </div>
      <Button variant="ghost" size="sm" disabled={logout.isPending} onClick={() => logout.mutate()}>
        Sign out
      </Button>
    </div>
  );
}
