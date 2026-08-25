# Recipe Manager: Persistence & Import — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Share a recipe URL from your iPhone and have it land in the database — extracted, enriched, image stored, deduped, and visible as a job you can retry when it fails.

**Architecture:** Plan 1 built a pure `extract()` and a network boundary. This plan adds everything stateful around them: a SQLite schema on Turso, a transactional `upsertRecipe`, blob storage for images and archived source bytes, two authenticated accounts, per-phone bearer tokens, and an import endpoint that answers in milliseconds and finishes the work in the background.

**Tech Stack:** Drizzle ORM (SQLite dialect) on Turso/libsql, NextAuth v5 credentials + bcryptjs, `@paralleldrive/cuid2`, `@vercel/blob`, `sharp`, `@vercel/functions` (`waitUntil`), Vitest.

**Source spec:** `docs/superpowers/specs/2026-08-25-recipe-manager-design.md`
**Predecessor:** `docs/superpowers/plans/2026-08-25-foundation-and-extraction.md` — read its "Handoff to plan 2" section before starting. Several tasks here exist because of findings recorded there.

**Scope note:** Plan 2 of 3. Plan 3 adds the UI (library, recipe page, needs-attention screens) and the Notion migration of 156 recipes. This plan ends when a URL shared from a phone becomes a row in the database.

Two spec items are deliberately deferred to plan 3, because both exist to serve
the UI and would be built blind without it:

- **`GET /api/library-index`**, the ~30KB payload the client filters in memory.
  Its shape follows from what the filter rail renders.
- **Re-indexing FTS when a user edits `notes`.** `upsertRecipe` writes an empty
  notes column into the FTS row, since notes are user-owned and never arrive
  from extraction. The edit path that sets them must re-index — that path is
  built in plan 3, and this is recorded so it is not forgotten.

---

## What already exists

Do not rebuild these. Read them first.

| Module | Exports you will use |
| --- | --- |
| `src/lib/extract` | `extract({url, html, llm})`, `NoRecipeFoundError`, `ExtractedRecipe` |
| `src/lib/extract/types.ts` | `ExtractedRecipe`, `ExtractedIngredient`, `ExtractedStep`, `PartialRecipe` |
| `src/lib/extract/anthropic-client.ts` | `createAnthropicClient(apiKey?)` → `LlmClient` (moves in Task 2) |
| `src/lib/fetch` | `fetchPage(url)` → `{html, bytes, encoding, finalUrl, status}`, `BlockedError`, `FetchFailedError` |
| `src/lib/url.ts` | `normalizeSourceUrl(input)` → `{url, domain}` |
| `src/lib/taxonomy` | `normalizeTag`, `normalizeTags`, `isValidTag`, `FACETS`, vocabularies |

Existing conventions to follow, taken from the user's other Next.js projects:
- ids are `text('id').primaryKey().$defaultFn(() => createId())` using cuid2
- timestamps are `integer('...', { mode: 'timestamp' })`
- booleans are `integer('...', { mode: 'boolean' })`
- tests get a real database via in-memory libsql plus the Drizzle migrator

---

## File structure

```
drizzle.config.ts                     drizzle-kit config, turso dialect
drizzle/migrations/                   generated SQL + one hand-written FTS migration
src/lib/db/
  index.ts                            client + db singleton
  schema.ts                           all tables
  queries/recipes.ts                  upsertRecipe, findBySourceUrl, getRecipe
  queries/jobs.ts                     import job lifecycle
  queries/tokens.ts                   api token issue/verify
src/lib/storage/
  index.ts                            BlobStore interface + selection
  vercel-blob.ts                      production implementation
  memory.ts                           test implementation
src/lib/images/index.ts               ingestHeroImage
src/lib/llm/anthropic-client.ts       moved from lib/extract (purity)
src/lib/auth.ts                       NextAuth config
src/lib/api-auth.ts                   bearer-token authentication for the Shortcut
src/app/api/import/route.ts           POST — accepts a URL, returns 202
src/app/api/jobs/route.ts             GET — job list for the needs-attention tray
src/app/api/jobs/[id]/retry/route.ts  POST — retry a failed job
src/lib/import/run-import.ts          the background pipeline
scripts/seed-users.ts                 create the two accounts
scripts/issue-token.ts                mint a per-phone bearer token
docs/ios-shortcut.md                  setup instructions
tests/helpers/db.ts                   in-memory database for tests
```

**Boundary rule, carried forward:** `lib/extract` stays pure. It must not import `lib/db`, `lib/storage`, `lib/fetch`, or `lib/images`. `lib/import/run-import.ts` is the composition root where the impure pieces meet.

---

### Task 1: Database setup and test harness

**Files:**
- Create: `drizzle.config.ts`, `src/lib/db/index.ts`, `tests/helpers/db.ts`
- Modify: `package.json`, `.env.example`

- [ ] **Step 1: Install dependencies**

```bash
npm install drizzle-orm @libsql/client @paralleldrive/cuid2 bcryptjs next-auth@beta @vercel/blob @vercel/functions sharp
npm install -D drizzle-kit @types/bcryptjs
```

- [ ] **Step 2: Create the drizzle-kit config**

Create `drizzle.config.ts`:

```ts
import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  schema: './src/lib/db/schema.ts',
  out: './drizzle/migrations',
  dialect: 'turso',
  dbCredentials: {
    url: process.env.TURSO_DATABASE_URL!,
    authToken: process.env.TURSO_AUTH_TOKEN!,
  },
})
```

- [ ] **Step 3: Create the database client**

Create `src/lib/db/index.ts`:

```ts
import { drizzle } from 'drizzle-orm/libsql'
import { createClient } from '@libsql/client'
import * as schema from './schema'

const client = createClient({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN,
})

export const db = drizzle(client, { schema })
export type Db = typeof db
```

- [ ] **Step 4: Create the test harness**

Every persistence test runs against a real SQLite database, not a mock. In-memory libsql is fast enough to build a fresh one per test, which keeps tests isolated without cleanup code.

Create `tests/helpers/db.ts`:

```ts
import { drizzle } from 'drizzle-orm/libsql'
import { createClient } from '@libsql/client'
import { migrate } from 'drizzle-orm/libsql/migrator'
import * as schema from '@/lib/db/schema'

export async function createTestDb() {
  const client = createClient({ url: ':memory:' })
  const db = drizzle(client, { schema })
  await migrate(db, { migrationsFolder: './drizzle/migrations' })
  return db
}

export type TestDb = Awaited<ReturnType<typeof createTestDb>>
```

- [ ] **Step 5: Add scripts and environment variables**

In `package.json` scripts:

```json
"db:generate": "drizzle-kit generate",
"db:migrate": "drizzle-kit migrate",
"db:studio": "drizzle-kit studio",
"seed": "tsx scripts/seed-users.ts",
"token": "tsx scripts/issue-token.ts"
```

Replace `.env.example` with:

```
# Database — Turso in the cloud, or a local file for development:
#   TURSO_DATABASE_URL=file:./local.db
TURSO_DATABASE_URL=libsql://your-db.turso.io
TURSO_AUTH_TOKEN=

# Enrichment and LLM extraction fallback
ANTHROPIC_API_KEY=sk-ant-...

# Image and archived-source storage
BLOB_READ_WRITE_TOKEN=

# NextAuth session signing — generate with: openssl rand -base64 32
AUTH_SECRET=
```

- [ ] **Step 6: Update the Vitest config to see the tests directory**

In `vitest.config.mts`, change `include` so tests outside `src/` run too:

```ts
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
```

- [ ] **Step 7: Commit**

```bash
git add drizzle.config.ts src/lib/db/index.ts tests/helpers/db.ts package.json package-lock.json .env.example vitest.config.mts
git commit -m "chore: add drizzle, libsql, and the in-memory test database harness"
```

---

### Task 2: Prerequisite fixes carried from plan 1

Two findings from plan 1's final review block clean persistence work. Do them first, while the code is small.

**Files:**
- Modify: `src/lib/taxonomy/index.ts`, `src/lib/taxonomy/index.test.ts`
- Move: `src/lib/extract/anthropic-client.ts` → `src/lib/llm/anthropic-client.ts`
- Modify: `scripts/extract-url.ts`

- [ ] **Step 1: Write the failing test for the frozen-tag problem**

`normalizeTags` returns frozen singleton objects shared across every recipe. A Drizzle insert that attaches `recipeId` to a tag will throw `TypeError: Cannot add property recipeId, object is not extensible` — which is exactly what Task 6 needs to do.

Add to `src/lib/taxonomy/index.test.ts`:

```ts
describe('normalizeTags result ownership', () => {
  it('returns copies the caller may extend', () => {
    const [tag] = normalizeTags(['Main Course'])
    expect(() => Object.assign(tag, { recipeId: 'abc' })).not.toThrow()
  })

  it('does not share tag objects between calls', () => {
    const [a] = normalizeTags(['Main Course'])
    const [b] = normalizeTags(['Main Course'])
    expect(a).toEqual(b)
    expect(a).not.toBe(b)
  })

  it('still returns a frozen object from normalizeTag itself', () => {
    expect(Object.isFrozen(normalizeTag('Main Course'))).toBe(true)
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run src/lib/taxonomy`
Expected: FAIL on the first two — `Cannot add property recipeId` and `expected … not to be …`.

- [ ] **Step 3: Return defensive copies**

In `src/lib/taxonomy/index.ts`, change the push inside `normalizeTags` to copy:

```ts
    out.push({ facet: tag.facet, value: tag.value })
```

The alias table's entries stay frozen — that protects the table. What escapes to callers is now a copy they own.

- [ ] **Step 4: Run and confirm all three pass**

Run: `npx vitest run src/lib/taxonomy`
Expected: PASS.

- [ ] **Step 5: Move the Anthropic client out of the pure module**

The spec declares `lib/extract` pure with no HTTP, but `anthropic-client.ts` lives inside it and imports the SDK. Nothing in `extract()`'s import graph reaches it today, so this is structural hygiene — it makes the rule enforceable rather than conventional.

```bash
mkdir -p src/lib/llm
git mv src/lib/extract/anthropic-client.ts src/lib/llm/anthropic-client.ts
```

In the moved file, change the taxonomy import to stay absolute (`@/lib/taxonomy` — unchanged) and the `LlmClient` type import to reach back into extract:

```ts
import type { LlmClient } from '@/lib/extract/llm-types'
```

In `scripts/extract-url.ts`, update the import:

```ts
import { createAnthropicClient } from '../src/lib/llm/anthropic-client'
```

- [ ] **Step 6: Add a test that pins the boundary**

Create `src/lib/extract/purity.test.ts`:

```ts
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'

const dir = fileURLToPath(new URL('.', import.meta.url))

const FORBIDDEN = [
  ['@anthropic-ai/sdk', 'network SDK'],
  ['@/lib/db', 'database'],
  ['@/lib/fetch', 'network boundary'],
  ['@/lib/storage', 'blob storage'],
  ['@/lib/images', 'image pipeline'],
] as const

describe('lib/extract stays pure', () => {
  const sources = readdirSync(dir).filter(
    (f) => f.endsWith('.ts') && !f.endsWith('.test.ts'),
  )

  it('has source files to check', () => {
    expect(sources.length).toBeGreaterThan(5)
  })

  for (const file of sources) {
    it(`${file} imports nothing impure`, () => {
      const src = readFileSync(join(dir, file), 'utf8')
      for (const [needle, why] of FORBIDDEN) {
        expect(src, `${file} must not import ${needle} (${why})`).not.toContain(needle)
      }
    })
  }
})
```

- [ ] **Step 7: Run the full suite and commit**

Run: `npm test`
Expected: PASS. Report the count.

```bash
git add src/lib/taxonomy src/lib/llm src/lib/extract/purity.test.ts scripts/extract-url.ts
git commit -m "fix: return owned tag copies and move the LLM client out of lib/extract"
```

---

### Task 3: Schema — accounts and tokens

**Files:**
- Create: `src/lib/db/schema.ts`
- Test: `tests/db/schema.test.ts`

- [ ] **Step 1: Write the schema**

Create `src/lib/db/schema.ts`:

