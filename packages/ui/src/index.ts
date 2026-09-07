// @instantmockapi/ui — design tokens (styles.css) + shared React components (doc 12).
//
// Every component now follows shadcn's conventions: Tailwind utilities, `cva`
// for real variants, and `cn()` so a caller's `className` beats a variant's.
// The implementations live in `src/ui/*`; this barrel and `components.tsx` are
// the stable surface the ~90 importing files see, which is what let the
// migration land one component at a time.

export { Icon, ICON_NAMES, type IconName, type IconSize, type IconProps } from './icons.js';

export { cn } from './lib/utils.js';

export {
  /* controls */
  Button,
  buttonVariants,
  type ButtonProps,
  type ButtonVariant,
  type ButtonSize,
  Input,
  Select,
  Textarea,
  Checkbox,
  type CheckboxProps,
  Field,
  type FieldProps,
  FieldError,
  /* containers */
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
  type CardProps,
  Modal,
  type ModalProps,
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
  Note,
  type NoteVariant,
  Alert,
  AlertTitle,
  AlertDescription,
  EmptyState,
  EMPTY_STATE,
  /* labels */
  Badge,
  badgeVariants,
  type BadgeVariant,
  StatusChip,
  type StatusChipProps,
  MethodBadge,
  type ApiMethod,
  Kbd,
  Avatar,
  type AvatarProps,
  IconTile,
  type IconTileProps,
  SuccessMark,
  TONES,
  type Tone,
  type ToneClasses,
  /* rows, figures, progress */
  ProgressBar,
  WorkerRow,
  type WorkerRowProps,
  ListRow,
  type ListRowProps,
  CountdownBadge,
  formatRemaining,
  Stat,
  type StatProps,
  /* navigation */
  Tabs,
  type TabItem,
  type TabsProps,
  TabPanel,
  NavTabs,
  type NavTabItem,
  type NavTabsProps,
  type NavTabLinkProps,
  Stepper,
  type StepperProps,
  FlowScope,
  type Flow,
  /* code and schema */
  CodeBlock,
  CodeViewer,
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
// Table: composable primitives, so each of the product's tables supplies its
// own cells rather than being driven by a column config.
// ---------------------------------------------------------------------------
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
