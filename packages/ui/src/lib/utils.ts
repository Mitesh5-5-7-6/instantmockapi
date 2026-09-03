import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * shadcn's class combiner: `clsx` for conditionals, `tailwind-merge` for
 * conflicts.
 *
 * The `twMerge` half is the part that matters and the part people leave out. It
 * makes the *last* utility win when two set the same property, which is what
 * lets a caller pass `className="px-6"` to a component whose base is `px-4` and
 * actually get 6. Without it both classes land in the DOM and CSS source order —
 * not the caller's intent — decides, so an override works or does not depending
 * on how Tailwind happened to emit the file.
 *
 * Every component here takes `className` last for that reason.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