```ts
import { sqliteTable, text, integer, real, index, unique } from 'drizzle-orm/sqlite-core'
import { createId } from '@paralleldrive/cuid2'

export const users = sqliteTable('users', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
})

// One row per phone, so a lost device can be revoked without disturbing the
// other. `tokenHash` is a SHA-256 digest, not bcrypt: the token is 32 bytes of
// CSPRNG output, so there is no low-entropy secret to slow an attacker down,
// and bcrypt on every import request would cost ~100ms for nothing.
export const apiTokens = sqliteTable('api_tokens', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  userId: text('user_id').notNull().references(() => users.id),
  label: text('label').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  lastUsedAt: integer('last_used_at', { mode: 'timestamp' }),
  revokedAt: integer('revoked_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
}, (t) => ({
  byUser: index('api_tokens_user_idx').on(t.userId),
}))
```

- [ ] **Step 2: Generate and apply the migration**

```bash
npm run db:generate
ls drizzle/migrations
```

Expected: a `.sql` file and a `meta/` directory.

- [ ] **Step 3: Write the test**

Create `tests/db/schema.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDb, type TestDb } from '../helpers/db'
import { users, apiTokens } from '@/lib/db/schema'

let db: TestDb
beforeEach(async () => { db = await createTestDb() })

describe('users', () => {
  it('assigns a cuid2 id and a created timestamp', async () => {
    const [row] = await db.insert(users)
      .values({ name: 'Zach', email: 'zach@example.com', passwordHash: 'x' })
      .returning()

    expect(row.id).toMatch(/^[a-z0-9]{20,}$/)
    expect(row.createdAt).toBeInstanceOf(Date)
  })

  it('rejects a duplicate email', async () => {
    await db.insert(users).values({ name: 'A', email: 'same@example.com', passwordHash: 'x' })
    await expect(
      db.insert(users).values({ name: 'B', email: 'same@example.com', passwordHash: 'y' }),
    ).rejects.toThrow()
  })
})

describe('api_tokens', () => {
  it('links to a user and starts unrevoked', async () => {
    const [user] = await db.insert(users)
      .values({ name: 'Zach', email: 'z@example.com', passwordHash: 'x' }).returning()

    const [token] = await db.insert(apiTokens)
      .values({ userId: user.id, label: "Zach's iPhone", tokenHash: 'hash-1' }).returning()

    expect(token.revokedAt).toBeNull()
    expect(token.lastUsedAt).toBeNull()

    const found = await db.select().from(apiTokens).where(eq(apiTokens.userId, user.id))
    expect(found).toHaveLength(1)
  })

  it('rejects a duplicate token hash', async () => {
    const [user] = await db.insert(users)
      .values({ name: 'Z', email: 'z2@example.com', passwordHash: 'x' }).returning()
    await db.insert(apiTokens).values({ userId: user.id, label: 'a', tokenHash: 'dup' })
    await expect(
      db.insert(apiTokens).values({ userId: user.id, label: 'b', tokenHash: 'dup' }),
    ).rejects.toThrow()
  })
})
```

- [ ] **Step 4: Run and commit**

Run: `npx vitest run tests/db`
Expected: PASS, 4 tests.

```bash
git add src/lib/db/schema.ts tests/db/schema.test.ts drizzle/migrations
git commit -m "feat: add users and api_tokens schema"
```

---

### Task 4: Schema — recipes and import jobs

**Files:**
- Modify: `src/lib/db/schema.ts`
- Test: `tests/db/recipe-schema.test.ts`

- [ ] **Step 1: Append the recipe tables**

Add to `src/lib/db/schema.ts`:

```ts
export const recipes = sqliteTable('recipes', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  title: text('title').notNull(),
  slug: text('slug').notNull(),

  // The canonical, tracking-stripped URL from normalizeSourceUrl. UNIQUE is the
  // dedupe mechanism: the same recipe clipped from a newsletter link and a text
  // message must collapse to one row. Nullable because 4 recipes in the Notion
  // library have no source at all.
  sourceUrl: text('source_url').unique(),
  sourceDomain: text('source_domain'),
  publisher: text('publisher'),
  author: text('author'),
  description: text('description'),

  claimedTimeMinutes: integer('claimed_time_minutes'),
  actualTimeMinutes: integer('actual_time_minutes'),
  servings: integer('servings'),
  yieldText: text('yield_text'),

  rating: integer('rating'),
  status: text('status', { enum: ['want_to_make', 'made_it'] }),
  notes: text('notes'),

  narrativeHtml: text('narrative_html'),

  // Blob key for the gzipped original response bytes. Re-extraction is then
  // offline forever: improve the parser, re-run every recipe, no network, no
  // rate limits, no dead blogs. Stores bytes rather than the decoded string so
  // a wrong charset decode stays repairable.
  archivedHtmlKey: text('archived_html_key'),
  sourceEncoding: text('source_encoding'),

  extractionMethod: text('extraction_method', {
    enum: ['jsonld', 'microdata', 'llm', 'notion', 'manual'],
  }).notNull(),
  enrichmentApplied: integer('enrichment_applied', { mode: 'boolean' }).notNull().default(false),

  addedBy: text('added_by').references(() => users.id),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
}, (t) => ({
  byDomain: index('recipes_domain_idx').on(t.sourceDomain),
  byStatus: index('recipes_status_idx').on(t.status),
  byCreated: index('recipes_created_idx').on(t.createdAt),
}))

export const ingredients = sqliteTable('ingredients', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  recipeId: text('recipe_id').notNull().references(() => recipes.id, { onDelete: 'cascade' }),
  position: integer('position').notNull(),
  section: text('section'),
  // Always the source line, verbatim. The parsed columns below are an
  // enhancement layered on by the LLM and may be null forever; this one is the
  // guarantee that nothing is ever lost to a bad parse.
  rawText: text('raw_text').notNull(),
  // REAL, not INTEGER: quantities are routinely fractional. "1 ½ cups flour"
  // enriches to 1.5, and an INTEGER column would silently store 1 — a scaling
  // feature would then be wrong in a way nobody notices until the bread fails.
  quantity: real('quantity'),
  unit: text('unit'),
  item: text('item'),
  note: text('note'),
}, (t) => ({
  byRecipe: index('ingredients_recipe_idx').on(t.recipeId),
  uniquePosition: unique().on(t.recipeId, t.position),
}))

export const steps = sqliteTable('steps', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  recipeId: text('recipe_id').notNull().references(() => recipes.id, { onDelete: 'cascade' }),
  position: integer('position').notNull(),
  section: text('section'),
  text: text('text').notNull(),
}, (t) => ({
  byRecipe: index('steps_recipe_idx').on(t.recipeId),
  uniquePosition: unique().on(t.recipeId, t.position),
}))

// One row per tag, carrying its facet. A single index gives AND-across-facets /
// OR-within-facet filtering and the live counts in the filter rail. Adding a
// facet later is data, not a migration.
export const recipeTags = sqliteTable('recipe_tags', {
  recipeId: text('recipe_id').notNull().references(() => recipes.id, { onDelete: 'cascade' }),
  facet: text('facet', { enum: ['course', 'ingredient', 'method', 'cuisine', 'tag'] }).notNull(),
  value: text('value').notNull(),
}, (t) => ({
  byFacetValue: index('recipe_tags_facet_value_idx').on(t.facet, t.value),
  uniqueTag: unique().on(t.recipeId, t.facet, t.value),
}))

export const images = sqliteTable('images', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  recipeId: text('recipe_id').notNull().references(() => recipes.id, { onDelete: 'cascade' }),
  role: text('role', { enum: ['source_hero', 'user'] }).notNull(),
  blobKey: text('blob_key').notNull(),
  thumbKey: text('thumb_key').notNull(),
  width: integer('width').notNull(),
  height: integer('height').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
}, (t) => ({
  byRecipe: index('images_recipe_idx').on(t.recipeId),
}))

// `failureKind` exists because the recovery paths differ: a `blocked` job needs
// page HTML supplied from the phone (a residential IP), `fetch_failed` and
// `llm_failed` are worth an ordinary retry, and `no_recipe` never will be.
export const importJobs = sqliteTable('import_jobs', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  url: text('url').notNull(),
  status: text('status', { enum: ['queued', 'running', 'done', 'failed', 'duplicate'] })
    .notNull().default('queued'),
  failureKind: text('failure_kind', {
    enum: ['blocked', 'fetch_failed', 'no_recipe', 'llm_failed', 'internal'],
  }),
  error: text('error'),
  recipeId: text('recipe_id').references(() => recipes.id),
  requestedBy: text('requested_by').references(() => users.id),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
  finishedAt: integer('finished_at', { mode: 'timestamp' }),
}, (t) => ({
  byStatus: index('import_jobs_status_idx').on(t.status),
  byCreated: index('import_jobs_created_idx').on(t.createdAt),
}))
```

- [ ] **Step 2: Generate the migration**

```bash
npm run db:generate
```

- [ ] **Step 3: Write the test**

Create `tests/db/recipe-schema.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDb, type TestDb } from '../helpers/db'
import { recipes, ingredients, steps, recipeTags, importJobs } from '@/lib/db/schema'

let db: TestDb
beforeEach(async () => { db = await createTestDb() })

async function insertRecipe(overrides: Record<string, unknown> = {}) {
  const [row] = await db.insert(recipes).values({
    title: 'Egg Korma', slug: 'egg-korma',
    sourceUrl: 'https://example.com/korma', sourceDomain: 'example.com',
    extractionMethod: 'jsonld', ...overrides,
  }).returning()
  return row
}

describe('recipes', () => {
  it('enforces one row per canonical source url', async () => {
    await insertRecipe()
    await expect(insertRecipe({ slug: 'egg-korma-2' })).rejects.toThrow()
  })

  it('allows many recipes with no source url', async () => {
    await insertRecipe({ sourceUrl: null })
    await insertRecipe({ sourceUrl: null, slug: 'other' })
    expect(await db.select().from(recipes)).toHaveLength(2)
  })

  it('defaults enrichmentApplied to false', async () => {
    expect((await insertRecipe()).enrichmentApplied).toBe(false)
  })
})

describe('child rows', () => {
  it('cascades deletes to ingredients, steps, and tags', async () => {
    const recipe = await insertRecipe()
    await db.insert(ingredients).values({ recipeId: recipe.id, position: 0, rawText: '2 eggs' })
    await db.insert(steps).values({ recipeId: recipe.id, position: 0, text: 'Boil.' })
    await db.insert(recipeTags).values({ recipeId: recipe.id, facet: 'course', value: 'main' })

    await db.delete(recipes).where(eq(recipes.id, recipe.id))

    expect(await db.select().from(ingredients)).toHaveLength(0)
    expect(await db.select().from(steps)).toHaveLength(0)
    expect(await db.select().from(recipeTags)).toHaveLength(0)
  })

  it('rejects two ingredients at the same position', async () => {
    const recipe = await insertRecipe()
    await db.insert(ingredients).values({ recipeId: recipe.id, position: 0, rawText: 'a' })
    await expect(
      db.insert(ingredients).values({ recipeId: recipe.id, position: 0, rawText: 'b' }),
    ).rejects.toThrow()
  })

  it('rejects a duplicate facet/value on one recipe', async () => {
    const recipe = await insertRecipe()
    await db.insert(recipeTags).values({ recipeId: recipe.id, facet: 'course', value: 'main' })
    await expect(
      db.insert(recipeTags).values({ recipeId: recipe.id, facet: 'course', value: 'main' }),
    ).rejects.toThrow()
  })

  it('allows two courses on one recipe', async () => {
    const recipe = await insertRecipe()
    await db.insert(recipeTags).values({ recipeId: recipe.id, facet: 'course', value: 'main' })
    await db.insert(recipeTags).values({ recipeId: recipe.id, facet: 'course', value: 'side' })
    expect(await db.select().from(recipeTags)).toHaveLength(2)
  })
})

describe('import_jobs', () => {
  it('starts queued with no failure kind', async () => {
    const [job] = await db.insert(importJobs)
      .values({ url: 'https://example.com/x' }).returning()
    expect(job.status).toBe('queued')
    expect(job.failureKind).toBeNull()
    expect(job.finishedAt).toBeNull()
  })
})
```

**Note on the cascade test:** libsql enforces foreign keys by default. If the cascade assertions fail, the connection needs `PRAGMA foreign_keys = ON` — add it to `tests/helpers/db.ts` via `client.execute('PRAGMA foreign_keys = ON')` before migrating, and to `src/lib/db/index.ts` the same way. Report which you found.

- [ ] **Step 4: Run and commit**

Run: `npx vitest run tests/db`
Expected: PASS, 11 tests.

```bash
git add src/lib/db/schema.ts tests/db/recipe-schema.test.ts drizzle/migrations
git commit -m "feat: add recipe, ingredient, step, tag, image, and import job schema"
```

---

### Task 5: Full-text search index

