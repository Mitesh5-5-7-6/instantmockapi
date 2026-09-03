PHASE 0
Canonical Project Definition
│
▼
PHASE 1 ← WE ARE HERE
Edit + Dependency Graph
│
├── Entity editing
├── Field editing
├── Validation editing
├── Relationship editing
├── API configuration editing
├── Dependency graph
├── Change detection
└── Impact analysis
│
▼
PHASE 2
Versioning + Visual Diff
│
├── Version creation
├── Version history
├── Before/after comparison
├── Rollback
└── Selective regeneration
│
▼
PHASE 3
Authentication
│
├── SignUp
├── SignIn
├── Access token
├── Refresh token
├── Cookie auth
├── Public API
└── Protected API
│
▼
PHASE 4
Technical Notes + Blueprint
│
├── Technical Notes
├── AI-ready documentation
├── Blueprint export
└── Blueprint import
│
▼
PHASE 5
Admin + Plans + Analytics
│
▼
PHASE 6
Recommended V1 architecture
First load is slow, then everything is fast.
┌──────────────────────┐
│ Vercel │
│ React / Next.js │
└──────────┬───────────┘
│
▼
┌──────────────────────┐
│ API / Backend │
│ Render │
└───────┬───────┬──────┘
│ │
┌──────────┘ └───────────┐
▼ ▼
┌─────────────┐ ┌─────────────┐
│ MongoDB │ │ Upstash │
│ Primary │ │ Redis │
│ Database │ │ Cache/Queue │
└─────────────┘ └──────┬──────┘
│
▼
┌─────────────┐
│ Worker │
│ Render │
└─────────────┘
