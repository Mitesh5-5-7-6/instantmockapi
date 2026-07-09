# 12 · Design System

← [11 · UI / UX](./11-ui-ux.md) · [Master Index](./README.md) · Next: [13 · Security](./13-security.md)

Tokens live in `packages/ui` and are the only styling source the web app composes from (doc 05). This document defines the tokens; [11 · UI/UX](./11-ui-ux.md) defines where they're used.

**Design thesis.** InstantMockAPI is a *compiler for backends* — the identity leans into that: a workshop/blueprint feel, not a generic dark dashboard. Structure reads like a schematic (hairline dividers, monospace labels for anything machine-derived), and the one place we spend boldness is the **live worker board**, where generation visibly happens. Everything else stays quiet.

---

## 1. Color System

Two themes; **dark is default** (developers live in dark tooling). The accent is a deliberate **blueprint indigo → cyan** pair, chosen over the common single acid-green so status colors (green/amber/red) never collide with the brand accent.

### Dark theme (default)
| Token | Hex | Use |
|---|---|---|
| `--bg` | `#0F1117` | App background (deep ink, slightly blue) |
| `--surface` | `#171A22` | Cards, panels |
| `--surface-raised` | `#1F232D` | Modals, popovers |
| `--border` | `#2A2F3A` | Hairline dividers, card borders |
| `--text` | `#E7EAF0` | Primary text |
| `--text-muted` | `#9AA3B2` | Secondary text, labels |
| `--accent` | `#5B8CFF` | Primary actions, links, active nav (blueprint indigo) |
| `--accent-2` | `#33D6E0` | Progress/active generation glow (cyan) |
| `--accent-contrast` | `#0B0E14` | Text on accent fills |

### Light theme
| Token | Hex | Use |
|---|---|---|
| `--bg` | `#F7F8FA` | App background |
| `--surface` | `#FFFFFF` | Cards |
| `--surface-raised` | `#FFFFFF` + shadow | Modals |
| `--border` | `#E3E6EC` | Dividers |
| `--text` | `#1A1D24` | Primary text |
| `--text-muted` | `#5B6472` | Secondary text |
| `--accent` | `#3366F0` | Primary actions |
| `--accent-2` | `#0FB5C0` | Progress accent |
| `--accent-contrast` | `#FFFFFF` | Text on accent |

### Semantic / status colors (shared, tuned per theme)
These map 1:1 to the status-chip vocabulary and are kept clearly distinct from the indigo/cyan accent:
| Status | Token | Dark hex | Meaning |
|---|---|---|---|
| pending | `--status-pending` | `#6B7280` (gray) | Queued, not started |
| generating | `--status-generating` | `#33D6E0` (cyan, pulsing) | In progress |
| completed / active | `--status-success` | `#3FB950` (green) | Done / live |
| failed | `--status-error` | `#F85149` (red) | Failed — retryable |
| expired | `--status-expired` | `#8B5CF6`→muted `#6E5FA6` | Hosted assets deleted |
| warning | `--status-warning` | `#E3A008` (amber) | Nearing expiry |

## 2. Typography

Deliberate 3-role pairing — not the same families reached for on any dashboard:

| Role | Family | Use |
|---|---|---|
| **Display / UI** | **Inter** (or system sans fallback) | Headings, buttons, body UI. Tight tracking on large sizes. |
| **Mono / data** | **JetBrains Mono** *(alt: Fira Code)* | Everything machine-derived: JSON, schemas, code blocks, URLs, field types, worker ids, version tags. This is the "blueprint" signal — if the system generated it, it's monospace. |
| **Numeric** | Inter tabular-nums | Countdowns and counts, so digits don't jitter as they tick. |

### Type scale (1.25 ratio)
| Token | Size / line | Use |
|---|---|---|
| `--text-xs` | 12 / 16 | Chip labels, meta |
| `--text-sm` | 14 / 20 | Secondary text, table cells |
| `--text-base` | 16 / 24 | Body |
| `--text-lg` | 20 / 28 | Card titles |
| `--text-xl` | 25 / 32 | Section headings |
| `--text-2xl` | 31 / 38 | Page titles |

