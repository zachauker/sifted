/**
 * One row of the Notion "Library" database, reduced to the fields the migration
 * cares about. Everything downstream consumes this rather than Notion's API
 * shape, so the mapping and body conversion stay testable against committed
 * fixtures with no token and no network.
 */
export type NotionRecipeRow = {
  pageId: string
  /**
   * Null for the one blank page in the library, created by accident in 2026.
   * A titleless row is unrecoverable, but it must not crash the migration.
   */
  title: string | null
  /**
   * Raw, exactly as stored. 59 of 156 rows (38%) hold a markdown `[url](url)`
   * rather than a bare URL — see `unwrapLink` in map.ts.
   */
  link: string | null
  publisher: string | null
  author: string | null
  rating: number | null
  cookingStatus: 'Made It' | 'Want to Make' | null
  tags: string[]
  /** Notion's page creation time. Preserved so a 2019 recipe still reads as 2019. */
  createdTime: string
}

/**
 * A page's body content, used when the source URL is dead, blocked, or absent.
 *
 * For some recipes this is the only surviving copy — hand-typed family recipes
 * with no link at all, and clipped pages whose publisher has since shut down.
 */
export type NotionRecipeBody = {
  pageId: string
  /** Notion-flavoured markdown of the page content. */
  markdown: string
}
