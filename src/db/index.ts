import { neon } from "@neondatabase/serverless";
import { drizzle, type NeonHttpDatabase } from "drizzle-orm/neon-http";
import { requireEnv } from "../lib/env";
import * as schema from "./schema";

let dbInstance: NeonHttpDatabase<typeof schema> | null = null;

/**
 * Lazily initializes the Neon + Drizzle client so importing this module
 * during `next build` does not fail if DATABASE_URL is only set at runtime.
 */
export function getDb(): NeonHttpDatabase<typeof schema> {
  if (!dbInstance) {
    const sql = neon(requireEnv("DATABASE_URL"));
    dbInstance = drizzle(sql, { schema });
  }
  return dbInstance;
}

export * from "./schema";
