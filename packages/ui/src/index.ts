// @instantmockapi/ui — design tokens (styles.css) + shared React components (doc 12).

export { Icon, ICON_NAMES, type IconName, type IconSize, type IconProps } from './icons.js';

export {
  Button,
  type ButtonProps,
  type ButtonVariant,
  type ButtonSize,
  StatusChip,
  type StatusChipProps,
  Card,
  type CardProps,
  Input,
  Select,
  Textarea,
  Checkbox,
  type CheckboxProps,
  Field,
  CodeBlock,
  CodeViewer,
  Modal,
  type ModalProps,
  ProgressBar,
  WorkerRow,
  type WorkerRowProps,
  CountdownBadge,
  formatRemaining,
  EmptyState,
  MethodBadge,
  type ApiMethod,
  Stat,
  type StatProps,
  type Tone,
  IconTile,
  type IconTileProps,
  Avatar,
  type AvatarProps,
  Kbd,
  Tabs,
  type TabItem,
  type TabsProps,
  TabPanel,
  NavTabs,
  type NavTabItem,
  type NavTabsProps,
  type NavTabLinkProps,
  ListRow,
  type ListRowProps,
  SuccessMark,
  FlowScope,
  type Flow,
  Stepper,
  type StepperProps,
  Note,
  Badge,
  SchemaTree,
  type SchemaTreeEntity,
  type SchemaTreeField,
} from './components.js';

// ---------------------------------------------------------------------------
// Feedback: the error and notification vocabulary
// ---------------------------------------------------------------------------
export {
  Toast,
  ToastViewport,
  FormError,
  ErrorState,
  ErrorDetails,
  type FeedbackVariant,
  type ToastProps,
  type ToastViewportProps,
  type FormErrorProps,
  type ErrorStateProps,
  type ErrorDetailsProps,
} from './feedback.js';

// ---------------------------------------------------------------------------
// shadcn components (src/ui/*) — migrated behind this same barrel, so call
// sites never had to change as each one landed.
// ---------------------------------------------------------------------------
export { cn } from './lib/utils.js';

export {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableRow,
  TableHead,
  TableCell,
  TableRowHeader,
  TableCaption,
  tableNumeric,
} from './ui/table.js';
