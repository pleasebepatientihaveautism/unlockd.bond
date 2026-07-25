import "dotenv/config";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL_REQUIRED");
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: true } : undefined
});

try {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  const files = (await readdir(path.resolve("migrations")))
    .filter((file) => file.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const applied = await client.query("SELECT 1 FROM schema_migrations WHERE version = $1", [
        file
      ]);
      if (applied.rowCount === 0) {
        await client.query(await readFile(path.resolve("migrations", file), "utf8"));
        await client.query("INSERT INTO schema_migrations(version) VALUES ($1)", [file]);
        process.stdout.write(`applied ${file}\n`);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
} finally {
  await pool.end();
}
