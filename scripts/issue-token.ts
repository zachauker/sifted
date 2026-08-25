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
