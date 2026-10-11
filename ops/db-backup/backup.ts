// opt2 Portal DB backup + restore test. Runs as a Railway cron job (one run, then exit).
// 1. writes a canary row (schema tb_ops), 2. pg_dump -Fc into BACKUP_DIR,
// 3. restores the dump into a scratch database on the same server and verifies it
//    (same table set, canary row present, row counts reported), 4. drops the scratch database,
// 5. prunes old dumps, 6. appends a result line to BACKUP_DIR/RESTORE-LOG.jsonl,
// 7. pings the monitoring heartbeat on success only (a missing ping raises the alert).
// Env: DATABASE_URL (Railway reference to Postgres), BACKUP_DIR (volume mount), KEEP (default 14),
//      HEARTBEAT_URL (optional). Never logs the connection string or row contents.
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

const SCRATCH_DB = "tb_restore_test";

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

// Connection details go to the tools through PG* env vars, never argv, so an error message
// (which includes argv) can never contain the password.
type Conn = NodeJS.ProcessEnv;

function connFrom(url: string, db?: string): Conn {
  const u = new URL(url);
  return {
    ...process.env,
    PGHOST: u.hostname,
    PGPORT: u.port || "5432",
    PGUSER: decodeURIComponent(u.username),
    PGPASSWORD: decodeURIComponent(u.password),
    PGDATABASE: db ?? decodeURIComponent(u.pathname.slice(1)),
    PGSSLMODE: u.searchParams.get("sslmode") ?? "prefer",
    DATABASE_URL: "",
  };
}

function run(cmd: string, args: string[], conn: Conn): string {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", env: conn, stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (e) {
    const err = e as { status?: number; stderr?: string };
    throw new Error(`${cmd} exited ${err.status}: ${(err.stderr ?? "").split("\n").slice(0, 5).join(" | ")}`);
  }
}

function psql(conn: Conn, sql: string): string {
  return run("psql", ["--no-psqlrc", "-v", "ON_ERROR_STOP=1", "-At", "-c", sql], conn);
}

function tables(url: Conn): Map<string, number> {
  const list = psql(
    url,
    "select table_schema || '.' || table_name from information_schema.tables where table_type = 'BASE TABLE' and table_schema not in ('pg_catalog','information_schema') order by 1",
  )
    .split("\n")
    .filter(Boolean);
  const out = new Map<string, number>();
  for (const t of list) {
    const [schema, name] = t.split(".");
    out.set(t, Number(psql(url, `select count(*) from "${schema.replaceAll('"', '""')}"."${name.replaceAll('"', '""')}"`)));
  }
  return out;
}

async function main(): Promise<void> {
  const started = Date.now();
  const rawUrl = env("DATABASE_URL");
  const url = connFrom(rawUrl);
  const dir = env("BACKUP_DIR", "/backups");
  const keep = Number(env("KEEP", "14"));
  mkdirSync(dir, { recursive: true });

  const canary = psql(
    url,
    "create schema if not exists tb_ops; create table if not exists tb_ops.restore_canary (id bigserial primary key, at timestamptz not null default now()); insert into tb_ops.restore_canary default values returning id",
  )
    .split("\n")
    .pop();
  const stamp = new Date().toISOString().replaceAll(":", "").replace(/\..+/, "Z");
  const file = join(dir, `portal-${stamp}.dump`);
  run("pg_dump", ["-Fc", "--no-owner", "-f", file], url);
  const size = statSync(file).size;

  const adminUrl = connFrom(rawUrl, "postgres");
  psql(adminUrl, `drop database if exists ${SCRATCH_DB}`);
  psql(adminUrl, `create database ${SCRATCH_DB}`);
  const scratch = connFrom(rawUrl, SCRATCH_DB);
  let ok = false;
  let detail = "";
  try {
    run("pg_restore", ["--no-owner", "--exit-on-error", "-d", SCRATCH_DB, file], scratch);
    const src = tables(url);
    const dst = tables(scratch);
    const missing = [...src.keys()].filter((t) => !dst.has(t));
    const canaryRestored = psql(scratch, `select count(*) from tb_ops.restore_canary where id = ${Number(canary)}`) === "1";
    ok = missing.length === 0 && canaryRestored;
    const rows = [...dst.values()].reduce((a, b) => a + b, 0);
    detail = `tables=${dst.size} rows=${rows} missing=${missing.join(",") || "-"} canary=${canaryRestored ? "ok" : "MISSING"}`;
  } finally {
    psql(adminUrl, `drop database if exists ${SCRATCH_DB}`);
  }

  const dumps = readdirSync(dir)
    .filter((f) => /^portal-.*\.dump$/.test(f))
    .sort();
  for (const old of dumps.slice(0, Math.max(0, dumps.length - keep))) rmSync(join(dir, old));

  const result = { at: new Date().toISOString(), dump: file.split("/").pop(), bytes: size, restore: ok ? "pass" : "FAIL", detail, ms: Date.now() - started };
  appendFileSync(join(dir, "RESTORE-LOG.jsonl"), `${JSON.stringify(result)}\n`);
  console.log(`db-backup: ${JSON.stringify(result)}`);
  if (!ok) process.exit(1);
  const hb = process.env.HEARTBEAT_URL;
  if (hb) {
    const res = await fetch(hb, { method: "POST" });
    console.log(`db-backup: heartbeat HTTP ${res.status}`);
  }
}

main().catch((e: unknown) => {
  console.error(`db-backup: FAIL: ${(e as Error).message}`);
  process.exit(1);
});