Weights: 400 (body), 500 (labels/buttons), 600 (headings). Mono uses 400/500 only.

## 3. Spacing

8px base scale; component padding never off-grid:
`--space-1: 4` · `--space-2: 8` · `--space-3: 12` · `--space-4: 16` · `--space-6: 24` · `--space-8: 32` · `--space-12: 48` · `--space-16: 64`.

- Card padding: `--space-6`. Section gaps: `--space-8`/`--space-12`. Field rows in the builder: `--space-3` vertical, indent nested groups by `--space-6` per level.

## 4. Radius & Elevation

- Radius: `--radius-sm: 6` (chips, inputs) · `--radius-md: 10` (cards, buttons) · `--radius-lg: 14` (modals). No fully-square, no pill-everything — 6–14px throughout.
- **Elevation via borders first, shadow second** (fits the schematic feel): dark theme uses `--border` hairlines and a faint inner highlight; light theme adds a soft shadow on raised surfaces only.

## 5. Component Inventory

Shared components in `packages/ui`, all themable via the tokens above:

| Component | Notes |
|---|---|
| **Button** | Variants: primary (accent fill), secondary (border), ghost, danger. Same label persists through its flow (doc 11 voice). |
| **StatusChip** | The canonical status vocabulary (§1). Generating variant pulses with `--accent-2`. Used identically on dashboard, progress board, and artifact grid. |
| **Card** | Surface + hairline border + `--radius-md`. Project card, artifact card, hosted-API card. |
| **Input / Select / Toggle** | Form controls for the Schema Builder and Configure step. |
| **ValidationPopover** | Layer-2 rule editor (min/max/regex/enum/message). |
| **SchemaTree** | Collapsible entity→field→nested tree; nested groups indent by `--space-6`; type labels in mono. Powers Builder + Review. |
| **CodeBlock** | Mono, syntax-highlighted, one-tap copy with confirmation. Used in artifact View modals + playground responses. |
| **Modal / Drawer** | Raised surface, `--radius-lg`; artifact View, Regenerate, version restore. |
| **Toast** | Non-blocking; action-consistent copy ("Generated", "Copied", "Restored to v1"). |
| **ProgressBar + WorkerRow** | The signature surface — see §6. |
| **CountdownBadge** | Tabular-nums; turns `--status-warning` amber as expiry nears. |

## 6. Signature Element — the Worker Board

The one place the design is loud (spend boldness here, keep the rest quiet):

- Each **WorkerRow** animates its status chip pending→generating→completed; the generating state emits a soft cyan (`--accent-2`) pulse so the page reads as *actively compiling*.
- Dependency waits render honestly ("Waiting on Mock Data") rather than a fake spinner.
- The overall **ProgressBar** fills in the accent as tasks settle.
- Motion respects `prefers-reduced-motion`: pulses become static state changes, no essential information conveyed by motion alone.

## 7. Iconography & Illustration

- Line icons (consistent 1.5px stroke) matching the hairline aesthetic; avoid filled/heavy icon sets.
- Empty states use light schematic line illustrations (a blueprint of an empty entity), reinforcing the compiler thesis without cartoonishness.

## 8. Motion

- Standard transitions 150–250ms, ease-out; hovers/focus 120ms.
- Orchestrated moment: the worker board's staggered completion. Everywhere else, motion is minimal — restraint keeps it from reading as generic/AI-templated.
- Always honor reduced-motion.

## 9. Accessibility Baseline

- WCAG-AA contrast in both themes (status colors verified against `--surface`).
- Visible keyboard focus rings (accent, 2px) on every interactive element.
- Chips never rely on color alone — each pairs an icon/label with its color.
- Hit targets ≥ 40px on touch.

---

Next: [13 · Security →](./13-security.md)
