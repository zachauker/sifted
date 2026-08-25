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
