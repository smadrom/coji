/**
 * Drizzle client over the coji Postgres (TS schema is the source of truth).
 * DATABASE_URL is supplied via env (see .env.example).
 */
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { env } from '../env.ts';
import * as authSchema from './auth-schema.ts';
import * as domainSchema from './schema.ts';

// Coji-owned domain tables + Better Auth tables (task #22) share one client.
const schema = { ...domainSchema, ...authSchema };

const client = postgres(env.databaseUrl, { prepare: false });

export const db = drizzle(client, { schema });
export { schema };