Drizzle does not model virtual tables, so this is a hand-written migration. The FTS table is maintained by application code rather than SQL triggers — every write goes through one function (Task 6), which makes the sync point explicit and testable, where triggers would be invisible and awkward to assert on.

**Files:**
- Create: `drizzle/migrations/0002_recipes_fts.sql` (adjust the number to follow the generated ones)
- Modify: `src/lib/db/queries/recipes.ts` in Task 6

- [ ] **Step 1: Create the custom migration**

```bash
npx drizzle-kit generate --custom --name recipes_fts
```

Put this in the generated file:

```sql
CREATE VIRTUAL TABLE recipes_fts USING fts5(
  recipe_id UNINDEXED,
  title,
  ingredients,
  steps,
  notes,
  narrative,
  tokenize = 'porter unicode61'
);
```

- [ ] **Step 2: Write the test**

Create `tests/db/fts.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { sql } from 'drizzle-orm'
import { createTestDb, type TestDb } from '../helpers/db'

let db: TestDb
beforeEach(async () => { db = await createTestDb() })

async function index(recipeId: string, title: string, ingredientsText: string, stepsText: string) {
  await db.run(sql`
    INSERT INTO recipes_fts (recipe_id, title, ingredients, steps, notes, narrative)
    VALUES (${recipeId}, ${title}, ${ingredientsText}, ${stepsText}, '', '')
  `)
}

async function search(query: string): Promise<string[]> {
  const rows = await db.all<{ recipe_id: string }>(sql`
    SELECT recipe_id FROM recipes_fts WHERE recipes_fts MATCH ${query} ORDER BY rank
  `)
  return rows.map((r) => r.recipe_id)
}

describe('recipes_fts', () => {
  beforeEach(async () => {
    await index('r1', 'Slow-Roast Gochujang Chicken', '1 tbsp gochujang\n4 chicken thighs', 'Roast low.')
    await index('r2', 'Best Bolognese', '1 lb ground beef\npancetta', 'Simmer for three hours.')
  })

  it('finds a recipe by an ingredient buried in the list', async () => {
    expect(await search('gochujang')).toEqual(['r1'])
  })

  it('finds a recipe by step text', async () => {
    expect(await search('simmer')).toEqual(['r2'])
  })

  it('stems, so a search for a related form still matches', async () => {
    expect(await search('roasted')).toContain('r1')
  })

  it('returns nothing for a term in no recipe', async () => {
    expect(await search('saffron')).toEqual([])
  })
})
```

- [ ] **Step 3: Run and commit**

Run: `npx vitest run tests/db/fts`
Expected: PASS, 4 tests.

```bash
git add drizzle/migrations tests/db/fts.test.ts
git commit -m "feat: add FTS5 index over recipe title, ingredients, steps, notes, and narrative"
```

---

### Task 6: `upsertRecipe`

The single write path. Everything that stores a recipe goes through here, which is what keeps the FTS index and the child tables consistent.

**Files:**
- Create: `src/lib/db/queries/recipes.ts`
- Test: `tests/db/upsert-recipe.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/db/upsert-recipe.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { createTestDb, type TestDb } from '../helpers/db'
import { upsertRecipe } from '@/lib/db/queries/recipes'
import { recipes, ingredients, steps, recipeTags } from '@/lib/db/schema'
import type { ExtractedRecipe } from '@/lib/extract/types'

let db: TestDb
beforeEach(async () => { db = await createTestDb() })

const extracted: ExtractedRecipe = {
  title: 'Slow-Roast Gochujang Chicken',
  description: 'A melt-in-your-mouth roast.',
  author: 'Molly Baz',
  publisher: 'Bon Appétit',
  claimedTimeMinutes: 180,
  servings: 4,
  yieldText: '4 servings',
  ingredients: [
    { position: 0, section: null, rawText: '1 Tbsp. gochujang', quantity: 1, unit: 'tablespoon', item: 'gochujang', note: null },
    { position: 1, section: null, rawText: '4 chicken thighs', quantity: 4, unit: null, item: 'chicken thighs', note: null },
  ],
  steps: [{ position: 0, section: null, text: 'Roast low and slow.' }],
  tags: [{ facet: 'course', value: 'main' }, { facet: 'ingredient', value: 'chicken' }],
  heroImageUrl: 'https://example.com/hero.jpg',
  narrativeHtml: '<p>This is not the crisp-skinned roast chicken you know.</p>',
  extractionMethod: 'jsonld',
}

describe('upsertRecipe', () => {
  it('writes the recipe and all its children', async () => {
    const id = await upsertRecipe(db, {
      extracted, sourceUrl: 'https://bonappetit.com/recipe/gochujang',
      sourceDomain: 'bonappetit.com', enrichmentApplied: true,
    })

    const [row] = await db.select().from(recipes).where(eq(recipes.id, id))
    expect(row.title).toBe('Slow-Roast Gochujang Chicken')
    expect(row.slug).toBe('slow-roast-gochujang-chicken')
    expect(row.claimedTimeMinutes).toBe(180)
    expect(row.enrichmentApplied).toBe(true)

    expect(await db.select().from(ingredients).where(eq(ingredients.recipeId, id))).toHaveLength(2)
    expect(await db.select().from(steps).where(eq(steps.recipeId, id))).toHaveLength(1)
    expect(await db.select().from(recipeTags).where(eq(recipeTags.recipeId, id))).toHaveLength(2)
  })

  it('stores fractional quantities without truncating them', async () => {
    const fractional: ExtractedRecipe = {
      ...extracted,
      ingredients: [{
        position: 0, section: null, rawText: '1 ½ cups all-purpose flour, sifted',
        quantity: 1.5, unit: 'cup', item: 'all-purpose flour', note: 'sifted',
      }],
    }
    const id = await upsertRecipe(db, {
      extracted: fractional, sourceUrl: 'https://x.com/frac', sourceDomain: 'x.com',
    })
    const [row] = await db.select().from(ingredients).where(eq(ingredients.recipeId, id))
    expect(row.quantity).toBe(1.5)
  })

  it('preserves ingredient rawText verbatim', async () => {
    const id = await upsertRecipe(db, { extracted, sourceUrl: 'https://x.com/a', sourceDomain: 'x.com' })
    const rows = await db.select().from(ingredients).where(eq(ingredients.recipeId, id))
    expect(rows.map((r) => r.rawText).sort()).toEqual(['1 Tbsp. gochujang', '4 chicken thighs'])
  })

  it('indexes the recipe for full-text search', async () => {
    const id = await upsertRecipe(db, { extracted, sourceUrl: 'https://x.com/b', sourceDomain: 'x.com' })
    const hits = await db.all<{ recipe_id: string }>(
      sql`SELECT recipe_id FROM recipes_fts WHERE recipes_fts MATCH 'gochujang'`,
    )
    expect(hits.map((h) => h.recipe_id)).toEqual([id])
  })

  it('replaces children on re-import rather than duplicating them', async () => {
    const url = 'https://x.com/c'
    const first = await upsertRecipe(db, { extracted, sourceUrl: url, sourceDomain: 'x.com' })

    const revised: ExtractedRecipe = {
      ...extracted,
      title: 'Slow-Roast Gochujang Chicken (updated)',
      ingredients: [{ position: 0, section: null, rawText: '2 Tbsp. gochujang', quantity: 2, unit: 'tablespoon', item: 'gochujang', note: null }],
    }
    const second = await upsertRecipe(db, { extracted: revised, sourceUrl: url, sourceDomain: 'x.com' })

    expect(second).toBe(first)
    expect(await db.select().from(recipes)).toHaveLength(1)
    const rows = await db.select().from(ingredients).where(eq(ingredients.recipeId, first))
    expect(rows).toHaveLength(1)
    expect(rows[0].rawText).toBe('2 Tbsp. gochujang')
  })

  it('keeps user-owned fields across a re-import', async () => {
    const url = 'https://x.com/d'
    const id = await upsertRecipe(db, { extracted, sourceUrl: url, sourceDomain: 'x.com' })
    await db.update(recipes)
      .set({ rating: 5, status: 'made_it', notes: 'Needed more flour.', actualTimeMinutes: 70 })
      .where(eq(recipes.id, id))

    await upsertRecipe(db, { extracted, sourceUrl: url, sourceDomain: 'x.com' })

    const [row] = await db.select().from(recipes).where(eq(recipes.id, id))
    expect(row.rating).toBe(5)
    expect(row.status).toBe('made_it')
    expect(row.notes).toBe('Needed more flour.')
    expect(row.actualTimeMinutes).toBe(70)
  })

  it('does not leave a partial recipe behind when a child insert fails', async () => {
    const broken: ExtractedRecipe = {
      ...extracted,
      ingredients: [
        { position: 0, section: null, rawText: 'a', quantity: null, unit: null, item: null, note: null },
        { position: 0, section: null, rawText: 'b', quantity: null, unit: null, item: null, note: null },
      ],
    }
    await expect(
      upsertRecipe(db, { extracted: broken, sourceUrl: 'https://x.com/e', sourceDomain: 'x.com' }),
    ).rejects.toThrow()
    expect(await db.select().from(recipes)).toHaveLength(0)
  })

  it('generates unique slugs for two recipes with the same title', async () => {
    const a = await upsertRecipe(db, { extracted, sourceUrl: 'https://x.com/f', sourceDomain: 'x.com' })
    const b = await upsertRecipe(db, { extracted, sourceUrl: 'https://x.com/g', sourceDomain: 'x.com' })
    const rows = await db.select().from(recipes)
    const slugs = rows.map((r) => r.slug)
    expect(new Set(slugs).size).toBe(2)
    expect(a).not.toBe(b)
  })
})
```

- [ ] **Step 2: Run and confirm it fails**

Run: `npx vitest run tests/db/upsert-recipe`
Expected: FAIL — unresolved import.

- [ ] **Step 3: Implement it**

Create `src/lib/db/queries/recipes.ts`:

```ts
import { eq, sql } from 'drizzle-orm'
import type { ExtractedRecipe } from '@/lib/extract/types'
import type { Db } from '@/lib/db'
import { recipes, ingredients, steps, recipeTags } from '@/lib/db/schema'

export type UpsertInput = {
  extracted: ExtractedRecipe
  sourceUrl: string | null
  sourceDomain: string | null
  archivedHtmlKey?: string | null
  sourceEncoding?: string | null
  enrichmentApplied?: boolean
  addedBy?: string | null
}

function slugify(title: string): string {
  return title.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    || 'recipe'
}

/**
 * The single write path for a recipe.
 *
 * Re-import semantics matter here. Source-derived fields are overwritten,
 * because a re-extraction is by definition a better read of the same page.
 * User-owned fields — rating, status, notes, actual time — are never touched:
 * they are the only data in the row that cannot be regenerated, and silently
 * losing "we made this, it was a 5" on a re-import would be unforgivable.
 *
 * Children are replaced wholesale rather than diffed. Positions shift when a
 * publisher edits a recipe, so matching old rows to new ones is guesswork; a
 * clean replace inside the transaction is both simpler and correct.
 */
export async function upsertRecipe(db: Db, input: UpsertInput): Promise<string> {
  const { extracted, sourceUrl, sourceDomain } = input

  return db.transaction(async (tx) => {
    const existing = sourceUrl
      ? await tx.select({ id: recipes.id }).from(recipes).where(eq(recipes.sourceUrl, sourceUrl)).get()
      : undefined

    const sourceFields = {
      title: extracted.title,
      sourceDomain,
      publisher: extracted.publisher,
      author: extracted.author,
      description: extracted.description,
      claimedTimeMinutes: extracted.claimedTimeMinutes,
      servings: extracted.servings,
      yieldText: extracted.yieldText,
      narrativeHtml: extracted.narrativeHtml,
      archivedHtmlKey: input.archivedHtmlKey ?? null,
      sourceEncoding: input.sourceEncoding ?? null,
      extractionMethod: extracted.extractionMethod,
      enrichmentApplied: input.enrichmentApplied ?? false,
      updatedAt: new Date(),
    }

    let recipeId: string

    if (existing) {
      recipeId = existing.id
      await tx.update(recipes).set(sourceFields).where(eq(recipes.id, recipeId))
      await tx.delete(ingredients).where(eq(ingredients.recipeId, recipeId))
      await tx.delete(steps).where(eq(steps.recipeId, recipeId))
      await tx.delete(recipeTags).where(eq(recipeTags.recipeId, recipeId))
    } else {
      const [row] = await tx.insert(recipes).values({
        ...sourceFields,
        slug: slugify(extracted.title),
        sourceUrl,
        addedBy: input.addedBy ?? null,
      }).returning({ id: recipes.id })
      recipeId = row.id

      // Slug uniqueness is not enforced by a constraint, because two recipes
      // legitimately share a title. The id keeps them distinct; the slug is
      // only a URL nicety, so we disambiguate with a short id suffix.
      await tx.update(recipes)
        .set({ slug: `${slugify(extracted.title)}-${recipeId.slice(-6)}` })
        .where(eq(recipes.id, recipeId))
    }

    if (extracted.ingredients.length) {
      await tx.insert(ingredients).values(
        extracted.ingredients.map((i) => ({
          recipeId, position: i.position, section: i.section, rawText: i.rawText,
          quantity: i.quantity, unit: i.unit, item: i.item, note: i.note,
        })),
      )
    }

    if (extracted.steps.length) {
      await tx.insert(steps).values(
        extracted.steps.map((s) => ({
          recipeId, position: s.position, section: s.section, text: s.text,
        })),
      )
    }

    if (extracted.tags.length) {
      await tx.insert(recipeTags).values(
        extracted.tags.map((t) => ({ recipeId, facet: t.facet, value: t.value })),
      )
    }

    await tx.run(sql`DELETE FROM recipes_fts WHERE recipe_id = ${recipeId}`)
    await tx.run(sql`
      INSERT INTO recipes_fts (recipe_id, title, ingredients, steps, notes, narrative)
      VALUES (
        ${recipeId},
        ${extracted.title},
        ${extracted.ingredients.map((i) => i.rawText).join('\n')},
        ${extracted.steps.map((s) => s.text).join('\n')},
        ${''},
        ${extracted.narrativeHtml ?? ''}
      )
    `)

    return recipeId
  })
}

export async function findBySourceUrl(db: Db, sourceUrl: string) {
  return db.select().from(recipes).where(eq(recipes.sourceUrl, sourceUrl)).get()
}
```

