/**
 * Shared components (doc 12 §5).
 *
 * ## This file is now a re-export surface, not an implementation
 *
 * Every component moved to `./ui/*`, ported to shadcn's conventions: Tailwind
 * utilities instead of `.ui-*` class names, `cva` where a component has real
 * variants, `cn()` (= `twMerge(clsx(…))`) everywhere so a caller's `className`
 * can override a variant's utility rather than depending on CSS source order.
 *
 * The re-exports stay because roughly ninety files import from this module by
 * name. Keeping the barrel meant the migration landed component by component
 * with a green suite at each step, instead of as one commit that touches every
 * screen — and it means `Card`, `Modal`, `Field` and the rest kept their
 * existing signatures rather than being rewritten to shadcn's composition API
 * at sixty call sites.
 *
 * `FlowScope` is the only thing still defined here; see its own note.
 */

import type { ReactNode } from 'react';

/* ── Buttons and controls ── */

export {
  Button,
  buttonVariants,
  type ButtonProps,
  type ButtonVariant,
  type ButtonSize,
} from './ui/button.js';

export { Input, Select, Textarea, Checkbox, Field } from './ui/input.js';
export type { CheckboxProps, FieldProps } from './ui/input.js';

/* ── Containers ── */

export {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from './ui/card.js';
export type { CardProps } from './ui/card.js';

export {
  Modal,
  Dialog,
  DialogTrigger,
  DialogPortal,
  DialogClose,
  DialogOverlay,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from './ui/dialog.js';
export type { ModalProps } from './ui/dialog.js';

export {
  Note,
  Alert,
  AlertTitle,
  AlertDescription,
  EmptyState,
  EMPTY_STATE,
  type NoteVariant,
} from './ui/alert.js';

/* ── Labels ── */

export {
  Badge,
  badgeVariants,
  type BadgeVariant,
  StatusChip,
  type StatusChipProps,
  MethodBadge,
  type ApiMethod,
} from './ui/badge.js';

export { Kbd, Avatar, type AvatarProps, IconTile, type IconTileProps } from './ui/avatar.js';
export { SuccessMark } from './ui/avatar.js';
export { TONES, type Tone, type ToneClasses } from './ui/tone.js';

/* ── Rows, figures and progress ── */

export {
  ProgressBar,
  WorkerRow,
  type WorkerRowProps,
  ListRow,
  type ListRowProps,
  CountdownBadge,
  formatRemaining,
} from './ui/list-row.js';

export { Stat, type StatProps } from './ui/stat.js';

/* ── Navigation ── */

export {
  Tabs,
  type TabItem,
  type TabsProps,
  TabPanel,
  NavTabs,
  type NavTabItem,
  type NavTabsProps,
  type NavTabLinkProps,
} from './ui/tabs.js';

export { Stepper, type StepperProps } from './ui/stepper.js';

/* ── Code and schema ── */

export { CodeBlock, CodeViewer } from './ui/code-block.js';
export { SchemaTree, type SchemaTreeEntity, type SchemaTreeField } from './ui/schema-tree.js';

/* ── FlowScope ── */

export type Flow = 'project' | 'single';

/**
 * Marks which creation flow a subtree belongs to.
 *
 * **The attribute currently does nothing visual.** It was introduced to
 * re-point the accent token per flow — the idea being that the whole palette
 * hangs off one variable, so scoping it here would recolour buttons, tabs,
 * focus rings, the stepper and the diagram at once. No CSS rule anywhere
 * matches `[data-flow]`, so both flows render identically and always have.
 *
 * Kept rather than deleted because it is the seam a per-flow accent would need,
 * and it costs one `div` that is doing the layout work regardless. The
 * behaviour is documented as absent so the next reader does not go looking for
 * a colour that was never there.
 */
export function FlowScope({ flow, children }: { flow: Flow; children: ReactNode }) {
  return (
    <div data-flow={flow} className="flex flex-col gap-6">
      {children}
    </div>
  );
}
