import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";

export type Db = pg.Pool;
export type Client = pg.PoolClient;

export function createPool(connectionString: string): Db {
  return new pg.Pool({ connectionString, max: 10 });
}

/** Runs a function in a transaction: committed if it returns, rolled back if it throws. */
export async function transaction<T>(db: Db, work: (client: Client) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("begin");
    const result = await work(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

const MIGRATIONS = path.join(import.meta.dirname, "..", "migrations");
const LOCK_ID = 4_210_517;

/** Applies pending SQL migrations in file name order, one transaction each. */
export async function migrate(db: Db): Promise<string[]> {
  const client = await db.connect();
  try {
    await client.query("select pg_advisory_lock($1)", [LOCK_ID]);
    await client.query("create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())");
    const applied = new Set((await client.query<{ name: string }>("select name from schema_migrations")).rows.map((r) => r.name));
    const done: string[] = [];
    for (const file of (await readdir(MIGRATIONS)).filter((f) => f.endsWith(".sql")).sort()) {
      if (applied.has(file)) continue;
      await client.query("begin");
      try {
        await client.query(await readFile(path.join(MIGRATIONS, file), "utf8"));
        await client.query("insert into schema_migrations (name) values ($1)", [file]);
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw error;
      }
      done.push(file);
    }
    return done;
  } finally {
    await client.query("select pg_advisory_unlock($1)", [LOCK_ID]);
    client.release();
  }
}
