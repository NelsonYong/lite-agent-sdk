/**
 * Lightweight memory monitor — zero extra dependencies.
 * Auto-starts an HTTP server (SSE + HTML dashboard) on import.
 *
 * Usage in main.ts:
 *   import './monitor'
 *
 * Optional event marking from anywhere:
 *   import { mark } from './monitor'
 *   mark('agent_start')
 */

import { createServer, ServerResponse } from "node:http";

const PORT = Number(process.env.MONITOR_PORT ?? 8899);
const MAX_HISTORY = 600; // 10 minutes of 1s ticks

export type EventType =
  | "startup"
  | "agent_start"
  | "agent_end"
  | "tool_call"
  | "compact"
  | "shutdown"
  | "tick";

interface MemSnapshot {
  rss: number;
  heapTotal: number;
  heapUsed: number;
  external: number;
}

interface MetricEvent {
  ts: number;
  type: EventType;
  label?: string;
  mem: MemSnapshot;
  /** peak heapUsed observed between two ticks (via 200ms lightweight loop) */
  peakHeap: number;
}

const clients = new Set<ServerResponse>();
const history: MetricEvent[] = [];

// ─── Peak tracking — 200ms lightweight loop ───────────────────────────────────
// process.memoryUsage.rss() is a single syscall; far cheaper than the full call.
// We use it only for tracking whether rss rose; heapUsed peak is updated on
// every full sample or lifecycle event.
let _peakHeap = 0;

setInterval(() => {
  // Lightweight: just keep RSS moving average for peak detection.
  // We can't get heapUsed cheaply, so we approximate via the last known value.
  // The full sample on each tick will overwrite _peakHeap if it's higher.
  const rss = process.memoryUsage.rss();
  // RSS spike → likely heap spike too; flag for next full sample
  if (rss > _peakHeap * 1.05) _peakHeap = rss; // rough proxy, corrected on tick
}, 200).unref();

function fullSample(): MemSnapshot {
  const m = process.memoryUsage();
  if (m.heapUsed > _peakHeap) _peakHeap = m.heapUsed;
  return { rss: m.rss, heapTotal: m.heapTotal, heapUsed: m.heapUsed, external: m.external };
}

function push(event: MetricEvent) {
  history.push(event);
  if (history.length > MAX_HISTORY) history.shift();

  // Skip serialization entirely when nobody is watching — zero overhead
  if (clients.size === 0) return;

  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of clients) {
    try {
      res.write(data);
    } catch {
      clients.delete(res);
    }
  }
}

function emit(type: EventType, label?: string) {
  const peakHeap = _peakHeap;
  const mem = fullSample();
  _peakHeap = mem.heapUsed; // reset peak after capturing
  push({ ts: Date.now(), type, label, mem, peakHeap });
}

/** Call this from anywhere to mark a lifecycle event on the dashboard */
export function mark(type: EventType, label?: string) {
  emit(type, label);
}

// ─── HTML Dashboard ──────────────────────────────────────────────────────────

