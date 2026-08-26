'use client';

/**
 * Project search in the top bar.
 *
 * Genuinely wired: `GET /v1/projects` already accepts `?q=` (regex-escaped
 * server-side), and `/projects` reads that param — so submitting here really
 * filters. The placeholder says "Search projects" rather than the mockup's
 * "Search projects, APIs…" because there is no endpoint-level search behind it,
 * and promising one would be the decorative kind of control worth avoiding.
 *
 * ⌘K is ~10 lines rather than a shortcut library: one document listener, one
 * ref.
 */

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Icon, Kbd } from '@instantmockapi/ui';

export function TopSearch() {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState('');
  // Rendered after mount only: the modifier differs per platform, and guessing
  // during SSR would hydrate mismatched.
  const [modifier, setModifier] = useState('');

  useEffect(() => {
    setModifier(/mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent) ? '⌘' : 'Ctrl');

    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        input.current?.focus();
        input.current?.select();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <form
      className="ui-search"
      role="search"
      onSubmit={(event) => {
        event.preventDefault();
        const query = value.trim();
        router.push(query ? `/projects?q=${encodeURIComponent(query)}` : '/projects');
      }}
    >
      <Icon name="search" size={16} />
      <input
        ref={input}
        className="ui-search__input"
        type="search"
        placeholder="Search projects"
        aria-label="Search projects"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            setValue('');
            input.current?.blur();
          }
        }}
      />
      {modifier ? <Kbd>{modifier}K</Kbd> : null}
    </form>
  );
}
