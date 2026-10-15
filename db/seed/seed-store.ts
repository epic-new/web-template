import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Per-database storage for generated seed credentials.
 *
 * Standalone on purpose (no auth/db imports): `user.seed.ts` re-exports from
 * here and is imported by Playwright setup files — pulling the Better Auth
 * instance into the test runner's import chain would be a side-effectful
 * mistake.
 *
 * One JSON per database (keyed off DATABASE_URL) instead of the old single
 * shared `user.seed.ts`: the same email gets a different generated id in each
 * database (development.db vs test.db), so a single file always lied about
 * one of them — stale ids orphaned tests' PreDB rows whenever the "other"
 * environment reseeded last.
 */
export type UserSeed = {
  email: string;
  password: string;
  name: string;
  userId: string;
  /**
   * The user's role in the admin plugin. The first seeded user is the admin,
   * so a signed-in check (verify, a page preview) can reach admin-only pages;
   * a seed file written before roles has none, and the next seed gives them.
   */
  role?: "admin" | "user";
};

// process.cwd()-based, NOT import.meta.dir: `import.meta.dir` is a Bun-only
// API and this module is also loaded by Playwright under NODE (every spec
// imports user.seed.ts -> here), where it crashed the whole spec run at
// module load. Seed and specs always run from the repo root (bun run /
// playwright.config.ts live there), so cwd-relative is stable.
const CREDENTIALS_DIR = join(process.cwd(), "db", "seed", ".credentials");

/** DATABASE_URL → stable per-database key (`test`, `development`, …). */
export function seedDbKey(
  databaseUrl: string = process.env.DATABASE_URL ?? "",
): string {
  const base = databaseUrl.split("/").pop() ?? "";
  const name = base.replace(/\.db.*$/, "").replace(/[^a-zA-Z0-9_-]/g, "");
  return name || "development";
}

export function seedFilePath(key: string = seedDbKey()): string {
  return join(CREDENTIALS_DIR, `user-seeds.${key}.json`);
}

export function loadUserSeeds(key: string = seedDbKey()): UserSeed[] {
  const path = seedFilePath(key);
  if (!existsSync(path)) return [];
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as UserSeed[];
  } catch {
    return [];
  }
}

export function saveUserSeeds(
  users: UserSeed[],
  key: string = seedDbKey(),
): void {
  mkdirSync(CREDENTIALS_DIR, { recursive: true });
  writeFileSync(seedFilePath(key), JSON.stringify(users, null, 2) + "\n");
}
