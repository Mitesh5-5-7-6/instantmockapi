'use client';

/**
 * "Add photo" for an AI prompt: up to three images, shown as thumbnails with a
 * remove button each. Files are shrunk in the browser before they are kept, so
 * what the thumbnail shows is exactly what will be sent.
 */

import { useRef, useState } from 'react';
import { Button, Icon } from '@instantmockapi/ui';
import {
  MAX_PROMPT_IMAGES,
  PROMPT_IMAGE_ACCEPT,
  acceptsFile,
  roomFor,
  shrinkImage,
  type PromptImageUpload,
} from '../lib/prompt-images';

export function ImageAttach({
  images,
  onChange,
  disabled,
}: {
  images: PromptImageUpload[];
  onChange: (next: PromptImageUpload[]) => void;
  disabled?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const add = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setProblem(null);
    const all = Array.from(files);
    const usable = all.filter(acceptsFile);
    const room = roomFor(images.length, usable.length);
    const notes: string[] = [];
    if (usable.length < all.length) notes.push('Only PNG, JPEG and WebP images can be added.');
    if (room < usable.length) notes.push(`You can attach up to ${MAX_PROMPT_IMAGES} images.`);
    setBusy(true);
    try {
      const shrunk = await Promise.all(usable.slice(0, room).map(shrinkImage));
      onChange([...images, ...shrunk]);
    } catch {
      notes.push('One of the images could not be read. Try another file.');
    } finally {
      setBusy(false);
      setProblem(notes.length > 0 ? notes.join(' ') : null);
      // Cleared so choosing the same file again still fires a change.
      if (input.current) input.current.value = '';
    }
  };

  return (
    <div className="ui-stack ui-stack--tight">
      <div className="ui-row" style={{ gap: 'var(--space-2)', flexWrap: 'wrap' }}>
        {images.map((image, index) => (
          <figure key={`${image.name}-${index}`} className="ui-thumb">
            <img src={image.previewUrl} alt={image.name} />
            <button
              type="button"
              className="ui-thumb__remove"
              aria-label={`Remove ${image.name}`}
              disabled={disabled}
              onClick={() => onChange(images.filter((_, other) => other !== index))}
            >
              <Icon name="x" size={14} />
            </button>
          </figure>
        ))}
        {images.length < MAX_PROMPT_IMAGES ? (
          <>
            <input
              ref={input}
              type="file"
              accept={PROMPT_IMAGE_ACCEPT}
              multiple
              hidden
              onChange={(event) => void add(event.target.files)}
            />
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={disabled || busy}
              onClick={() => input.current?.click()}
            >
              <Icon name="cloud-upload" size={16} /> {busy ? 'Preparing…' : 'Add photo'}
            </Button>
          </>
        ) : null}
        <span className="ui-meta">
          A sketch, diagram or screenshot of your data, up to {MAX_PROMPT_IMAGES}.
        </span>
      </div>
      {problem ? (
        <span className="ui-meta" role="status">
          {problem}
        </span>
      ) : null}
    </div>
  );
}
