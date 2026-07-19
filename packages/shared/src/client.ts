import type { App } from '@coji/api';
/**
 * Eden treaty client factory — typed against the API's exported `App` type.
 *
 * The web app calls `createCojiClient('http://localhost:3001')` and gets a
 * fully typed client with no codegen, courtesy of the preserved Eden `.use()`
 * type spine in apps/api.
 */
import { treaty } from '@elysiajs/eden';

export function createCojiClient(baseUrl: string) {
  return treaty<App>(baseUrl);
}

export type CojiClient = ReturnType<typeof createCojiClient>;
export type { App };
