# AGENTS.md

This file provides guidance to coding agents (Claude Code, Codex, OpenCode) working with this repository. `.claude/CLAUDE.md` and `.codex/AGENTS.md` are symlinks to this file.

## Architecture

**Four-layer architecture** with adjacent, one-way dependencies:

| Layer | Components | May Import | Must NOT Import |
|-------|------------|------------|-----------------|
| **Presentation** | Components, Hooks, Queries, Mutations, UI States | React, Zod, TanStack Query, Jotai, Controller entry points | Services, Policies, Models, Drizzle, Integrations |
| **Controller** | Actions, Routes, Workflow entry points | Services, the narrow `@/lib/auth` API, and transport utilities | Models, Drizzle, schema tables, Policies, general Integrations, React |
| **Service** | Behavior-named Service classes, Policies | Models, Integrations, validation and transaction utilities | Actions, Routes, React, TanStack Query, Jotai |
| **Infrastructure** | Models, database client/schema, Integrations | Drizzle, external APIs | Presentation, Controllers, Services, Policies |

Layers are responsibilities and import boundaries, not top-level folders. Features
remain organized as vertical slices under `app/[page]/behaviors/[name]/`.

- Controllers authenticate and normally call exactly one Service; they never
  import Models, Drizzle, schema tables, Policies, or general Integrations.
- Authentication-only Controllers for sign-in, sign-up, sign-out, and session
  establishment may call the narrow `@/lib/auth` API directly instead of adding
  a pass-through Service.
- Once an authentication flow includes application-specific business rules,
  authorization over records, Models, or general Integrations, it must delegate
  that behavior to one Service.
- A Service is the former server Behavior class renamed from `.behavior.ts` to
  `.service.ts`. Keep its behavior-named class and public `static execute` method.
- Services own authoritative validation, authorization, business rules, and
  transaction boundaries. Authorized Services call a private
  `static authorize(actor, records)` that delegates to a pure Policy.
- Static Models live in `shared/models`, own all Drizzle queries, and return plain
  schema-inferred records. Models never authenticate or authorize.
- When a behavior requires a Service, the former server Behavior module is now
  that Service module. Test it through `[name].service.test.ts`; do not create a
  parallel `[name].behavior.test.ts`.

**Server state** (lists, records, caching) is owned by **TanStack Query** (`useQuery`/`useMutation`); **Jotai is for UI state only** (dialogs, selections, filter/sort/page inputs). The initial page read and page-wide query-key factory live in `app/[page]/[page-name].query.ts`; additional or on-demand reads may use `[name].query.ts` beside their behavior. Pages prefetch the initial query and hydrate it with `HydrationBoundary`; mutations are optimistic by default. For authenticated user-owned data, every page-wide query key MUST include the actor/user identity so cached data cannot cross identities; this partitions cache data and never replaces server-side authorization.

See `docs/references/architecture.md` for detailed patterns and code examples.

## Project Structure

```
app/
  /(app)/              # Authenticated pages (LOGIN REQUIRED)
  /admin/              # Admin pages (LOGIN + ADMIN ROLE)
  /auth/               # Auth pages (signin, signup, etc.)
  /api/                # API routes
db/                    # Schema + migrations
lib/                   # Utilities, auth, testing libs
shared/                # Models, Integrations, Policies + global utilities
components/ui/         # shadcn/ui components
```

### Behavior Structure

Features are organized by behavior:

```
app/[page]/
  [page-name].query.ts           # Initial page query + page-wide query keys
  behaviors/[behavior-name]/
    [behavior-name].service.ts   # Required for application behavior; omit for auth-only
    [behavior-name].action.ts    # Thin server-action boundary
    use-[behavior-name].hook.ts  # Public React hook
    [behavior-name].query.ts     # Additional/on-demand read options (optional)
    [behavior-name].mutation.ts  # Write mutation options (when applicable)
    routes/
      route.ts                   # Route endpoint (streaming/HTTP semantics)
    state.ts                     # Behavior-specific state (optional)
    tests/
      [behavior-name].service.test.ts # When a Service exists
      [behavior-name].action.test.ts
      use-[behavior-name].hook.test.tsx
      [behavior-name].route.test.ts
```

A behavior has at most one Action, one Route, and one Workflow. They may coexist
when they provide distinct entry-point semantics.

## File Naming

| Type | Pattern |
|------|---------|
| Service classes | `[name].service.ts` |
| Server actions | `[name].action.ts` |
| Routes | `routes/route.ts` |
| React hooks | `use-[name].hook.ts` |
| Initial page query + keys | `[page-name].query.ts` |
| Additional read query | `[name].query.ts` |
| Components | `[Name].tsx` |
| Service tests | `[name].service.test.ts` |
| Hook tests | `use-[name].hook.test.tsx` |
| Action tests | `[name].action.test.ts` |
| Route tests | `[name].route.test.ts` |
| State files | `state.ts` |

## Commands

```bash
# Development
bun run lint             # ESLint

# Database
bun run db:generate      # Generate migrations
bun run db:migrate       # Apply migrations
bun run db:push          # Push schema (dev only)
bun run db:studio        # Visual editor
bun run db:reset         # Clean + push schema
bun run db:squash        # Combine migrations into one

# Testing
bun run test             # All automated tests (Vitest)
```