**Note:** the first slug write followed by an update is deliberate — the id is only known after insert. If your Drizzle version returns the generated id differently, adapt but keep the behavior: unique slugs, no constraint.

- [ ] **Step 4: Run and commit**

Run: `npx vitest run tests/db/upsert-recipe`
Expected: PASS, 7 tests.

```bash
git add src/lib/db/queries/recipes.ts tests/db/upsert-recipe.test.ts
git commit -m "feat: add transactional upsertRecipe preserving user-owned fields"
```

---

### Task 7: Blob storage adapter

**Files:**
- Create: `src/lib/storage/index.ts`, `src/lib/storage/memory.ts`, `src/lib/storage/vercel-blob.ts`
- Test: `tests/storage/memory.test.ts`

- [ ] **Step 1: Define the interface and the in-memory implementation**

Create `src/lib/storage/index.ts`:

```ts
export type StoredBlob = { key: string; url: string; size: number }

/**
 * Everything that writes bytes goes through this interface, so moving from
 * Vercel Blob to Cloudflare R2 is a one-module change rather than a search
 * across the codebase. Plan 1 measured that a 156-recipe library needs roughly
 * 150MB of hero images, thumbnails, and gzipped source; if that exceeds the
 * free tier, this is the seam where it gets swapped.
 */
export type BlobStore = {
  put(key: string, data: Uint8Array, contentType: string): Promise<StoredBlob>
  get(key: string): Promise<Uint8Array | null>
  delete(key: string): Promise<void>
}
```

Create `src/lib/storage/memory.ts`:

```ts
import type { BlobStore, StoredBlob } from './index'

/** For tests. No network, no cleanup, isolated per instance. */
export function createMemoryStore(): BlobStore & { keys(): string[] } {
  const files = new Map<string, Uint8Array>()

  return {
    async put(key, data): Promise<StoredBlob> {
      files.set(key, data)
      return { key, url: `memory://${key}`, size: data.byteLength }
    },
    async get(key) {
      return files.get(key) ?? null
    },
    async delete(key) {
      files.delete(key)
    },
    keys: () => [...files.keys()],
  }
}
```

- [ ] **Step 2: Implement the Vercel Blob store**

Create `src/lib/storage/vercel-blob.ts`:

```ts
import { put, del } from '@vercel/blob'
import type { BlobStore, StoredBlob } from './index'

export function createVercelBlobStore(token = process.env.BLOB_READ_WRITE_TOKEN): BlobStore {
  if (!token) throw new Error('BLOB_READ_WRITE_TOKEN is not set')

  return {
    async put(key, data, contentType): Promise<StoredBlob> {
      const result = await put(key, Buffer.from(data), {
        access: 'public',
        contentType,
        token,
        // Keys are derived from the recipe id, so we control uniqueness and
        // want a re-import to overwrite rather than accumulate suffixed copies.
        addRandomSuffix: false,
        allowOverwrite: true,
      })
      return { key, url: result.url, size: data.byteLength }
    },

    async get(key) {
      throw new Error(`get() is not implemented for Vercel Blob (key: ${key})`)
    },

    async delete(key) {
      await del(key, { token })
    },
  }
}
```

**On the unimplemented `get`:** blobs are public and read by URL from the browser, so the server never fetches them back. Throwing loudly beats a silent stub that returns null and makes a caller think the blob is missing. If plan 3's migration needs reads, implement it then.

- [ ] **Step 3: Write the test**

Create `tests/storage/memory.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { createMemoryStore } from '@/lib/storage/memory'

describe('memory blob store', () => {
  it('round-trips bytes unchanged', async () => {
    const store = createMemoryStore()
    const data = new Uint8Array([0xde, 0xad, 0xbe, 0xef])
    const stored = await store.put('a/b.bin', data, 'application/octet-stream')

    expect(stored.size).toBe(4)
    expect(await store.get('a/b.bin')).toEqual(data)
  })

  it('returns null for a missing key', async () => {
    expect(await createMemoryStore().get('nope')).toBeNull()
  })

  it('overwrites an existing key', async () => {
    const store = createMemoryStore()
    await store.put('k', new Uint8Array([1]), 'application/octet-stream')
    await store.put('k', new Uint8Array([2]), 'application/octet-stream')
    expect(await store.get('k')).toEqual(new Uint8Array([2]))
    expect(store.keys()).toEqual(['k'])
  })

  it('deletes', async () => {
    const store = createMemoryStore()
    await store.put('k', new Uint8Array([1]), 'application/octet-stream')
    await store.delete('k')
    expect(await store.get('k')).toBeNull()
  })
})
```

- [ ] **Step 4: Run and commit**

Run: `npx vitest run tests/storage`
Expected: PASS, 4 tests.

```bash
git add src/lib/storage tests/storage
git commit -m "feat: add blob storage interface with memory and Vercel implementations"
```

---

### Task 8: Hero image ingestion

**Files:**
- Create: `src/lib/images/index.ts`
- Test: `tests/images/ingest.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/images/ingest.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest'
import sharp from 'sharp'
import { ingestHeroImage } from '@/lib/images'
import { createMemoryStore } from '@/lib/storage/memory'

afterEach(() => { vi.unstubAllGlobals() })

async function pngBytes(width: number, height: number): Promise<Uint8Array> {
  const buf = await sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 100, b: 50 } },
  }).png().toBuffer()
  return new Uint8Array(buf)
}

function stubFetch(bytes: Uint8Array, contentType = 'image/png', status = 200) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
    new Response(status === 200 ? bytes : null, {
      status,
      headers: { 'content-type': contentType },
    }),
  ))
}

describe('ingestHeroImage', () => {
  it('stores a full image and a thumbnail and reports dimensions', async () => {
    stubFetch(await pngBytes(1600, 900))
    const store = createMemoryStore()

    const result = await ingestHeroImage({
      url: 'https://example.com/hero.png', recipeId: 'rec123', store,
    })

    expect(result).not.toBeNull()
    expect(result!.width).toBe(1600)
    expect(result!.height).toBe(900)
    expect(store.keys().sort()).toEqual(
      ['recipes/rec123/hero-thumb.webp', 'recipes/rec123/hero.webp'],
    )
  })

  it('converts to webp', async () => {
    stubFetch(await pngBytes(800, 600))
    const store = createMemoryStore()
    await ingestHeroImage({ url: 'https://example.com/h.png', recipeId: 'r', store })

    const stored = await store.get('recipes/r/hero.webp')
    expect((await sharp(Buffer.from(stored!)).metadata()).format).toBe('webp')
  })

  it('caps the thumbnail width', async () => {
    stubFetch(await pngBytes(2000, 1000))
    const store = createMemoryStore()
    await ingestHeroImage({ url: 'https://example.com/h.png', recipeId: 'r', store })

    const thumb = await sharp(Buffer.from((await store.get('recipes/r/hero-thumb.webp'))!)).metadata()
    expect(thumb.width).toBe(480)
  })

  it('returns null when the image cannot be fetched', async () => {
    stubFetch(new Uint8Array(), 'image/png', 404)
    const store = createMemoryStore()
    expect(await ingestHeroImage({ url: 'https://example.com/x.png', recipeId: 'r', store })).toBeNull()
    expect(store.keys()).toEqual([])
  })

  it('returns null for a non-image content type', async () => {
    stubFetch(await pngBytes(10, 10), 'text/html')
    const store = createMemoryStore()
    expect(await ingestHeroImage({ url: 'https://example.com/x', recipeId: 'r', store })).toBeNull()
  })

  it('returns null for bytes sharp cannot decode', async () => {
    stubFetch(new Uint8Array([1, 2, 3, 4]), 'image/png')
    const store = createMemoryStore()
    expect(await ingestHeroImage({ url: 'https://example.com/x.png', recipeId: 'r', store })).toBeNull()
  })

  it('returns null rather than throwing when the network rejects', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNRESET')))
    const store = createMemoryStore()
    expect(await ingestHeroImage({ url: 'https://example.com/x.png', recipeId: 'r', store })).toBeNull()
  })
})
```

- [ ] **Step 2: Run and confirm it fails**

Run: `npx vitest run tests/images`
Expected: FAIL — unresolved import.

- [ ] **Step 3: Implement it**

Create `src/lib/images/index.ts`:

```ts
import sharp from 'sharp'
import type { BlobStore } from '@/lib/storage'

const MAX_SOURCE_BYTES = 15 * 1024 * 1024
const FULL_MAX_WIDTH = 1600
const THUMB_WIDTH = 480
const TIMEOUT_MS = 15_000

export type IngestedImage = {
  blobKey: string
  thumbKey: string
  width: number
  height: number
}

export type IngestInput = {
  url: string
  recipeId: string
  store: BlobStore
}

/**
 * Downloads a source hero image, normalizes it, and stores both a display copy
 * and a grid thumbnail.
 *
 * We hold our own copy rather than hot-linking because the alternative decays:
 * Notion's image URLs expire in five minutes, and source blogs reorganize, go
 * behind Cloudflare, or die — a library you want to look at in three years has
 * to own its pictures.
 *
 * Returns null on any failure. A recipe without a picture is still a recipe;
 * a failed import because a CDN hiccuped is not acceptable.
 */
