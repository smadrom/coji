import { defineConfig } from 'drizzle-kit';

/**
 * Drizzle Kit manages the coji-owned schema. Drizzle table modules are added
 * to the `schema` glob in P0.3; the connection string comes from env.
 *
 *   bun run db:generate   # author migrations from the schema
 *   bun run db:migrate    # apply them
 *   bun run db:push       # fast push (dev only)
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: ['./src/db/schema.ts', './src/db/auth-schema.ts'],
  out: './drizzle',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://coji:coji@127.0.0.1:5432/coji',
  },
});
