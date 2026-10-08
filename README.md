# Web Template

A production-ready Next.js application template with authentication, database, and testing built-in.

## Features

- **Next.js 16** with App Router and Turbopack
- **Better Auth** for authentication with session management
- **Drizzle ORM** + SQLite/Turso with migrations
- **Vitest** + Testing Library for testing
- **Tailwind CSS 4** + **shadcn/ui** components
- **Bun** for fast package management

## Getting Started

```bash
# Install dependencies
bun install

# Set up environment
cp .env.example .env
# Edit .env and set BETTER_AUTH_SECRET (min 32 chars)
# Generate with: openssl rand -base64 32

# Initialize database
bun run db:push

# Start development server
bun run dev
```

Open [http://localhost:8080](http://localhost:8080)

## Commands

```bash
# Development
bun run dev              # Start dev server (port 8080)
bun run lint             # ESLint

# Database
bun run db:push          # Push schema (dev only)
bun run db:generate      # Generate migrations
bun run db:migrate       # Apply migrations
bun run db:studio        # Visual editor
bun run db:reset         # Fresh start
bun run db:squash        # Combine migrations into one

# Testing
bun run test             # All automated tests (Vitest)

# UI
bun run shadcn:add [component]   # Add shadcn/ui component
```

## Project Structure

```
app/
  /(app)/              # Authenticated pages
    /[page]/
      [page].query.ts  # Initial page query and page-wide cache keys
      /components/     # Page presentation
      /behaviors/[name]/
        [name].service.ts       # Behavior-named Service
        [name].action.ts        # Controller entry point (when used)
        use-[name].hook.ts      # Presentation entry point
        /routes/route.ts        # HTTP Controller entry point (when used)
        /tests/                 # Colocated scenario tests
  /admin/              # Admin pages
  /auth/               # Auth pages (signin, signup)
  /api/                # API routes
shared/
  /models/             # Static database access and schema-inferred records
  /policies/           # Pure authorization decisions
  /integrations/       # External-system clients
db/
  schema.ts            # Database schema
  migrations/          # SQL migrations
lib/
  auth/                # Auth configuration
  db-test/             # Testing utilities (PreDB/PostDB)
components/ui/         # shadcn/ui components
```

The code is organized vertically by page and behavior. Within that structure,
imports follow four responsibility layers: **Presentation → Controller →
Service → Infrastructure**. A Service is the behavior-named static class that
owns the use case; Models, Policies, and Integrations remain shared where their
responsibilities cross pages.

## Testing

Vitest verifies behaviors at the Model, Policy, Service, Action, hook, and
component boundaries. Service, Action, and hook integration tests use the real
in-memory SQLite database. Component tests use Testing Library to verify the UI
contract.

Use the PreDB/PostDB pattern for deterministic database tests:

```typescript
import { PreDB, PostDB } from '@/lib/db-test';

test('creates user', async () => {
  await PreDB(db, schema, { users: [] });

  await createUser('Alice', 'alice@example.com');

  await PostDB(db, schema, {
    users: [{ name: 'Alice', email: 'alice@example.com' }]
  });
});
```

## Documentation

- `.claude/CLAUDE.md` - Architecture and development guide
- The `epic` skill's `references/architecture/web.md` - Four-layer architecture details
- `lib/db-test/README.md` - Database testing library