## Testing

**Philosophy**: Test real code with real database, minimal mocking.

**Rules**:
- Test outcomes instead of implementation details
- Use the in-memory SQLite database for Model, Service, Action, and Hook tests
- Action and Hook tests exercise the real Service and Model path, or the real
  Action -> auth provider -> in-memory SQLite path for authentication-only
  Controllers
- Mock only framework boundaries, unavailable external services, or a
  component's public Hook contract; do not mock the local auth provider when it
  can run against the in-memory database
- Start with ONE test, expand later
- Use PreDB/PostDB for deterministic state

```typescript
// Database test pattern
await PreDB(db, schema, { users: [] });
// ... execute action ...
await PostDB(db, schema, { users: [{ name: 'Alice' }] });
```

## Authentication

**Better Auth** with middleware protection:
- `/(app)/*` and `/admin/*` require authentication
- Config: `lib/auth/index.ts`, Client: `lib/auth/client.ts`
- Server-side: `getUser()` for cached session retrieval
- Sign-in, sign-up, sign-out, and session establishment are Controller-owned and
  may use `@/lib/auth` directly while they remain authentication-only
- Application-specific registration, authorization, persistence, or external
  effects belong in a Service

## Epic CLI

When the user is planning a project, creating/managing issues, or building/reviewing issues with the `epic` command, use the **epic** skill (`epic:epic` during a build; in a session you start yourself, the `epic` skill the CLI keeps in `~/.claude/skills`). If neither is available, the `epic` CLI is not installed on this machine: install it with `bun install -g @epicnew/cli`, then run `epic login` — that also installs the skill. This includes requests like "create a project", "generate a PRD", "break a PRD into issues", "plan an issue", "build an issue", or "review/merge an issue".

PRD and issue content lives in the Epic database. Do not look for, create, or
maintain tracked `.epic/prds/*.md` or `.epic/issues/*.md` files, and do not use
`pull`, `push`, or `sync` commands (they are not part of the current CLI). During
an agent phase, the CLI fetches the content into the exact gitignored session
buffer named in the prompt (normally `.epic/sessions/<ID>/issue.md` or
`.epic/sessions/<ID>/prd.md`), then PATCHes changes back and discards the buffer.
These buffers are pure Markdown, not documents with tracked YAML lifecycle
front matter.

## Workflow Skills

The lifecycle skills that encode this architecture — `prd`, `interview`, `plan`,
`execute`, `verify`, `fix`, `review`, `merge`, `design`, `prototype` and `epic` —
are not files in this repository. They come from `@epicnew/skills`, at the
release line `.epic/skills.lock.json` names, and the tool running a build
delivers them for the length of each phase: the `epic` CLI loads them as a
plugin (`epic:plan`, `epic:execute`, …), and a cloud build writes them into the
sandbox. Nothing is installed into the repo, and `git status` stays clean.

- **prd → build** is the project workflow: write a PRD, break it into issues,
  then build each issue (plan, then execute, then verify).
- **execute** implements an issue layer by layer — models, integrations,
  services, actions, routes, hooks, components, then tests — loading the one
  reference each layer needs from its own `references/`.
- The architecture and the specification format behind them live in the `epic`
  skill's `references/architecture/web.md` and `references/specification/`.

In a session you start yourself, the `epic` skill is the one that loads, and it
carries the architecture and specification references above; the phase skills
are handed to a build, not installed. To move the project to a new release
line, run `epic skill upgrade` and commit the lock.

## Frontend Design

When working on tasks that involve React components or UI, use the **frontend-design** skill at `.agents/skills/frontend-design/SKILL.md` for high-quality, production-grade design output.

## Design System

Before writing any UI code, read `docs/DESIGN.md` — it points to the component inventory (`navigation.ts`) and design tokens (`globals.css`).

**Key rules**:
- Check `components/` subdirectories for existing components before creating new ones
- Use semantic color tokens (`bg-primary`, `text-muted-foreground`) — never hardcode colors
- New shared components must be added to the styleguide

## Package Management

Use **Bun** exclusively: `bun add`, `bun remove`

## Sandbox Environment

The dev server runs on port 8080:
- `http://localhost:8080` — local access via the dev server

**Never run `bun run build`** — the sandbox is for development only.
After making changes, prefer running **`bun run typecheck`** as the final verification step.

## Shell Discipline

- **Always quote file paths in shell commands.** This repo uses route groups and
  dynamic segments — paths contain `(`, `)`, `[`, `]` — and unquoted interpolation
  (e.g. `xargs -I{} sh -c "cat {}"`) breaks with `Syntax error: "(" unexpected`.
  Prefer `bash` over `sh`, and prefer tool-native file reads over shell pipelines.
- **Read selectively, never dump.** Do not `find ... | xargs cat` whole directories
  into context; open the specific files the task names, and use ranged reads
  (`sed -n 'START,ENDp'`) for large files.
- **Never run git commands** unless an explicit Epic CLI review or merge phase
  delegates a narrowly scoped git operation. Review may use read-only diff/log
  commands; merge may use only the exact merge/conflict-resolution commands named
  by that phase. All other repository operations remain owned by the Epic CLI
  harness. Likewise never manage the dev server process; the sandbox supervisor
  owns it.
