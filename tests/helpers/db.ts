import { drizzle } from 'drizzle-orm/libsql'
import { createClient } from '@libsql/client'
import { migrate } from 'drizzle-orm/libsql/migrator'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as schema from '@/lib/db/schema'

const tempDirs: string[] = []
let cleanupRegistered = false

/**
 * A fresh, migrated database per call.
 *
 * Backed by a throwaway file rather than `:memory:`, and that is not an
 * arbitrary choice. `@libsql/client`'s local driver implements
 * `transaction()` by handing its open connection to the transaction and
 * dropping its own reference, so the *next* statement outside the transaction
 * lazily opens a second connection. Against a file both connections see the
 * same database; against `:memory:` the second connection is a brand-new empty
 * database, and every table vanishes the moment any code under test opens a
 * transaction. A temp file is the only way to test transactional code here.
 */
export async function createTestDb() {
  if (!cleanupRegistered) {
    cleanupRegistered = true
    process.on('exit', () => {
      for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
    })
  }

  const dir = mkdtempSync(join(tmpdir(), 'recipe-manager-test-'))
  tempDirs.push(dir)

  const client = createClient({ url: `file:${join(dir, 'test.db')}` })
  const db = drizzle(client, { schema })
  await migrate(db, { migrationsFolder: './drizzle/migrations' })
  return db
}

export type TestDb = Awaited<ReturnType<typeof createTestDb>>
