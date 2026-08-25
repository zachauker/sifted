import NextAuth from 'next-auth'
import Credentials from 'next-auth/providers/credentials'
import { compare } from 'bcryptjs'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { users } from '@/lib/db/schema'

// A real bcrypt hash (12 rounds) of a value nobody knows — generated once via
// `bcrypt.hash('this-value-is-never-used-and-known-to-nobody', 12)`. Comparing
// against it when the email does not exist keeps the response time identical
// to a wrong-password attempt, so the endpoint cannot be used to discover
// which accounts exist. Must be a syntactically valid bcrypt hash: a
// malformed string (wrong length/charset) makes bcryptjs bail out in <1ms
// instead of doing the ~250ms of work a real comparison takes, which defeats
// the whole point.
const DUMMY_HASH = '$2b$12$KWUbo6N6ZWYnmiZwZltXCOOO3dw42Q.QDsnIWhWxUEnJrd/o2dzDa'

export const { handlers, signIn, signOut, auth } = NextAuth({
  providers: [
    Credentials({
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) return null

        // The seed script stores email trimmed and lowercased; match that
        // normalization here so a capitalized email typed at the login form
        // doesn't fail to match an existing account.
        const email = (credentials.email as string).trim().toLowerCase()

        const user = await db.select().from(users)
          .where(eq(users.email, email)).get()

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