export async function ingestHeroImage(input: IngestInput): Promise<IngestedImage | null> {
  const { url, recipeId, store } = input

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

  let bytes: Uint8Array
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: 'follow' })
    if (!response.ok) return null

    const contentType = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
    if (contentType && !contentType.startsWith('image/')) return null

    const buffer = await response.arrayBuffer()
    if (buffer.byteLength === 0 || buffer.byteLength > MAX_SOURCE_BYTES) return null
    bytes = new Uint8Array(buffer)
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }

  try {
    const source = sharp(Buffer.from(bytes))
    const meta = await source.metadata()
    if (!meta.width || !meta.height) return null

    const full = await sharp(Buffer.from(bytes))
      .rotate()
      .resize({ width: FULL_MAX_WIDTH, withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer()

    const thumb = await sharp(Buffer.from(bytes))
      .rotate()
      .resize({ width: THUMB_WIDTH, withoutEnlargement: true })
      .webp({ quality: 74 })
      .toBuffer()

    const blobKey = `recipes/${recipeId}/hero.webp`
    const thumbKey = `recipes/${recipeId}/hero-thumb.webp`

    await store.put(blobKey, new Uint8Array(full), 'image/webp')
    await store.put(thumbKey, new Uint8Array(thumb), 'image/webp')

    return { blobKey, thumbKey, width: meta.width, height: meta.height }
  } catch {
    return null
  }
}
```

**Note:** `width`/`height` report the *original* dimensions, which is what a layout needs for aspect ratio. The stored files may be smaller.

- [ ] **Step 4: Run and commit**

Run: `npx vitest run tests/images`
Expected: PASS, 7 tests.

```bash
git add src/lib/images tests/images
git commit -m "feat: ingest hero images to owned storage with thumbnails"
```

---

### Task 9: Authentication and the two accounts

**Files:**
- Create: `src/lib/auth.ts`, `src/app/api/auth/[...nextauth]/route.ts`, `scripts/seed-users.ts`
- Modify: `src/lib/db/schema.ts` if needed

- [ ] **Step 1: Create the NextAuth config**

This mirrors the pattern already in production in the user's `gridiron-picks` project, including the constant-time dummy-hash compare.

Create `src/lib/auth.ts`:

```ts
import NextAuth from 'next-auth'
import Credentials from 'next-auth/providers/credentials'
import { compare } from 'bcryptjs'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { users } from '@/lib/db/schema'

// A bcrypt hash of a value nobody knows. Comparing against it when the email
// does not exist keeps the response time identical to a wrong-password attempt,
// so the endpoint cannot be used to discover which accounts exist.
const DUMMY_HASH = '$2b$12$invalidhashforcomparison000000000000000000000000000000'

export const { handlers, signIn, signOut, auth } = NextAuth({
  providers: [
    Credentials({
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) return null

        const user = await db.select().from(users)
          .where(eq(users.email, credentials.email as string)).get()

        const valid = await compare(
          credentials.password as string,
          user ? user.passwordHash : DUMMY_HASH,
        )
        if (!user || !valid) return null

        return { id: user.id, name: user.name, email: user.email }
      },
    }),
  ],
  callbacks: {
    jwt({ token, user }) {
      if (user) token.id = user.id as string
      return token
    },
    session({ session, token }) {
      session.user.id = token.id as string
      return session
    },
  },
  pages: { signIn: '/login' },
})
```

- [ ] **Step 2: Wire the route handler**

Create `src/app/api/auth/[...nextauth]/route.ts`:

```ts
import { handlers } from '@/lib/auth'

export const { GET, POST } = handlers
```

- [ ] **Step 3: Add the session type augmentation**

Create `src/types/next-auth.d.ts`:

```ts
import 'next-auth'

declare module 'next-auth' {
  interface Session {
    user: {
      id: string
      name?: string | null
      email?: string | null
    }
  }
}
```

- [ ] **Step 4: Write the seed script**

Create `scripts/seed-users.ts`:

```ts
#!/usr/bin/env tsx
import { createInterface } from 'node:readline/promises'
import { hash } from 'bcryptjs'
import { eq } from 'drizzle-orm'
import { db } from '../src/lib/db'
import { users } from '../src/lib/db/schema'

