import { describe, it, expect, beforeEach } from 'vitest'
import { createTestDb, type TestDb } from '../helpers/db'
import { recipes, images } from '@/lib/db/schema'
import { buildLibraryIndex } from '@/lib/db/queries/library'
import { getRecipeBySlug } from '@/lib/db/queries/recipe-detail'
import { pickCover } from '@/lib/images/cover'

/**
 * The cover rule lives in two places — `pickCover` for the recipe page and a
 * correlated subquery for the library grid — because the grid must not load
 * every image row of every recipe to pick one thumbnail. This table is what
 * keeps the two identical: every case runs through both, against a real
 * database, and they must agree with each other and with the expectation.
 */
type ImageSpec = {
  key: string
  role: 'source_hero' | 'user'
  isCover?: boolean
  /** False models a row ingested before the URL columns existed. */
  hasBlobUrl?: boolean
  /** False models a row left half-written — a full image with no thumbnail. */
  hasThumbUrl?: boolean
  createdAt?: Date
}

const SAME_SECOND = new Date('2026-01-01T00:00:00Z')

const CASES: { name: string; images: ImageSpec[]; expected: string | null }[] = [
  {
    name: 'a chosen cover beats the publisher photo',
    images: [{ key: 'hero', role: 'source_hero' }, { key: 'mine', role: 'user', isCover: true }],
    expected: 'mine',
  },
  {
    name: 'the publisher photo when nothing is chosen, even if it is not the oldest',
    images: [{ key: 'mine', role: 'user' }, { key: 'hero', role: 'source_hero' }],
    expected: 'hero',
  },
  {
    name: 'the oldest photo when there is neither a choice nor a publisher photo',
    images: [
      { key: 'late', role: 'user', createdAt: new Date('2026-02-01T00:00:00Z') },
      { key: 'early', role: 'user', createdAt: new Date('2026-01-01T00:00:00Z') },
    ],
    expected: 'early',
  },
  {
    name: 'insertion order breaks a tie on created_at',
    images: [{ key: 'first', role: 'user' }, { key: 'second', role: 'user' }],
    expected: 'first',
  },
  {
    name: 'a chosen cover with no stored URL falls through',
    images: [
      { key: 'legacy', role: 'user', isCover: true, hasBlobUrl: false, hasThumbUrl: false },
      { key: 'hero', role: 'source_hero' },
    ],
    expected: 'hero',
  },
  {
    name: 'nothing when the only image has no stored URL',
    images: [{ key: 'legacy', role: 'source_hero', hasBlobUrl: false, hasThumbUrl: false }],
    expected: null,
  },
  { name: 'nothing when there are no images', images: [], expected: null },
  {
    // Both URLs are required, not just one — a row with a full image but no
    // thumbnail (or vice versa) is half-written and cannot be drawn by
    // either the recipe page or a photo grid, so it must fall through the
    // same as a row with neither.
    name: 'a chosen cover with only a full image (no thumbnail) falls through',
    images: [
      { key: 'legacy', role: 'user', isCover: true, hasThumbUrl: false },
      { key: 'hero', role: 'source_hero' },
    ],
    expected: 'hero',
  },
  {
    name: 'a chosen cover with only a thumbnail (no full image) falls through',
    images: [
      { key: 'legacy', role: 'user', isCover: true, hasBlobUrl: false },
      { key: 'hero', role: 'source_hero' },
    ],
    expected: 'hero',
  },
]

const full = (key: string) => `https://blob.example.com/${key}.webp`
const thumb = (key: string) => `https://blob.example.com/${key}-thumb.webp`

let db: TestDb
beforeEach(async () => { db = await createTestDb() })

describe('the cover rule', () => {
  for (const c of CASES) {
    it(c.name, async () => {
      const [recipe] = await db.insert(recipes).values({
        title: 'Egg Korma', slug: 'egg-korma', extractionMethod: 'manual',
      }).returning()

      // Inserted one at a time, in array order, so `rowid` follows the array.
      for (const spec of c.images) {
        const hasBlobUrl = spec.hasBlobUrl ?? true
        const hasThumbUrl = spec.hasThumbUrl ?? true
        await db.insert(images).values({
          recipeId: recipe.id,
          role: spec.role,
          isCover: spec.isCover ?? false,
          blobKey: `recipes/${recipe.id}/${spec.key}.webp`,
          thumbKey: `recipes/${recipe.id}/${spec.key}-thumb.webp`,
          blobUrl: hasBlobUrl ? full(spec.key) : null,
          thumbUrl: hasThumbUrl ? thumb(spec.key) : null,
          width: 1600,
          height: 1067,
          createdAt: spec.createdAt ?? SAME_SECOND,
        })
      }

      const detail = await getRecipeBySlug(db, 'egg-korma')
      const [entry] = await buildLibraryIndex(db)

      expect(pickCover(detail!.images)?.blobUrl ?? null).toBe(c.expected ? full(c.expected) : null)
      expect(entry.thumbUrl).toBe(c.expected ? thumb(c.expected) : null)
    })
  }

  // The subquery correlates on `recipes.id` via a workaround for a Drizzle
  // de-qualification quirk (see the comment in `buildLibraryIndex`) — a
  // single-recipe test cannot catch a broken correlation, because a bug that
  // makes every recipe match "whichever row SQL resolves first" would still
  // look correct with only one recipe in the table. Two recipes, each with
  // their own photos, is what actually exercises the correlation.
  it("gives each recipe its own library thumbnail, never another recipe's", async () => {
    const [a] = await db.insert(recipes).values({
      title: 'Egg Korma', slug: 'egg-korma', extractionMethod: 'manual',
    }).returning()
    const [b] = await db.insert(recipes).values({
      title: 'Beef Stew', slug: 'beef-stew', extractionMethod: 'manual',
    }).returning()

    // Recipe A: a publisher hero plus a chosen cover — the chosen photo
    // should win for A specifically.
    await db.insert(images).values({
      recipeId: a.id, role: 'source_hero', isCover: false,
      blobKey: `recipes/${a.id}/hero.webp`, thumbKey: `recipes/${a.id}/hero-thumb.webp`,
      blobUrl: full('a-hero'), thumbUrl: thumb('a-hero'), width: 1600, height: 1067,
    })
    await db.insert(images).values({
      recipeId: a.id, role: 'user', isCover: true,
      blobKey: `recipes/${a.id}/mine.webp`, thumbKey: `recipes/${a.id}/mine-thumb.webp`,
      blobUrl: full('a-mine'), thumbUrl: thumb('a-mine'), width: 1600, height: 1067,
    })

    // Recipe B: only a publisher hero.
    await db.insert(images).values({
      recipeId: b.id, role: 'source_hero', isCover: false,
      blobKey: `recipes/${b.id}/hero.webp`, thumbKey: `recipes/${b.id}/hero-thumb.webp`,
      blobUrl: full('b-hero'), thumbUrl: thumb('b-hero'), width: 1600, height: 1067,
    })

    const entries = await buildLibraryIndex(db)
    const entryA = entries.find((e) => e.slug === 'egg-korma')
    const entryB = entries.find((e) => e.slug === 'beef-stew')

    expect(entryA?.thumbUrl).toBe(thumb('a-mine'))
    expect(entryB?.thumbUrl).toBe(thumb('b-hero'))
  })
})
