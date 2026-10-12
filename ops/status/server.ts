// opt2 status page (C56 D7). No dependencies. Probes each target every INTERVAL_S seconds, keeps 24 h in memory,
// serves an HTML page at /, JSON at /api/status and liveness at /healthz. Holds no secrets; probes are anonymous.
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

interface Target {
  id: string;
  name: string;
  url: string;
  expect: { status: number; bodyIncludes?: string };
}
interface Check {
  at: number;
  ok: boolean;
  ms: number;
  detail: string;
}

const TARGETS = JSON.parse(readFileSync(join(import.meta.dirname, "targets.json"), "utf8")) as Target[];
const INTERVAL_S = Number(process.env.INTERVAL_S ?? 60);
const KEEP = Math.ceil((24 * 3600) / INTERVAL_S);
const history = new Map<string, Check[]>(TARGETS.map((t) => [t.id, []]));

export async function probe(t: Target, fetcher: typeof fetch = fetch): Promise<Check> {
  const start = Date.now();
  try {
    const res = await fetcher(t.url, { redirect: "follow", signal: AbortSignal.timeout(10_000), headers: { "user-agent": "opt2-status/1" } });
    const body = t.expect.bodyIncludes ? await res.text() : "";
    const ok = res.status === t.expect.status && (!t.expect.bodyIncludes || body.includes(t.expect.bodyIncludes));
    return {
      at: start,
      ok,
      ms: Date.now() - start,
      detail: ok ? `HTTP ${res.status}` : `HTTP ${res.status} (expected ${t.expect.status}${t.expect.bodyIncludes ? " + body" : ""})`,
    };
  } catch (e) {
    return { at: start, ok: false, ms: Date.now() - start, detail: (e as Error).name === "TimeoutError" ? "timeout" : "unreachable" };
  }
}

async function round(): Promise<void> {
  await Promise.all(
    TARGETS.map(async (t) => {
      const c = await probe(t);
      const h = history.get(t.id) as Check[];
      h.push(c);
      if (h.length > KEEP) h.splice(0, h.length - KEEP);
      if (!c.ok) console.log(JSON.stringify({ level: "warn", target: t.id, detail: c.detail, ms: c.ms }));
    }),
  );
}

export function summary() {
  return TARGETS.map((t) => {
    const h = history.get(t.id) ?? [];
    const last = h.at(-1) ?? null;
    const up = h.length ? h.filter((c) => c.ok).length / h.length : null;
    return {
      id: t.id,
      name: t.name,
      status: last ? (last.ok ? "up" : "down") : "unknown",
      last,
      uptime24h: up,
      recent: h.slice(-90).map((c) => (c.ok ? 1 : 0)),
    };
  });
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);

function page(): string {
  const rows = summary();
  const allUp = rows.every((r) => r.status === "up");
  const items = rows
    .map((r) => {
      const bars = r.recent.map((b) => `<i class="${b ? "u" : "d"}"></i>`).join("");
      const pct = r.uptime24h === null ? "–" : `${(r.uptime24h * 100).toFixed(2)}%`;
      return `<li><div class="row"><span class="dot ${r.status}"></span><b>${esc(r.name)}</b><span class="meta">${esc(r.last?.detail ?? "no data yet")} · ${r.last ? `${r.last.ms} ms` : ""} · 24 h ${pct}</span></div><div class="bars">${bars}</div></li>`;
    })
    .join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="60"><meta name="robots" content="noindex"><title>Teal Brick status</title>
<style>:root{--bg:#f6f4ef;--fg:#1d2b2a;--mut:#5d6b69;--up:#1f7a6d;--down:#8c2f39;--card:#fff;--line:#e3dfd6}
@media (prefers-color-scheme:dark){:root{--bg:#121716;--fg:#e8eceb;--mut:#9aa7a5;--card:#1b2221;--line:#2a3331}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}main{max-width:760px;margin:0 auto;padding:32px 16px}
h1{font-size:20px;margin:0 0 4px}.sum{padding:12px 16px;border-radius:2px;color:#fff;background:${allUp ? "var(--up)" : "var(--down)"};margin:16px 0}
ul{list-style:none;padding:0;margin:0}li{background:var(--card);border:1px solid var(--line);border-radius:2px;padding:12px 16px;margin:8px 0}
.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.meta{color:var(--mut);font-size:13px;margin-left:auto}
.dot{width:10px;height:10px;border-radius:2px;background:var(--mut)}.dot.up{background:var(--up)}.dot.down{background:var(--down)}
.bars{display:flex;gap:1px;margin-top:8px;height:18px}.bars i{flex:1;max-width:6px;background:var(--up);border-radius:1px}.bars i.d{background:var(--down)}
footer{color:var(--mut);font-size:12px;margin-top:16px}</style></head><body><main>
<h1>Teal Brick status</h1><div class="meta">opt2 environment · checks every ${INTERVAL_S} s · page refreshes every minute</div>
<div class="sum">${allUp ? "All systems operational" : "Some systems are down"}</div><ul>${items}</ul>
<footer>Updated ${new Date().toISOString()}. Incidents and alerts: GlitchTip (internal).</footer></main></body></html>`;
}

if (import.meta.main) {
  const port = Number(process.env.PORT ?? 8080);
  createServer((req, res) => {
    const url = req.url ?? "/";
    if (url === "/healthz") return void res.writeHead(200, { "content-type": "text/plain" }).end("ok");
    if (url === "/api/status")
      return void res
        .writeHead(200, { "content-type": "application/json", "cache-control": "no-store" })
        .end(JSON.stringify({ updatedAt: new Date().toISOString(), targets: summary() }));
    if (url === "/" || url.startsWith("/?"))
      return void res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(page());
    res.writeHead(404, { "content-type": "text/plain" }).end("not found");
  }).listen(port, "::", () => console.log(JSON.stringify({ level: "info", msg: "status listening", port })));
  void round();
  setInterval(() => void round(), INTERVAL_S * 1000);
}