async function main() {
  const rl = createInterface({ input: process.stdin, output: process.stdout })

  const name = await rl.question('Name: ')
  const email = (await rl.question('Email: ')).trim().toLowerCase()
  const password = await rl.question('Password: ')
  rl.close()

  if (password.length < 12) {
    console.error('Password must be at least 12 characters.')
    process.exit(1)
  }

  const existing = await db.select().from(users).where(eq(users.email, email)).get()
  if (existing) {
    console.error(`A user with ${email} already exists.`)
    process.exit(1)
  }

  const [user] = await db.insert(users)
    .values({ name, email, passwordHash: await hash(password, 12) })
    .returning({ id: users.id, email: users.email })

  console.log(`Created ${user.email} (${user.id})`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
```

- [ ] **Step 5: Verify it typechecks**

Run: `npx tsc --noEmit`
Expected: clean.

**No unit tests for this task.** `authorize` is a thin adapter over bcrypt and a single query, and testing it meaningfully means testing NextAuth. Task 10's bearer-token path — which is our own code and guards the endpoint the Shortcut calls — is where the auth testing effort goes.

- [ ] **Step 6: Commit**

```bash
git add src/lib/auth.ts src/app/api/auth src/types/next-auth.d.ts scripts/seed-users.ts
git commit -m "feat: add credentials auth and the user seed script"
```

---

### Task 10: Per-phone API tokens

**Files:**
- Create: `src/lib/db/queries/tokens.ts`, `src/lib/api-auth.ts`, `scripts/issue-token.ts`
- Test: `tests/api/tokens.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/api/tokens.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDb, type TestDb } from '../helpers/db'
import { issueToken, verifyToken, revokeToken } from '@/lib/db/queries/tokens'
import { users, apiTokens } from '@/lib/db/schema'

let db: TestDb
let userId: string

beforeEach(async () => {
  db = await createTestDb()
  const [user] = await db.insert(users)
    .values({ name: 'Zach', email: 'z@example.com', passwordHash: 'x' }).returning()
  userId = user.id
})

describe('issueToken', () => {
  it('returns a high-entropy token and stores only its hash', async () => {
    const { token } = await issueToken(db, userId, "Zach's iPhone")

    expect(token).toMatch(/^[A-Za-z0-9_-]{43,}$/)
    const [row] = await db.select().from(apiTokens).where(eq(apiTokens.userId, userId))
    expect(row.tokenHash).not.toContain(token)
    expect(row.label).toBe("Zach's iPhone")
  })

  it('produces a different token every time', async () => {
    const a = await issueToken(db, userId, 'a')
    const b = await issueToken(db, userId, 'b')
    expect(a.token).not.toBe(b.token)
  })
})

describe('verifyToken', () => {
  it('accepts a valid token and returns the owner', async () => {
    const { token } = await issueToken(db, userId, 'phone')
    expect(await verifyToken(db, token)).toEqual({ userId, tokenId: expect.any(String) })
  })

  it('rejects a wrong token', async () => {
    await issueToken(db, userId, 'phone')
    expect(await verifyToken(db, 'not-a-real-token')).toBeNull()
  })

  it('rejects an empty or malformed token without throwing', async () => {
    expect(await verifyToken(db, '')).toBeNull()
    expect(await verifyToken(db, '   ')).toBeNull()
  })

  it('rejects a revoked token', async () => {
    const { token, tokenId } = await issueToken(db, userId, 'lost phone')
    await revokeToken(db, tokenId)
    expect(await verifyToken(db, token)).toBeNull()
  })

  it('records last use', async () => {
    const { token } = await issueToken(db, userId, 'phone')
    await verifyToken(db, token)
    const [row] = await db.select().from(apiTokens).where(eq(apiTokens.userId, userId))
    expect(row.lastUsedAt).toBeInstanceOf(Date)
  })

  it('revoking one phone leaves the other working', async () => {
    const keep = await issueToken(db, userId, 'phone A')
    const lose = await issueToken(db, userId, 'phone B')
    await revokeToken(db, lose.tokenId)

    expect(await verifyToken(db, lose.token)).toBeNull()
    expect(await verifyToken(db, keep.token)).not.toBeNull()
  })
})
```

- [ ] **Step 2: Run and confirm it fails**

Run: `npx vitest run tests/api/tokens`
Expected: FAIL — unresolved import.

- [ ] **Step 3: Implement the token queries**

Create `src/lib/db/queries/tokens.ts`:

```ts
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto'
import { and, eq, isNull } from 'drizzle-orm'
import type { Db } from '@/lib/db'
import { apiTokens } from '@/lib/db/schema'

/**
 * SHA-256, not bcrypt.
 *
 * bcrypt's cost exists to slow brute force against low-entropy human passwords.
 * These tokens are 32 bytes from a CSPRNG — there is nothing to brute force —
 * and bcrypt would add ~100ms to every single import request for no security
 * gain. A fast digest plus a constant-time comparison is the right tool.
 */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export type IssuedToken = { token: string; tokenId: string }

export async function issueToken(db: Db, userId: string, label: string): Promise<IssuedToken> {
  const token = randomBytes(32).toString('base64url')
  const [row] = await db.insert(apiTokens)
    .values({ userId, label, tokenHash: hashToken(token) })
    .returning({ id: apiTokens.id })
  return { token, tokenId: row.id }
}

export type VerifiedToken = { userId: string; tokenId: string }

export async function verifyToken(db: Db, token: string): Promise<VerifiedToken | null> {
  const candidate = token?.trim()
  if (!candidate) return null

  const digest = hashToken(candidate)
  const row = await db.select().from(apiTokens)
    .where(and(eq(apiTokens.tokenHash, digest), isNull(apiTokens.revokedAt)))
    .get()
  if (!row) return null

  // The lookup above already matched on the digest, so this comparison is
  // belt-and-braces against any future change that widens the query.
  const a = Buffer.from(digest, 'hex')
  const b = Buffer.from(row.tokenHash, 'hex')
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null

  await db.update(apiTokens).set({ lastUsedAt: new Date() }).where(eq(apiTokens.id, row.id))
  return { userId: row.userId, tokenId: row.id }
}

export async function revokeToken(db: Db, tokenId: string): Promise<void> {
  await db.update(apiTokens).set({ revokedAt: new Date() }).where(eq(apiTokens.id, tokenId))
}
```

- [ ] **Step 4: Add the request-level helper**

Create `src/lib/api-auth.ts`:

```ts
import { db } from '@/lib/db'
import { verifyToken, type VerifiedToken } from '@/lib/db/queries/tokens'

/**
 * Authenticates a request carrying `Authorization: Bearer <token>`. Used by the
 * iOS Shortcut, which has no session cookie.
 */
export async function authenticateBearer(request: Request): Promise<VerifiedToken | null> {
  const header = request.headers.get('authorization') ?? ''
  const [scheme, value] = header.split(' ')
  if (scheme?.toLowerCase() !== 'bearer' || !value) return null
  return verifyToken(db, value)
}
```

- [ ] **Step 5: Write the token-minting script**

Create `scripts/issue-token.ts`:

```ts
#!/usr/bin/env tsx
import { eq } from 'drizzle-orm'
import { db } from '../src/lib/db'
import { users } from '../src/lib/db/schema'
import { issueToken } from '../src/lib/db/queries/tokens'

async function main() {
  const [email, ...labelParts] = process.argv.slice(2)
  const label = labelParts.join(' ')

  if (!email || !label) {
    console.error('Usage: npm run token -- <email> <label>')
    console.error('Example: npm run token -- zach@example.com "Zach\'s iPhone"')
    process.exit(1)
  }

  const user = await db.select().from(users).where(eq(users.email, email.toLowerCase())).get()
  if (!user) {
    console.error(`No user with email ${email}. Run npm run seed first.`)
    process.exit(1)
  }

  const { token } = await issueToken(db, user.id, label)

  console.log(`\nToken for ${user.email} — ${label}:\n`)
  console.log(token)
  console.log('\nThis is shown once and cannot be recovered. Put it in the iOS Shortcut now.')
  console.log('See docs/ios-shortcut.md.\n')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
```

- [ ] **Step 6: Run and commit**

Run: `npx vitest run tests/api/tokens`
Expected: PASS, 8 tests.

```bash
git add src/lib/db/queries/tokens.ts src/lib/api-auth.ts scripts/issue-token.ts tests/api/tokens.test.ts package.json
git commit -m "feat: add per-device API tokens with sha256 hashing and revocation"
```

---

### Task 11: The import pipeline

The composition root: the one place the pure extractor, the network, the LLM, storage, and the database meet.

**Files:**
- Create: `src/lib/import/run-import.ts`, `src/lib/db/queries/jobs.ts`
- Test: `tests/import/run-import.test.ts`

- [ ] **Step 1: Write the job queries**

Create `src/lib/db/queries/jobs.ts`:

```ts
import { desc, eq } from 'drizzle-orm'
import type { Db } from '@/lib/db'
import { importJobs } from '@/lib/db/schema'

export type FailureKind = 'blocked' | 'fetch_failed' | 'no_recipe' | 'llm_failed' | 'internal'

export async function createJob(db: Db, url: string, requestedBy: string | null) {
  const [row] = await db.insert(importJobs).values({ url, requestedBy }).returning()
  return row
}

export async function markRunning(db: Db, jobId: string) {
  await db.update(importJobs).set({ status: 'running' }).where(eq(importJobs.id, jobId))
}

export async function markDone(db: Db, jobId: string, recipeId: string) {
  await db.update(importJobs)
    .set({ status: 'done', recipeId, finishedAt: new Date(), error: null, failureKind: null })
    .where(eq(importJobs.id, jobId))
}

export async function markDuplicate(db: Db, jobId: string, recipeId: string) {
  await db.update(importJobs)
    .set({ status: 'duplicate', recipeId, finishedAt: new Date() })
    .where(eq(importJobs.id, jobId))
}

export async function markFailed(db: Db, jobId: string, kind: FailureKind, error: string) {
  await db.update(importJobs)
    .set({ status: 'failed', failureKind: kind, error: error.slice(0, 2000), finishedAt: new Date() })
    .where(eq(importJobs.id, jobId))
}

export async function listJobs(db: Db, limit = 50) {
  return db.select().from(importJobs).orderBy(desc(importJobs.createdAt)).limit(limit)
}

export async function getJob(db: Db, jobId: string) {
  return db.select().from(importJobs).where(eq(importJobs.id, jobId)).get()
}
```

- [ ] **Step 2: Write the failing test**

Create `tests/import/run-import.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { gunzipSync } from 'node:zlib'
import { createTestDb, type TestDb } from '../helpers/db'
import { createMemoryStore } from '@/lib/storage/memory'
import { runImport } from '@/lib/import/run-import'
import { createJob } from '@/lib/db/queries/jobs'
import { recipes, images, importJobs } from '@/lib/db/schema'
import { BlockedError, FetchFailedError } from '@/lib/fetch'
import type { LlmClient } from '@/lib/extract/llm-types'

let db: TestDb
beforeEach(async () => { db = await createTestDb() })

const RECIPE_PAGE = `<html><head><script type="application/ld+json">
{"@type":"Recipe","name":"Egg Korma","recipeIngredient":["2 eggs","1 cup yogurt"],
 "recipeInstructions":[{"@type":"HowToStep","text":"Boil the eggs."}],
 "totalTime":"PT50M","recipeCategory":"Main Course","image":"https://cdn.example.com/k.jpg"}
</script></head><body><article><p>${'A story about eggs. '.repeat(30)}</p></article></body></html>`

const noopLlm: LlmClient = {
  enrich: vi.fn().mockResolvedValue(null),
  extractRecipe: vi.fn().mockResolvedValue(null),
}

function deps(overrides: Partial<Parameters<typeof runImport>[0]> = {}) {
  return {
    db,
    store: createMemoryStore(),
    llm: noopLlm,
    fetchPage: vi.fn().mockResolvedValue({
      html: RECIPE_PAGE,
      bytes: new TextEncoder().encode(RECIPE_PAGE),
      encoding: 'utf-8',
      finalUrl: 'https://example.com/korma',
      status: 200,
    }),
    ingestHeroImage: vi.fn().mockResolvedValue({
      blobKey: 'recipes/x/hero.webp', thumbKey: 'recipes/x/hero-thumb.webp',
      width: 1200, height: 800,
    }),
    ...overrides,
  }
}

describe('runImport', () => {
  it('stores the recipe and marks the job done', async () => {
    const job = await createJob(db, 'https://example.com/korma', null)
    const d = deps()

    await runImport({ ...d, jobId: job.id, url: 'https://example.com/korma' })

    const [row] = await db.select().from(recipes)
    expect(row.title).toBe('Egg Korma')
    expect(row.claimedTimeMinutes).toBe(50)

    const [updated] = await db.select().from(importJobs).where(eq(importJobs.id, job.id))
    expect(updated.status).toBe('done')
    expect(updated.recipeId).toBe(row.id)
    expect(updated.finishedAt).toBeInstanceOf(Date)
  })

  it('archives the original bytes gzipped, not the decoded string', async () => {
    const job = await createJob(db, 'https://example.com/korma', null)
    const d = deps()

    await runImport({ ...d, jobId: job.id, url: 'https://example.com/korma' })

    const [row] = await db.select().from(recipes)
    expect(row.archivedHtmlKey).toBeTruthy()
    expect(row.sourceEncoding).toBe('utf-8')

    const stored = await d.store.get(row.archivedHtmlKey!)
    expect(gunzipSync(Buffer.from(stored!)).toString('utf8')).toBe(RECIPE_PAGE)
  })

  it('stores the hero image row', async () => {
    const job = await createJob(db, 'https://example.com/korma', null)
    await runImport({ ...deps(), jobId: job.id, url: 'https://example.com/korma' })

    const [image] = await db.select().from(images)
    expect(image.role).toBe('source_hero')
    expect(image.width).toBe(1200)
  })

  it('marks the job blocked when the publisher refuses us', async () => {
    const job = await createJob(db, 'https://allrecipes.com/x', null)
    const d = deps({
      fetchPage: vi.fn().mockRejectedValue(new BlockedError('https://allrecipes.com/x', 403)),
    })

    await runImport({ ...d, jobId: job.id, url: 'https://allrecipes.com/x' })

    const [updated] = await db.select().from(importJobs).where(eq(importJobs.id, job.id))
    expect(updated.status).toBe('failed')
    expect(updated.failureKind).toBe('blocked')
    expect(await db.select().from(recipes)).toHaveLength(0)
  })

  it('distinguishes a transient fetch failure from a block', async () => {
    const job = await createJob(db, 'https://example.com/x', null)
    const d = deps({
      fetchPage: vi.fn().mockRejectedValue(new FetchFailedError('https://example.com/x', 'HTTP 500')),
    })

    await runImport({ ...d, jobId: job.id, url: 'https://example.com/x' })

    const [updated] = await db.select().from(importJobs).where(eq(importJobs.id, job.id))
    expect(updated.failureKind).toBe('fetch_failed')
  })

  it('marks no_recipe when the page has none', async () => {
    const job = await createJob(db, 'https://example.com/blog', null)
    const html = '<html><body><p>Just a blog post.</p></body></html>'
    const d = deps({
      fetchPage: vi.fn().mockResolvedValue({
        html, bytes: new TextEncoder().encode(html), encoding: 'utf-8',
        finalUrl: 'https://example.com/blog', status: 200,
      }),
    })

    await runImport({ ...d, jobId: job.id, url: 'https://example.com/blog' })

    const [updated] = await db.select().from(importJobs).where(eq(importJobs.id, job.id))
    expect(updated.failureKind).toBe('no_recipe')
  })

  it('uses phone-supplied html and skips the fetch entirely', async () => {
    const job = await createJob(db, 'https://allrecipes.com/x', null)
    const d = deps({
      fetchPage: vi.fn().mockRejectedValue(new BlockedError('https://allrecipes.com/x', 403)),
    })

    await runImport({
      ...d, jobId: job.id, url: 'https://allrecipes.com/x', suppliedHtml: RECIPE_PAGE,
    })

    expect(d.fetchPage).not.toHaveBeenCalled()
    const [row] = await db.select().from(recipes)
    expect(row.title).toBe('Egg Korma')
  })

  it('records that enrichment did not run when the LLM fails', async () => {
    const job = await createJob(db, 'https://example.com/korma', null)
    const d = deps({
      llm: { enrich: vi.fn().mockRejectedValue(new Error('429')), extractRecipe: vi.fn() },
    })

    await runImport({ ...d, jobId: job.id, url: 'https://example.com/korma' })

    const [row] = await db.select().from(recipes)
    expect(row.enrichmentApplied).toBe(false)

    const [updated] = await db.select().from(importJobs).where(eq(importJobs.id, job.id))
    expect(updated.status).toBe('done')
  })

  it('still stores the recipe when the image cannot be ingested', async () => {
    const job = await createJob(db, 'https://example.com/korma', null)
    const d = deps({ ingestHeroImage: vi.fn().mockResolvedValue(null) })

    await runImport({ ...d, jobId: job.id, url: 'https://example.com/korma' })

    expect(await db.select().from(recipes)).toHaveLength(1)
    expect(await db.select().from(images)).toHaveLength(0)
    const [updated] = await db.select().from(importJobs).where(eq(importJobs.id, job.id))
    expect(updated.status).toBe('done')
  })

  it('never throws, whatever goes wrong', async () => {
    const job = await createJob(db, 'https://example.com/x', null)
    const d = deps({ fetchPage: vi.fn().mockRejectedValue(new Error('something unexpected')) })

    await expect(
      runImport({ ...d, jobId: job.id, url: 'https://example.com/x' }),
    ).resolves.not.toThrow()

    const [updated] = await db.select().from(importJobs).where(eq(importJobs.id, job.id))
    expect(updated.failureKind).toBe('internal')
  })
})
```

- [ ] **Step 3: Run and confirm it fails**

Run: `npx vitest run tests/import`
Expected: FAIL — unresolved import.

- [ ] **Step 4: Implement the pipeline**

Create `src/lib/import/run-import.ts`:

```ts
import { gzipSync } from 'node:zlib'
import { extract, NoRecipeFoundError } from '@/lib/extract'
import type { LlmClient } from '@/lib/extract/llm-types'
import { BlockedError, FetchFailedError, type FetchedPage } from '@/lib/fetch'
import type { BlobStore } from '@/lib/storage'
import type { Db } from '@/lib/db'
import { images } from '@/lib/db/schema'
import { upsertRecipe } from '@/lib/db/queries/recipes'
import { markDone, markFailed, markRunning } from '@/lib/db/queries/jobs'
import { normalizeSourceUrl } from '@/lib/url'
import type { IngestedImage } from '@/lib/images'

export type RunImportInput = {
  db: Db
  store: BlobStore
  llm: LlmClient
  jobId: string
  url: string
  addedBy?: string | null
  /**
   * Page HTML captured on the user's phone. Publishers that block datacenter
   * IPs (measured: Allrecipes, Simply Recipes) cannot be fetched server-side at
   * all, so the Shortcut sends the page it can already see. When present, we
   * skip the network entirely.
   */
  suppliedHtml?: string | null
  fetchPage: (url: string) => Promise<FetchedPage>
  ingestHeroImage: (input: {
    url: string; recipeId: string; store: BlobStore
  }) => Promise<IngestedImage | null>
}

/**
 * Runs one import to completion and records the outcome on the job.
 *
 * **This function never throws.** It runs detached in the background after the
 * request has already returned 202, so a thrown error would vanish into an
 * unhandled rejection with the job stuck on `running` forever. Every failure
 * becomes a job row with a `failureKind` the needs-attention tray can act on.
 */
export async function runImport(input: RunImportInput): Promise<void> {
  const { db, store, llm, jobId, url, suppliedHtml } = input

  try {
    await markRunning(db, jobId)

    let page: FetchedPage
    if (suppliedHtml) {
      page = {
        html: suppliedHtml,
        bytes: new TextEncoder().encode(suppliedHtml),
        encoding: 'utf-8',
        finalUrl: url,
        status: 200,
      }
    } else {
      try {
        page = await input.fetchPage(url)
      } catch (error) {
        if (error instanceof BlockedError) {
          await markFailed(db, jobId, 'blocked', error.message)
          return
        }
        if (error instanceof FetchFailedError) {
          await markFailed(db, jobId, 'fetch_failed', error.message)
          return
        }
        throw error
      }
    }

    let extracted
    try {
      extracted = await extract({ url, html: page.html, llm })
    } catch (error) {
      if (error instanceof NoRecipeFoundError) {
        await markFailed(db, jobId, 'no_recipe', error.message)
        return
      }
      throw error
    }

    // Enrichment failures are swallowed inside extract(), so the only signal we
    // get is whether the parsed fields actually arrived. Recording it means the
    // migration's dry-run report and the needs-attention tray can distinguish
    // "this recipe has no quantities" from "the model was rate limited".
    const enrichmentApplied = extracted.ingredients.some((i) => i.quantity !== null || i.item !== null)

    const { url: canonicalUrl, domain } = normalizeSourceUrl(page.finalUrl || url)

    const archivedHtmlKey = `sources/${encodeURIComponent(canonicalUrl)}.html.gz`
    await store.put(archivedHtmlKey, new Uint8Array(gzipSync(Buffer.from(page.bytes))), 'application/gzip')

    const recipeId = await upsertRecipe(db, {
      extracted,
      sourceUrl: canonicalUrl,
      sourceDomain: domain,
      archivedHtmlKey,
      sourceEncoding: page.encoding,
      enrichmentApplied,
      addedBy: input.addedBy ?? null,
    })

    if (extracted.heroImageUrl) {
      const image = await input.ingestHeroImage({
        url: extracted.heroImageUrl, recipeId, store,
      })
      if (image) {
        await db.insert(images).values({
          recipeId, role: 'source_hero',
          blobKey: image.blobKey, thumbKey: image.thumbKey,
          width: image.width, height: image.height,
        })
      }
    }

    await markDone(db, jobId, recipeId)
  } catch (error) {
    await markFailed(
      db, jobId, 'internal',
      error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    ).catch(() => {})
  }
}
```

- [ ] **Step 5: Run and commit**

Run: `npx vitest run tests/import`
Expected: PASS, 10 tests.

```bash
git add src/lib/import src/lib/db/queries/jobs.ts tests/import
git commit -m "feat: add the import pipeline with typed failure kinds"
```

---

### Task 12: `POST /api/import`

**Files:**
- Create: `src/app/api/import/route.ts`
- Test: `tests/api/import-route.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/api/import-route.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest'

const state = vi.hoisted(() => ({
  verified: null as { userId: string; tokenId: string } | null,
  ran: [] as Array<{ url: string; suppliedHtml?: string | null }>,
  existing: null as { id: string } | null,
  jobId: 'job-1',
}))

vi.mock('@/lib/api-auth', () => ({
  authenticateBearer: vi.fn(async () => state.verified),
}))
vi.mock('@/lib/db', () => ({ db: {} }))
vi.mock('@/lib/db/queries/recipes', () => ({
  findBySourceUrl: vi.fn(async () => state.existing),
}))
vi.mock('@/lib/db/queries/jobs', () => ({
  createJob: vi.fn(async () => ({ id: state.jobId })),
  markDuplicate: vi.fn(async () => {}),
}))
vi.mock('@/lib/import/run-import', () => ({
  runImport: vi.fn(async (input: { url: string; suppliedHtml?: string | null }) => {
    state.ran.push({ url: input.url, suppliedHtml: input.suppliedHtml })
  }),
}))

const { POST } = await import('@/app/api/import/route')

function request(body: unknown, auth = 'Bearer good') {
  return new Request('https://app.test/api/import', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: auth },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  state.verified = { userId: 'user-1', tokenId: 'tok-1' }
  state.ran = []
  state.existing = null
})

describe('POST /api/import', () => {
  it('returns 202 with a job id', async () => {
    const response = await POST(request({ url: 'https://example.com/korma' }))
    expect(response.status).toBe(202)
    await expect(response.json()).resolves.toMatchObject({ jobId: 'job-1', status: 'queued' })
  })

  it('rejects an unauthenticated request', async () => {
    state.verified = null
    const response = await POST(request({ url: 'https://example.com/x' }, 'Bearer bad'))
    expect(response.status).toBe(401)
    expect(state.ran).toHaveLength(0)
  })

  it('rejects a missing url', async () => {
    expect((await POST(request({}))).status).toBe(400)
  })

  it('rejects a url that is not a url', async () => {
    expect((await POST(request({ url: 'not a url' }))).status).toBe(400)
  })

  it('normalizes the url before processing', async () => {
    await POST(request({ url: 'https://www.example.com/korma/?utm_source=x#jump' }))
    expect(state.ran[0].url).toBe('https://example.com/korma')
  })

  it('reports an already-saved recipe without re-importing', async () => {
    state.existing = { id: 'recipe-9' }
    const response = await POST(request({ url: 'https://example.com/korma' }))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      status: 'duplicate', recipeId: 'recipe-9',
    })
    expect(state.ran).toHaveLength(0)
  })

  it('passes phone-supplied html through', async () => {
    await POST(request({ url: 'https://example.com/k', html: '<html>from phone</html>' }))
    expect(state.ran[0].suppliedHtml).toBe('<html>from phone</html>')
  })

  it('rejects an oversized html payload', async () => {
    const huge = 'x'.repeat(6 * 1024 * 1024)
    expect((await POST(request({ url: 'https://example.com/k', html: huge }))).status).toBe(413)
  })

  it('rejects a malformed json body without throwing', async () => {
    const bad = new Request('https://app.test/api/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer good' },
      body: '{ not json',
    })
    expect((await POST(bad)).status).toBe(400)
  })
})
```

- [ ] **Step 2: Run and confirm it fails**

Run: `npx vitest run tests/api/import-route`
Expected: FAIL — unresolved import.

- [ ] **Step 3: Implement the route**

Create `src/app/api/import/route.ts`:

```ts
import { waitUntil } from '@vercel/functions'
import { z } from 'zod'
import { authenticateBearer } from '@/lib/api-auth'
import { db } from '@/lib/db'
import { findBySourceUrl } from '@/lib/db/queries/recipes'
import { createJob, markDuplicate } from '@/lib/db/queries/jobs'
import { runImport } from '@/lib/import/run-import'
import { normalizeSourceUrl } from '@/lib/url'
import { fetchPage } from '@/lib/fetch'
import { ingestHeroImage } from '@/lib/images'
import { createAnthropicClient } from '@/lib/llm/anthropic-client'
import { createVercelBlobStore } from '@/lib/storage/vercel-blob'

