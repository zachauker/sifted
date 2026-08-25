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
