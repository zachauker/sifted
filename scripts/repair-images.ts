#!/usr/bin/env tsx
/**
 * Give recipes back their pictures.
 *
 * Two different things go wrong, and only one of them is a missing image:
 *
 *   --repair-urls   An image row has `blob_key` and `thumb_key` but a null
 *                   `blob_url`. The picture is in blob storage and was never
 *                   lost; the database just cannot say where it is, so nothing
 *                   renders it. The schema comment on that column says there is
 *                   "no way to recover one after the fact" — that is wrong.
 *                   `head(pathname)` asks the provider for its own URL, which
 *                   is exactly what should have been stored. Nothing is
 *                   downloaded and nothing is re-encoded.
 *
 *   --missing       A recipe with no image row at all. Here the picture really
 *                   does have to be found again, and the source of truth is the
 *                   page. Where the original HTML was archived it is read from
 *                   blob storage rather than re-fetched, which matters because
 *                   several of these publishers now refuse us: the archive is a
 *                   copy of the page from when it still worked.
 *
 *   --recipe=<id|slug|url> --from=<url>
 *                   Ingest a specific image for a specific recipe. The escape
 *                   hatch for the ones nothing automatic can find — a recipe
 *                   recovered from a Notion body whose page is gone, where you
 *                   have a picture and just want it attached.
 *
 * Flags: --dry-run, --limit=N
 */
import { gunzipSync } from 'node:zlib'

import { and, eq, isNull, or } from 'drizzle-orm'

const log = (m: string) => console.log(`[images] ${m}`)

type Options = {
  repairUrls: boolean
  missing: boolean
  recipeId: string | null
  from: string | null
  dryRun: boolean
  limit: number | null
}

export function parseArgs(argv: string[]): Options {
  const o: Options = { repairUrls: false, missing: false, recipeId: null, from: null, dryRun: false, limit: null }
  for (const a of argv) {
    if (a === '--repair-urls') o.repairUrls = true
    else if (a === '--missing') o.missing = true
    else if (a === '--dry-run') o.dryRun = true
    else if (a.startsWith('--recipe=')) o.recipeId = a.slice('--recipe='.length)
    else if (a.startsWith('--from=')) o.from = a.slice('--from='.length)
    else if (a.startsWith('--limit=')) {
      const n = Number(a.slice('--limit='.length))
      if (!Number.isInteger(n) || n <= 0) throw new Error(`bad --limit: ${a}`)
      o.limit = n
    } else throw new Error(`unknown argument: ${a}`)
  }
  if ((o.recipeId === null) !== (o.from === null)) {
    throw new Error('--recipe and --from go together')
  }
  if (!o.repairUrls && !o.missing && !o.recipeId) {
    throw new Error('nothing to do: pass --repair-urls, --missing, or --recipe=<id> --from=<url>')
  }
  return o
}