const MAX_SUPPLIED_HTML_BYTES = 5 * 1024 * 1024

const bodySchema = z.object({
  url: z.string().min(1),
  html: z.string().optional().nullable(),
})

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/**
 * Accepts a recipe URL and answers immediately.
 *
 * The 202-and-continue shape is driven by how this is actually used: the caller
 * is an iOS Shortcut invoked from a share sheet, often on cellular in a grocery
 * aisle. Fetching, parsing, enriching, and storing an image takes 5–20 seconds,
 * and making someone watch a spinner for that — or worse, having a slow blog
 * look like a failure — would be a worse experience than Notion's clipper,
 * which is the thing we are replacing.
 */
export async function POST(request: Request): Promise<Response> {
  const auth = await authenticateBearer(request)
  if (!auth) return json({ error: 'unauthorized' }, 401)

  let raw: unknown
  try {
    raw = await request.json()
  } catch {
    return json({ error: 'invalid json body' }, 400)
  }

  const parsed = bodySchema.safeParse(raw)
  if (!parsed.success) return json({ error: 'url is required' }, 400)

  const suppliedHtml = parsed.data.html ?? null
  if (suppliedHtml && Buffer.byteLength(suppliedHtml, 'utf8') > MAX_SUPPLIED_HTML_BYTES) {
    return json({ error: 'supplied html too large' }, 413)
  }

  let canonical: { url: string; domain: string }
  try {
    canonical = normalizeSourceUrl(parsed.data.url)
  } catch {
    return json({ error: 'url is not valid' }, 400)
  }

  const existing = await findBySourceUrl(db, canonical.url)
  if (existing) {
    const job = await createJob(db, canonical.url, auth.userId)
    await markDuplicate(db, job.id, existing.id)
    return json({ status: 'duplicate', jobId: job.id, recipeId: existing.id }, 200)
  }

  const job = await createJob(db, canonical.url, auth.userId)

  waitUntil(
    runImport({
      db,
      store: createVercelBlobStore(),
      llm: createAnthropicClient(),
      jobId: job.id,
      url: canonical.url,
      addedBy: auth.userId,
      suppliedHtml,
      fetchPage,
      ingestHeroImage,
    }),
  )

  return json({ status: 'queued', jobId: job.id }, 202)
}
```

- [ ] **Step 4: Run and commit**

Run: `npx vitest run tests/api/import-route`
Expected: PASS, 9 tests.

```bash
git add src/app/api/import tests/api/import-route.test.ts
git commit -m "feat: add POST /api/import returning 202 with background processing"
```

---

### Task 13: Job listing and retry

**Files:**
- Create: `src/app/api/jobs/route.ts`, `src/app/api/jobs/[id]/retry/route.ts`
- Test: `tests/api/jobs-route.test.ts`

- [ ] **Step 1: Implement the listing route**

Create `src/app/api/jobs/route.ts`:

```ts
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { listJobs } from '@/lib/db/queries/jobs'

export async function GET(): Promise<Response> {
  const session = await auth()
  if (!session?.user) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401, headers: { 'content-type': 'application/json' },
    })
  }

  return new Response(JSON.stringify({ jobs: await listJobs(db) }), {
    status: 200, headers: { 'content-type': 'application/json' },
  })
}
```

- [ ] **Step 2: Implement the retry route**

Create `src/app/api/jobs/[id]/retry/route.ts`:

```ts
import { waitUntil } from '@vercel/functions'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { getJob } from '@/lib/db/queries/jobs'
import { runImport } from '@/lib/import/run-import'
import { fetchPage } from '@/lib/fetch'
import { ingestHeroImage } from '@/lib/images'
import { createAnthropicClient } from '@/lib/llm/anthropic-client'
import { createVercelBlobStore } from '@/lib/storage/vercel-blob'

const MAX_SUPPLIED_HTML_BYTES = 5 * 1024 * 1024

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
  })
}

/**
 * Retries a failed import, optionally with page HTML pasted in by hand.
 *
 * That second path is the recovery route for `blocked` jobs: the publisher will
 * refuse our server every time, so retrying unchanged is pointless. Supplying
 * the HTML from a browser that can see the page is the only thing that works.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const session = await auth()
  if (!session?.user) return json({ error: 'unauthorized' }, 401)

  const { id } = await params
  const job = await getJob(db, id)
  if (!job) return json({ error: 'no such job' }, 404)
  if (job.status === 'running') return json({ error: 'already running' }, 409)

  let suppliedHtml: string | null = null
  if (request.headers.get('content-type')?.includes('application/json')) {
    try {
      const body = (await request.json()) as { html?: unknown }
      if (typeof body.html === 'string' && body.html.length > 0) suppliedHtml = body.html
    } catch {
      return json({ error: 'invalid json body' }, 400)
    }
  }

  if (suppliedHtml && Buffer.byteLength(suppliedHtml, 'utf8') > MAX_SUPPLIED_HTML_BYTES) {
    return json({ error: 'supplied html too large' }, 413)
  }

  waitUntil(
    runImport({
      db,
      store: createVercelBlobStore(),
      llm: createAnthropicClient(),
      jobId: job.id,
      url: job.url,
      addedBy: session.user.id,
      suppliedHtml,
      fetchPage,
      ingestHeroImage,
    }),
  )

  return json({ status: 'queued', jobId: job.id }, 202)
}
```

- [ ] **Step 3: Write the test**

Create `tests/api/jobs-route.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest'

const state = vi.hoisted(() => ({
  session: null as { user: { id: string } } | null,
  job: null as { id: string; url: string; status: string } | null,
  ran: [] as Array<{ jobId: string; suppliedHtml?: string | null }>,
}))

vi.mock('@/lib/auth', () => ({ auth: vi.fn(async () => state.session) }))
vi.mock('@/lib/db', () => ({ db: {} }))
vi.mock('@/lib/db/queries/jobs', () => ({
  listJobs: vi.fn(async () => [{ id: 'j1', status: 'failed', failureKind: 'blocked' }]),
  getJob: vi.fn(async () => state.job),
}))
vi.mock('@/lib/import/run-import', () => ({
  runImport: vi.fn(async (i: { jobId: string; suppliedHtml?: string | null }) => {
    state.ran.push({ jobId: i.jobId, suppliedHtml: i.suppliedHtml })
  }),
}))
vi.mock('@/lib/storage/vercel-blob', () => ({ createVercelBlobStore: () => ({}) }))
vi.mock('@/lib/llm/anthropic-client', () => ({ createAnthropicClient: () => ({}) }))

const { GET } = await import('@/app/api/jobs/route')
const { POST } = await import('@/app/api/jobs/[id]/retry/route')

const params = Promise.resolve({ id: 'j1' })
const retryRequest = (body?: unknown) =>
  new Request('https://app.test/api/jobs/j1/retry', {
    method: 'POST',
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  })

beforeEach(() => {
  state.session = { user: { id: 'u1' } }
  state.job = { id: 'j1', url: 'https://allrecipes.com/x', status: 'failed' }
  state.ran = []
})

describe('GET /api/jobs', () => {
  it('lists jobs for a signed-in user', async () => {
    const response = await GET()
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ jobs: [{ id: 'j1' }] })
  })

  it('rejects an anonymous request', async () => {
    state.session = null
    expect((await GET()).status).toBe(401)
  })
})

describe('POST /api/jobs/:id/retry', () => {
  it('re-queues a failed job', async () => {
    const response = await POST(retryRequest(), { params })
    expect(response.status).toBe(202)
    expect(state.ran).toEqual([{ jobId: 'j1', suppliedHtml: null }])
  })

  it('accepts pasted html for a blocked publisher', async () => {
    await POST(retryRequest({ html: '<html>pasted</html>' }), { params })
    expect(state.ran[0].suppliedHtml).toBe('<html>pasted</html>')
  })

  it('404s for an unknown job', async () => {
    state.job = null
    expect((await POST(retryRequest(), { params })).status).toBe(404)
  })

  it('refuses to retry a job that is already running', async () => {
    state.job = { id: 'j1', url: 'https://x.com', status: 'running' }
    expect((await POST(retryRequest(), { params })).status).toBe(409)
    expect(state.ran).toHaveLength(0)
  })

  it('rejects an anonymous retry', async () => {
    state.session = null
    expect((await POST(retryRequest(), { params })).status).toBe(401)
  })
})
```

- [ ] **Step 4: Run and commit**

Run: `npx vitest run tests/api/jobs-route`
Expected: PASS, 7 tests.

```bash
git add src/app/api/jobs tests/api/jobs-route.test.ts
git commit -m "feat: add job listing and retry with pasted-html recovery"
```

---

### Task 14: Bound `extract()` in time

Carried from plan 1's review. Measured there: `@mozilla/readability` is superlinear in block count, and a 3 MB page of flat blocks costs **101 seconds** of CPU. The fetch layer's byte cap admits such a page, and under `waitUntil` the job would sit on `running` past the platform timeout, never reaching the tray.

**Files:**
- Modify: `src/lib/import/run-import.ts`
- Test: `tests/import/timeout.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/import/timeout.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDb, type TestDb } from '../helpers/db'
import { createMemoryStore } from '@/lib/storage/memory'
import { runImport } from '@/lib/import/run-import'
import { createJob } from '@/lib/db/queries/jobs'
import { importJobs, recipes } from '@/lib/db/schema'
import type { LlmClient } from '@/lib/extract/llm-types'

let db: TestDb
beforeEach(async () => { db = await createTestDb() })

const noopLlm: LlmClient = {
  enrich: vi.fn().mockResolvedValue(null),
  extractRecipe: vi.fn().mockResolvedValue(null),
}

describe('runImport extraction budget', () => {
  it('fails the job instead of hanging when extraction exceeds its budget', async () => {
    const job = await createJob(db, 'https://example.com/huge', null)

    // A page that is syntactically fine but pathologically expensive to parse.
    const html = `<html><body><article>${'<p>filler sentence here.</p>'.repeat(60_000)}</article></body></html>`

    await runImport({
      db,
      store: createMemoryStore(),
      llm: noopLlm,
      jobId: job.id,
      url: 'https://example.com/huge',
      extractBudgetMs: 50,
      fetchPage: vi.fn().mockResolvedValue({
        html, bytes: new TextEncoder().encode(html), encoding: 'utf-8',
        finalUrl: 'https://example.com/huge', status: 200,
      }),
      ingestHeroImage: vi.fn().mockResolvedValue(null),
    })

    const [updated] = await db.select().from(importJobs).where(eq(importJobs.id, job.id))
    expect(updated.status).toBe('failed')
    expect(updated.failureKind).toBe('internal')
    expect(updated.error).toMatch(/budget|timed out/i)
    expect(await db.select().from(recipes)).toHaveLength(0)
  }, 30_000)
})
```

- [ ] **Step 2: Run and confirm it fails**

Run: `npx vitest run tests/import/timeout`
Expected: FAIL — `extractBudgetMs` is not accepted, and the call runs to completion.

- [ ] **Step 3: Add the budget**

In `src/lib/import/run-import.ts`, add to `RunImportInput`:

```ts
  /**
   * Wall-clock ceiling for extraction. Readability is superlinear in block
   * count — a 3MB page of flat blocks measured 101 seconds — and the fetch
   * layer's byte cap admits such a page. Without this, the job sits on
   * `running` until the platform kills the function and never reaches the tray.
   */
  extractBudgetMs?: number