const HTML = /* html */ `<!DOCTYPE html>
<html lang="zh">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>lite-agent 内存监控</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: #0d1117; color: #e6edf3;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      padding: 20px; min-height: 100vh;
    }
    header { display: flex; align-items: baseline; gap: 12px; margin-bottom: 16px; }
    h1 { color: #58a6ff; font-size: 1.1rem; }
    #status { font-size: 0.75rem; padding: 2px 8px; border-radius: 10px; background: #3fb95022; color: #3fb950; border: 1px solid #3fb95055; }
    #status.disconnected { background: #f8514922; color: #f85149; border-color: #f8514955; }

    .stats {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
      gap: 10px; margin-bottom: 16px;
    }
    .stat {
      background: #161b22; border: 1px solid #30363d; border-radius: 8px;
      padding: 10px 14px;
    }
    .stat-label { color: #8b949e; font-size: 0.75rem; margin-bottom: 2px; }
    .stat-label .abbr { color: #484f58; font-size: 0.7rem; }
    .stat-value { font-size: 1.3rem; font-weight: 700; }
    .stat-value.heap   { color: #58a6ff; }
    .stat-value.htotal { color: #3fb950; }
    .stat-value.rss    { color: #d29922; }
    .stat-value.ext    { color: #a371f7; }
    .stat-value.peak   { color: #f85149; }
    .stat-desc { font-size: 0.65rem; color: #484f58; margin-top: 3px; line-height: 1.4; }

    .chart-wrap {
      background: #161b22; border: 1px solid #30363d; border-radius: 8px;
      padding: 16px; margin-bottom: 16px;
    }

    .events-wrap {
      background: #161b22; border: 1px solid #30363d; border-radius: 8px;
      padding: 12px;
    }
    .events-title { color: #8b949e; font-size: 0.75rem; text-transform: uppercase; letter-spacing: .05em; margin-bottom: 8px; }
    .events { max-height: 180px; overflow-y: auto; }
    .event-row {
      font-size: 0.78rem; padding: 3px 0;
      border-bottom: 1px solid #21262d; color: #8b949e;
      display: flex; gap: 8px;
    }
    .event-row:last-child { border-bottom: none; }
    .event-row .time { color: #484f58; white-space: nowrap; }
    .event-row.startup  .badge { background: #3fb95033; color: #3fb950; }
    .event-row.agent_start .badge { background: #58a6ff33; color: #58a6ff; }
    .event-row.agent_end   .badge { background: #a371f733; color: #a371f7; }
    .event-row.tool_call   .badge { background: #d2992233; color: #d29922; }
    .event-row.compact     .badge { background: #f8514933; color: #f85149; }
    .event-row.shutdown    .badge { background: #f8514933; color: #f85149; }
    .badge {
      font-size: 0.7rem; border-radius: 4px; padding: 0 6px;
      white-space: nowrap; align-self: center;
    }
    .event-label { color: #e6edf3; }
  </style>
</head>
<body>
  <header>
    <h1>lite-agent 内存监控</h1>
    <span id="status">连接中...</span>
  </header>

  <div class="stats">
    <div class="stat">
      <div class="stat-label">堆内存使用 <span class="abbr">(Heap Used)</span></div>
      <div class="stat-value heap" id="s-heap">--</div>
      <div class="stat-desc">V8 堆中已分配给 JS 对象的内存，GC 后会下降</div>
    </div>
    <div class="stat">
      <div class="stat-label">堆内存峰值 <span class="abbr">(Peak Heap)</span></div>
      <div class="stat-value peak" id="s-peak">--</div>
      <div class="stat-desc">上一秒内 heapUsed 的最高水位，反映瞬时压力</div>
    </div>
    <div class="stat">
      <div class="stat-label">堆内存总量 <span class="abbr">(Heap Total)</span></div>
      <div class="stat-value htotal" id="s-htotal">--</div>
      <div class="stat-desc">V8 向操作系统预申请的堆空间，含空闲缓冲区</div>
    </div>
    <div class="stat">
      <div class="stat-label">常驻内存 <span class="abbr">(RSS)</span></div>
      <div class="stat-value rss" id="s-rss">--</div>
      <div class="stat-desc">进程实际占用的物理内存总量，含 V8 引擎自身开销</div>
    </div>
    <div class="stat">
      <div class="stat-label">外部内存 <span class="abbr">(External)</span></div>
      <div class="stat-value ext" id="s-ext">--</div>
      <div class="stat-desc">V8 堆外分配的内存，主要来自 Buffer 和 TypedArray</div>
    </div>
  </div>

  <div class="chart-wrap">
    <canvas id="chart" height="70"></canvas>
  </div>

  <div class="events-wrap">
    <div class="events-title">生命周期事件</div>
    <div class="events" id="events"></div>
  </div>

  <script>
    const MAX_POINTS = 120;
    const labels = [];
    const heapUsed = [], heapTotal = [], rss = [], external = [], peakHeap = [];

    const ctx = document.getElementById('chart').getContext('2d');
    const chart = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: '堆内存使用 (Heap Used)', data: heapUsed,
            borderColor: '#58a6ff', backgroundColor: 'rgba(88,166,255,0.08)',
            tension: 0.3, pointRadius: 0, fill: true, borderWidth: 2,
          },
          {
            label: '堆内存总量 (Heap Total)', data: heapTotal,
            borderColor: '#3fb950', backgroundColor: 'transparent',
            tension: 0.3, pointRadius: 0, borderDash: [5, 3], borderWidth: 1.5,
          },
          {
            label: '常驻内存 (RSS)', data: rss,
            borderColor: '#d29922', backgroundColor: 'transparent',
            tension: 0.3, pointRadius: 0, borderWidth: 1.5,
          },
          {
            label: '外部内存 (External)', data: external,
            borderColor: '#a371f7', backgroundColor: 'transparent',
            tension: 0.3, pointRadius: 0, borderWidth: 1.5,
          },
          {
            label: '堆峰值 (Peak Heap)', data: peakHeap,
            borderColor: '#f85149', backgroundColor: 'transparent',
            tension: 0, pointRadius: 0, borderDash: [2, 3], borderWidth: 1.5,
          },
        ],
      },
      options: {
        animation: false,
        interaction: { mode: 'index', intersect: false },
        scales: {
          x: {
            ticks: { color: '#484f58', maxTicksLimit: 8, maxRotation: 0 },
            grid: { color: '#21262d' },
          },
          y: {
            ticks: {
              color: '#8b949e',
              callback: v => v.toFixed(0) + ' MB',
            },
            grid: { color: '#21262d' },
          },
        },
        plugins: {
          legend: {
            labels: { color: '#e6edf3', boxWidth: 12, font: { family: 'monospace', size: 11 } },
          },
          tooltip: {
            backgroundColor: '#1c2128',
            borderColor: '#30363d',
            borderWidth: 1,
            callbacks: {
              label: c => \` \${c.dataset.label}: \${c.parsed.y.toFixed(1)} MB\`,
            },
          },
        },
      },
    });

    const mb = v => (v / 1024 / 1024).toFixed(1);

    const EVENT_LABELS = {
      startup:     '启动',
      agent_start: 'Agent 开始',
      agent_end:   'Agent 结束',
      tool_call:   '工具调用',
      compact:     '压缩历史',
      shutdown:    '进程退出',
    };

    function addEvent(e) {
      const container = document.getElementById('events');
      const row = document.createElement('div');
      row.className = 'event-row ' + e.type;
      const t = new Date(e.ts).toLocaleTimeString();
      const label = EVENT_LABELS[e.type] || e.type;
      row.innerHTML =
        \`<span class="time">\${t}</span>\` +
        \`<span class="badge">\${label}</span>\` +
        (e.label ? \`<span class="event-label">\${e.label}</span>\` : '');
      container.prepend(row);
    }

    function onEvent(e) {
      const m = e.mem;
      const t = new Date(e.ts).toLocaleTimeString();

      labels.push(t);
      heapUsed.push(+mb(m.heapUsed));
      heapTotal.push(+mb(m.heapTotal));
      rss.push(+mb(m.rss));
      external.push(+mb(m.external));
      peakHeap.push(+mb(e.peakHeap ?? m.heapUsed));

      if (labels.length > MAX_POINTS) {
        labels.shift(); heapUsed.shift(); heapTotal.shift();
        rss.shift(); external.shift(); peakHeap.shift();
      }

      chart.update('none');

      document.getElementById('s-heap').textContent   = mb(m.heapUsed)  + ' MB';
      document.getElementById('s-peak').textContent   = mb(e.peakHeap ?? m.heapUsed) + ' MB';
      document.getElementById('s-htotal').textContent = mb(m.heapTotal) + ' MB';
      document.getElementById('s-rss').textContent    = mb(m.rss)       + ' MB';
      document.getElementById('s-ext').textContent    = mb(m.external)  + ' MB';

      if (e.type !== 'tick') addEvent(e);
    }

    const statusEl = document.getElementById('status');
    const es = new EventSource('/events');
    es.onmessage = e => onEvent(JSON.parse(e.data));
    es.onopen    = () => { statusEl.textContent = '已连接'; statusEl.className = ''; };
    es.onerror   = () => { statusEl.textContent = '已断开'; statusEl.className = 'disconnected'; };
  </script>
</body>
</html>`;

// ─── HTTP Server ──────────────────────────────────────────────────────────────

const server = createServer((req, res) => {
  if (req.url === "/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });

    // replay history so a late-joining browser sees the full picture
    for (const event of history) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }

    clients.add(res);
    req.on("close", () => clients.delete(res));
    return;
  }

  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(HTML);
});

server.listen(PORT, () => {
  console.log(
    `\x1b[35m[monitor] dashboard → http://localhost:${PORT}\x1b[0m`,
  );
});

// keep server alive but don't block natural process exit
server.unref();

// ─── Lifecycle hooks ──────────────────────────────────────────────────────────

emit("startup");

process.on("SIGTERM", () => emit("shutdown", "SIGTERM"));
process.on("SIGINT", () => {
  emit("shutdown", "SIGINT");
  // give SSE one tick to flush before exit
  setTimeout(() => process.exit(0), 50).unref();
});

// ─── Periodic tick ────────────────────────────────────────────────────────────
// Full memoryUsage() is called once per second regardless of client count
// (we need it for history replay when a browser connects late).
// Serialization + SSE write is skipped when clients.size === 0.

setInterval(() => emit("tick"), 1000).unref();