/** The archived original page, or null when there is no archive or it is gone. */
async function readArchive(key: string, token: string): Promise<string | null> {
  try {
    const { head } = await import('@vercel/blob')
    const meta = await head(key, { token })
    const response = await fetch(meta.url)
    if (!response.ok) return null
    const gz = Buffer.from(await response.arrayBuffer())
    return gunzipSync(gz).toString('utf8')
  } catch {
    return null
  }
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2))
  const token = process.env.BLOB_READ_WRITE_TOKEN
  if (!token) throw new Error('BLOB_READ_WRITE_TOKEN is not set')

  const { db } = await import('../src/lib/db')
  const { recipes, images } = await import('../src/lib/db/schema')
  const { ingestHeroImage } = await import('../src/lib/images/index')
  const { createVercelBlobStore } = await import('../src/lib/storage/vercel-blob')
  const store = createVercelBlobStore()

  async function attach(recipeId: string, imageUrl: string, label: string): Promise<boolean> {
    const image = await ingestHeroImage({ url: imageUrl, recipeId, store })
    if (!image) {
      log(`  could not fetch or decode the image  ${label}`)
      return false
    }
    // Replace rather than append, exactly as `run-import` does: a repair run
    // must not leave one `source_hero` per attempt. A user-uploaded picture is
    // theirs and is never touched.
    await db.delete(images).where(and(eq(images.recipeId, recipeId), eq(images.role, 'source_hero')))
    await db.insert(images).values({
      recipeId,
      role: 'source_hero',
      blobKey: image.blobKey,
      thumbKey: image.thumbKey,
      blobUrl: image.blobUrl,
      thumbUrl: image.thumbUrl,
      width: image.width,
      height: image.height,
    })
    log(`  attached ${image.width}x${image.height}  ${label}`)
    return true
  }

  if (opts.repairUrls) {
    const { head } = await import('@vercel/blob')
    const broken = await db.select().from(images)
      .where(or(isNull(images.blobUrl), isNull(images.thumbUrl)))
    log(`--repair-urls: ${broken.length} image rows have a key but no URL`)

    if (opts.dryRun) log('--dry-run: nothing written.')
    else {
      let fixed = 0
      let gone = 0
      for (const row of broken) {
        try {
          const [full, thumb] = await Promise.all([
            head(row.blobKey, { token }),
            head(row.thumbKey, { token }),
          ])
          await db.update(images)
            .set({ blobUrl: full.url, thumbUrl: thumb.url })
            .where(eq(images.id, row.id))
          fixed++
        } catch {
          // The row points at a blob that is no longer in the store, so there
          // is nothing to link to. Left alone rather than deleted: --missing
          // is what re-fetches a picture, and silently dropping the row here
          // would hide that this recipe needs it.
          gone++
        }
      }
      log(`${fixed} URLs recovered, ${gone} whose blob is no longer in the store`)
    }
  }

  if (opts.recipeId && opts.from) {
    // id, slug or source URL — whichever the user has to hand. Requiring the
    // cuid would mean going and looking it up in the database first, for a
    // command whose whole purpose is being the quick manual fallback.
    const [row] =
      (await db.select().from(recipes).where(eq(recipes.id, opts.recipeId))).concat(
        await db.select().from(recipes).where(eq(recipes.slug, opts.recipeId)),
        await db.select().from(recipes).where(eq(recipes.sourceUrl, opts.recipeId)),
      )
    if (!row) throw new Error(`no recipe matching id, slug or source URL: ${opts.recipeId}`)
    log(`--recipe: ${row.title}`)
    if (opts.dryRun) log('--dry-run: nothing written.')
    else await attach(row.id, opts.from, row.title)
  }

  if (opts.missing) {
    const { findOgImage } = await import('../src/lib/extract/og-image')
    const { fetchPage } = await import('../src/lib/fetch/index')

    const all = await db.select({
      id: recipes.id, title: recipes.title, slug: recipes.slug,
      url: recipes.sourceUrl, archive: recipes.archivedHtmlKey,
    }).from(recipes)
    const have = new Set((await db.select({ id: images.recipeId }).from(images)).map((i) => i.id))
    let targets = all.filter((r) => !have.has(r.id))
    if (opts.limit) targets = targets.slice(0, opts.limit)

    log(`--missing: ${targets.length} recipes with no image`)
    if (opts.dryRun) {
      for (const r of targets) {
        log(`    ${r.archive ? 'archived' : r.url ? 'would refetch' : 'NO SOURCE'}  ${r.title}`)
      }
      log('--dry-run: nothing written.')
      return
    }

    let fixed = 0
    const stuck: { title: string; slug: string }[] = []
    for (const r of targets) {
      log(`${r.title}`)
      if (!r.url) {
        log('  no source URL — use --recipe / --from to attach one by hand')
        stuck.push({ title: r.title, slug: r.slug })
        continue
      }

      // The archive first, deliberately: it is a copy of the page from when it
      // still let us in, and several of these publishers no longer do.
      let html: string | null = r.archive ? await readArchive(r.archive, token) : null
      if (html) log('  read the archived page')
      else {
        try {
          const page = await fetchPage(r.url)
          html = page.html
          log('  re-fetched the page')
        } catch (error) {
          log(`  could not reach the page: ${error instanceof Error ? error.message.slice(0, 90) : String(error)}`)
        }
      }

      if (!html) { stuck.push({ title: r.title, slug: r.slug }); continue }

      const imageUrl = findOgImage(html, r.url)
      if (!imageUrl) {
        log('  the page advertises no image')
        stuck.push({ title: r.title, slug: r.slug })
        continue
      }

      if (await attach(r.id, imageUrl, r.title)) fixed++
      else stuck.push({ title: r.title, slug: r.slug })
    }

    console.log('')
    log(`${fixed}/${targets.length} given a picture`)
    if (stuck.length) {
      log(`${stuck.length} still without one:`)
      for (const t of stuck) log(`    ${t.title}`)
      log('For these, find a picture and attach it directly:')
      for (const t of stuck) log(`  npm run images -- --recipe=${t.slug} --from=<image url>`)
    }
  }
}

const invokedDirectly = /repair-images\.(ts|js)$/.test(process.argv[1] ?? '')
if (invokedDirectly) {
  main().catch((error) => {
    console.error('\n[images] unexpected error:')
    console.error(error)
    process.exit(1)
  })
}