```

Add the helper:

```ts
const DEFAULT_EXTRACT_BUDGET_MS = 25_000

class ExtractionBudgetExceeded extends Error {
  constructor(ms: number) {
    super(`Extraction exceeded its ${ms}ms budget`)
    this.name = 'ExtractionBudgetExceeded'
  }
}

function withBudget<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ExtractionBudgetExceeded(ms)), ms)
    work.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error) => { clearTimeout(timer); reject(error) },
    )
  })
}
```

Replace the extraction call:

```ts
    const budgetMs = input.extractBudgetMs ?? DEFAULT_EXTRACT_BUDGET_MS

    let extracted
    try {
      extracted = await withBudget(extract({ url, html: page.html, llm }), budgetMs)
    } catch (error) {
      if (error instanceof NoRecipeFoundError) {
        await markFailed(db, jobId, 'no_recipe', error.message)
        return
      }
      throw error
    }
```

**Be honest about the limit in a comment:** `extract()` is synchronous CPU work, so the timer cannot interrupt it — the promise rejects, the job is marked failed and the tray gets a real signal, but the event loop stays blocked until the parse finishes. Genuinely preempting it needs a worker thread. This converts a silent hang into a recorded failure, which is the valuable half; note the remaining gap for plan 3.

- [ ] **Step 4: Run and commit**

Run: `npx vitest run tests/import`
Expected: PASS, 11 tests.

```bash
git add src/lib/import/run-import.ts tests/import/timeout.test.ts
git commit -m "feat: bound extraction in time so a pathological page fails visibly"
```

---

### Task 15: The iOS Shortcut, and end-to-end verification

**Files:**
- Create: `docs/ios-shortcut.md`
- Modify: `docs/superpowers/plans/2026-08-25-persistence-and-import.md` (record the findings)

- [ ] **Step 1: Provision a database and run the migrations**

Either create a Turso database and set `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN`, or for local development set `TURSO_DATABASE_URL=file:./local.db` and leave the token blank.

```bash
cp .env.example .env.local
# fill in TURSO_DATABASE_URL, ANTHROPIC_API_KEY, AUTH_SECRET (openssl rand -base64 32)
npm run db:migrate
```

- [ ] **Step 2: Create the two accounts and issue tokens**

```bash
npm run seed          # run twice, once per person
npm run token -- zach@example.com "Zach's iPhone"
```

Record each token immediately — it is shown once.

- [ ] **Step 3: Write the Shortcut documentation**

Create `docs/ios-shortcut.md`:

```markdown
# Saving recipes from your iPhone

iOS Safari cannot register a web app as a share-sheet target, so the app uses a
Shortcut instead. Setup takes about a minute per phone and only has to be done
once. After that, saving a recipe is: **Share → Save to Recipes**.

## Building the Shortcut

1. Open **Shortcuts** and create a new shortcut named **Save to Recipes**.
2. Open the shortcut's settings (the ⓘ icon) and turn on **Show in Share Sheet**.
3. Set **Accepted Types** to **URLs** only — this keeps it out of the share
   sheet for photos and text, where it would be noise.
4. Add a **Get Contents of URL** action and configure it:
   - **URL:** `https://<your-app-domain>/api/import`
   - **Method:** `POST`
   - **Headers:**
     - `Authorization` → `Bearer <the token from npm run token>`
     - `Content-Type` → `application/json`
   - **Request Body:** `JSON`
     - Key `url`, type Text, value **Shortcut Input**
5. Add a **Show Notification** action so you get confirmation rather than
   silence. Body: **Contents of URL**.

## Why it answers instantly

The API returns `202 Accepted` as soon as the job is recorded, then does the
fetching, parsing, and image work in the background. You get a confirmation in
about a second even on cellular, and the recipe appears in the app shortly
after. If something fails, it shows up in the needs-attention list rather than
disappearing.

## Blocked publishers

Some publishers refuse requests from datacenter IP addresses — measured so far:
Allrecipes and Simply Recipes. Those imports land in the needs-attention list
marked `blocked`, and are recovered by opening the page in a browser and pasting
its HTML into the retry form.

If this turns out to be common, a second Shortcut variant can send the page text
along with the URL, adding a **Get Contents of Web Page** action and a `html`
key in the JSON body. The API already accepts that field.

## Replacing a token

Tokens are per-phone. If a phone is lost, revoke just that token — the other
phone is unaffected. Issue a replacement with
`npm run token -- <email> "<label>"` and update the Shortcut's header.
```

- [ ] **Step 4: Verify end to end from a real phone**

Start the app (`npm run dev` with a tunnel, or deploy to Vercel), then run the Shortcut on a real recipe.

Verify and record:
- The Shortcut returns a confirmation in roughly a second.
- The job goes `queued` → `running` → `done`.
- The recipe row has ingredients, steps, tags, and an `archived_html_key`.
- The hero image is in blob storage and the `images` row points at it.
- Sharing the **same** recipe again returns `duplicate` and creates no second row.

- [ ] **Step 5: Settle the open question from plan 1**

Plan 1 measured that Bon Appétit fetches cleanly **from a residential IP**, and flagged that this does not prove a deployed function can fetch it, since Condé Nast blocks datacenter ranges.

From the deployed environment, import one Bon Appétit URL and record the outcome:

```
https://www.bonappetit.com/recipe/bas-best-bolognese
```

- **`done`** → the phone-supplied-HTML path stays a rarely-used fallback, needed only for Allrecipes and Simply Recipes.
- **`failed` / `blocked`** → 28% of the library cannot be imported server-side, and the second Shortcut variant that sends page HTML becomes the primary capture path for Condé Nast. Build it before the migration in plan 3.

Write the answer into this plan's handoff section either way. Plan 3's migration of 156 recipes depends on it.

- [ ] **Step 6: Commit**

```bash
git add docs/ios-shortcut.md docs/superpowers/plans/2026-08-25-persistence-and-import.md
git commit -m "docs: add iOS Shortcut setup and record the deployed-fetch result"
```

---

## Definition of done

- `npm test` passes; `npx tsc --noEmit` and `npx eslint src scripts` clean.
- `src/lib/extract` imports nothing impure — enforced by `purity.test.ts`, not convention.
- Sharing a URL from a phone creates a recipe with ingredients, steps, tags, an archived source blob, and a hero image.
- Sharing the same URL twice creates one row.
- A blocked publisher produces a `failed` job with `failureKind: 'blocked'`, never a silent nothing.
- Enrichment failure produces a stored recipe with `enrichment_applied = false`, not a failed import.
- The deployed-fetch answer for Bon Appétit is recorded.

## Decisions made during execution

Findings raised by implementers and deliberately declined, recorded so they are
not silently re-raised or silently fixed later.

- **A revoked token that is presented again leaves no trace.** `verifyToken`
  filters on `revokedAt IS NULL`, so it returns null before stamping
  `lastUsedAt`. Arguably a stolen phone still trying is the more interesting
  security signal. Declined: there is no alerting or audit surface to consume
  it, and recording a timestamp nobody reads is observability without a
  consumer. Revisit only if an audit view is ever built.

- **Text enums are enforced by TypeScript, not by SQLite CHECK constraints.**
  `status`, `extractionMethod`, `facet`, `role`, and `failureKind` accept any
  string from raw SQL or a bad cast. Declined: Drizzle generates no CHECK for
  these, so adding them means hand-editing generated migrations, which then
  drift from the schema snapshot and break future `db:generate`. Every write
  goes through typed code, and the drift cost outweighs the residual risk for a
  two-user app.

- **`searchRecipes` sanitizes rather than the UI.** Raw input to FTS5 `MATCH`
  throws on ordinary inputs — a bare `and`, a stray `(`. This is fixed at the
  query layer, next to the table, rather than left for the search box in plan 3.

## Handoff to plan 3

Plan 3 builds the UI (library grid with the filter rail, recipe page, needs-attention screens) and migrates the 156 Notion recipes.

- **The deployed-fetch result from Task 15, Step 5** decides whether the migration can run server-side or needs browser-captured HTML for Condé Nast.
- **Notion `Link` values are not all bare URLs** — at least two are markdown `[url](url)`. Unwrap before `normalizeSourceUrl`.
- **`narrativeHtml` needs attribute-level sanitization on render.** Readability strips `<script>` and `<style>` but inline `onclick`/`onerror` survive. Ingredient `rawText` and step text are also untrusted; render as text, never `dangerouslySetInnerHTML`.
- **`extract()`'s time budget rejects but does not preempt.** A pathological page still blocks the event loop until the parse finishes. If it happens in practice, move extraction to a worker thread.
- **The enrichment signal is inferred**, not reported: `enrichmentApplied` is derived from whether parsed ingredient fields arrived. If plan 3's dry-run report needs finer detail, have `applyEnrichment` return an outcome instead.
- **`BlobStore.get` is unimplemented for Vercel Blob.** If the migration re-extracts from archived HTML, implement it.
- Deferred from plan 1 and still open: RDFa is specified but unimplemented; the fetch cap measures after buffering; fixture publisher coverage is narrow (no Allrecipes or Simply Recipes fixture).
