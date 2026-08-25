# Winding down the Notion migration

This app used to live in a shared Notion database. The one-time migration that
moved all 156 recipes out of it is described in
`docs/superpowers/plans/2026-08-25-notion-migration.md`. This note is about
what to do around that migration — the order to run things in, and what to
clean up (and, more importantly, what *not* to clean up) once it's done.

## Running the migration

Run these in order. Each step depends on the one before it having gone well.

1. **Dry run.**

   ```bash
   npm run migrate -- --dry-run
   ```

   This fetches all 156 rows from Notion, attempts extraction against each
   source URL with a no-op LLM client, and writes nothing — no database, no
   blob storage, no model spend. It produces `docs/migration-report.md` and a
   stdout summary: how many recipes extracted cleanly, how many will need a
   model call, how many sources are dead or blocked, and how many will have to
   be recovered from their Notion page body instead of their source.

   The dry run is free and repeatable. Run it again after any fix.

2. **Read the report.** This is a checkpoint, not a formality. Read
   `docs/migration-report.md` before running the real migration — if a
   class (dead links, blocked publishers, notion-body-only) is much larger
   than expected, that's a sign to revisit the plan before spending model
   calls and writing 156 rows.

3. **Migrate.**

   ```bash
   npm run migrate
   ```

   This is the real run: it imports every recipe, applies Notion-only
   metadata (rating, cooking status, tags, original creation date) on top,
   and recovers from the Notion page body wherever the source import failed.
   It writes a resume file as it goes, so a run that stops partway through
   (a crash, a rate limit exhausted after retries) can be re-run without
   re-importing what already succeeded or spending model calls twice.

4. **Verify.**

   ```bash
   npm run migrate:verify
   ```

   Reports, from the database itself: the total recipe count against the
   expected 156; coverage of source URLs, hero images, narratives, and
   archived source blobs; the facet distribution; rating and status counts
   reconciled against the Notion source (74 rated, 76 Made It, 69 Want to
   Make); the oldest and newest `created_at` (should span 2019-11-09 to
   2026-08-23, not collapse to the migration date); any recipe with no
   ingredients or no steps; and the extraction-method breakdown, so it's
   visible how many recipes were recovered from a Notion body rather than
   their source.

   The headline number is recipes with **zero tags** and recipes with
   `enrichment_applied = false`. A rate-limited migration burst produces
   recipes that store cleanly and report success while carrying no parsed
   quantities and no tags — nothing fails, nothing is logged, and the only
   symptom is a filter rail that quietly under-counts. This is the failure
   the verification script is built to catch loudly.

   **156 in means 156 accounted for.** Every one of the source's 156 rows
   must end up imported, recovered from a Notion body, or explicitly listed
   in the migration's own report/resume file as unrecoverable with a reason.
   A total that doesn't match 156 is not a rounding error — reconcile it
   before calling the migration done.

5. **Repair unenriched recipes.**

   ```bash
   npx tsx --env-file-if-exists=.env.local scripts/list-unenriched.ts
   ```

   For every recipe this lists that still has a source URL, re-import it —
   that re-runs the enrichment pass and overwrites the recipe in place,
   keeping its id, slug, rating, status, and notes.
   `EnrichmentRegressionError` guards against a re-import ever making an
   already-enriched recipe worse, so repairing is safe to run repeatedly.
   A recipe with no source URL (recovered from a Notion body) can't be
   repaired this way — it stays as-is, which is expected.

   Re-run `npm run migrate:verify` afterward and compare the before/after
   counts.

The `package.json` entries these commands assume — `migrate`,
`migrate:verify`, and `unenriched` — need to exist for the commands above to
work as written; `scripts/migrate-notion.ts` and `scripts/migration-verify.ts`
are the files behind them. If `npm run migrate:verify` isn't wired up yet,
run `npx tsx --env-file-if-exists=.env.local scripts/migration-verify.ts`
directly.

## Cleaning up afterward

Once the migration has run and `npm run migrate:verify` shows a clean report:

- **`NOTION_TOKEN` can be deleted** from wherever it's set (`.env.local`, the
  deployment environment), and the Notion internal integration that issued it
  can be revoked at https://www.notion.so/my-integrations. Nothing in the
  running app needs it — only the one-time migration scripts do.

- **`src/lib/notion/` and `scripts/migrate-notion.ts` can be deleted.** They
  exist only to support the migration. `src/lib/notion/boundary.test.ts`
  exists precisely to guarantee it's safe to delete them: it scans `src/app/`
  and `src/lib/` (excluding `src/lib/notion/` itself) and fails if anything
  outside that directory imports from it, so as long as that test is green,
  nothing else in the app depends on Notion code. If you delete the
  directory, delete the boundary test with it — there's nothing left for it
  to guard.

## Do not delete the Notion database

**Do not delete the Notion "Library" database.** It stays as the backup of
record until this app has been lived with for a while — weeks, not days.

The temptation to tidy up early is exactly how a bad migration becomes an
unrecoverable one. A clean `migrate:verify` report is evidence the migration
went well, not proof there's nothing left to discover: a recipe that looks
fine on the page but has a subtly wrong ingredient parse, a facet that got
misclassified, or a recipe nobody has opened yet since the migration are all
things that surface only with real use. As long as the Notion database still
exists, any of those is a data-entry fix away from being corrected against
the original. Delete it, and the same problem becomes unrecoverable.

Revoking the integration's token (above) is enough to stop this app from
touching Notion. Deleting the database itself is a separate, much later
decision — and not one to make just because the migration script printed a
clean report.
