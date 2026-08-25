#!/usr/bin/env tsx
/**
 * Lists every recipe stored without the model's contribution — no parsed
 * quantities, no units, no items, no tags — so an unenriched import can be
 * found and repaired instead of quietly under-counting the filter rail forever.
 *
 * Usage:
 *   npx tsx --env-file-if-exists=.env.local scripts/list-unenriched.ts
 *
 * (There is no npm script for it yet: `package.json` was owned by another
 * change while this was written. The intended entry, matching how `seed` and
 * `token` are declared there, is
 *   "unenriched": "tsx --env-file-if-exists=.env.local scripts/list-unenriched.ts"
 * run as `npm run unenriched`. The env file is where `TURSO_DATABASE_URL`
 * lives; without it this fails with an opaque LibsqlError.)
 *
 * Why this exists: `applyEnrichment` swallows its own errors on purpose, so a
 * rate-limited model produces a recipe that stores fine and a job that reports
 * `done`. There is no failed job to look at and no error text anywhere — the
 * `enrichment_applied` flag on the recipe row is the only record, and this is
 * what reads it. Expect to need it right after the 156-recipe migration, which
 * replays the whole pipeline in a burst and is the most likely thing in this
 * project to trip a sustained rate limit.
 *
 * Nothing here writes. Repair is a separate, deliberate act: retry the import.
 */
import { db } from '../src/lib/db'
import { listUnenrichedRecipes } from '../src/lib/db/queries/recipes'

async function main() {
  const rows = await listUnenrichedRecipes(db)

  if (rows.length === 0) {
    console.log('No unenriched recipes: every recipe in the library has model-parsed data.')
    return
  }

  console.log(`${rows.length} unenriched recipe${rows.length === 1 ? '' : 's'}:\n`)
  for (const row of rows) {
    console.log(`  ${row.id}  ${row.title}`)
    // A recipe with no source cannot be repaired by re-importing, so say so
    // rather than leaving a blank line that reads like a formatting bug.
    console.log(`      ${row.sourceUrl ?? '(no source URL — cannot be re-imported)'}`)
  }

  console.log(
    '\nThese recipes were stored without the enrichment pass: they have no parsed\n' +
      'quantities, units or items, and no tags, so they are invisible to faceted\n' +
      'filtering. Nothing is broken and nothing is lost — the source text of every\n' +
      'ingredient line is intact.\n' +
      '\n' +
      'To repair one, re-import its source URL. That re-runs the enrichment pass and\n' +
      'overwrites the recipe in place, keeping its id, slug, rating, status and notes.\n' +
      'Either share the URL again from the Shortcut, or press retry on the job in the\n' +
      'needs-attention tray if it still has one.',
  )
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
