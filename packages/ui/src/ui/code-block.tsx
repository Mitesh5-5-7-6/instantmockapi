'use client';

/**
 * CodeBlock and CodeViewer — a scrollable code panel with one-tap copy, and the
 * multi-file tab strip over it.
 *
 * Syntax highlighting is out of scope for V1 (doc 11 §11): monospace plus copy.
 */

import { useEffect, useState } from 'react';

import { cn } from '../lib/utils.js';
import { Button } from './button.js';

export function CodeBlock({
  code,
  maxHeight,
  className,
}: {
  code: string;
  maxHeight?: number;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) {
      return;
    }
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <div
      className={cn(
        'relative overflow-auto rounded-[var(--radius-md)] border border-border',
        // The page's own black, not the card grey: code should read as a well in
        // the surface it sits on.
        'bg-background',
        className,
      )}
      style={maxHeight ? { maxHeight } : undefined}
    >
      <div className="absolute top-2 right-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            void navigator.clipboard.writeText(code).then(() => setCopied(true));
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <pre className="m-0 p-4 font-mono text-xs/[1.6]">{code}</pre>
    </div>
  );
}

/**
 * Multi-file code viewer: file tabs (when a bundle has more than one file), a
 * filename label, and the active file's contents in a copy-enabled CodeBlock.
 * Single-file artifacts collapse to a label plus one block.
 */
export function CodeViewer({
  files,
  onDownload,
  downloadLabel = 'Download',
}: {
  files: Record<string, string> | undefined;
  /**
   * Receives the file the viewer is currently showing.
   *
   * Both arguments are load-bearing: a bundle artifact holds several files, so a
   * download handler that isn't told which tab is active cannot save the right
   * one. Wiring this straight to `onClick` would instead hand the callback
   * React's MouseEvent as its first argument.
   */
  onDownload?: (filename: string, code: string) => void;
  downloadLabel?: string;
}) {
  const names = files ? Object.keys(files) : [];
  const [active, setActive] = useState(names[0] ?? '');
  const key = names.join('|');
  useEffect(() => {
    setActive(names[0] ?? '');
  }, [key]);

  if (!files || names.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        {names.length > 1 ? (
          <div className="flex flex-wrap items-center gap-1">
            {names.map((name) => (
              <Button
                key={name}
                variant={name === active ? 'secondary' : 'ghost'}
                size="sm"
                aria-selected={name === active}
                onClick={() => setActive(name)}
              >
                {name}
              </Button>
            ))}
          </div>
        ) : (
          <span className="font-mono text-xs text-muted-foreground">{names[0]}</span>
        )}
        {onDownload ? (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => onDownload(active, files[active] ?? '')}
          >
            {downloadLabel}
          </Button>
        ) : null}
      </div>
      <CodeBlock code={active ? (files[active] ?? '') : ''} maxHeight={520} />
    </div>
  );
}
