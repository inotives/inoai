// The ring console: one self-contained page that reads /api/ui-data and draws it with three.js.
// `token` is the per-launch write token. It is hex, so it is safe in an attribute.
export function renderAppShell(token: string): string {
  if (!/^[0-9a-f]+$/.test(token)) throw new RangeError("UI token must be hex");
  return `<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="inoai-ui-token" content="${token}">
<title>inoai</title>
<link rel="stylesheet" href="https://cdn-uicons.flaticon.com/2.6.0/uicons-regular-rounded/css/uicons-regular-rounded.css">
<style>
  :root{color-scheme:dark;--ink:#060a13;--glass:rgba(14,21,36,.8);--line:rgba(140,170,210,.14);--text:#e7edf4;--muted:#8b9ab0;--mint:#59e3b1;--amber:#f2c66d;--coral:#f47d79;--sky:#7cc4ff;--violet:#a78bfa;--pink:#f0a6ca;--slate:#5a6d8c}
  *{box-sizing:border-box}
  html,body{margin:0;height:100%;background:var(--ink);color:var(--text);font:14px/1.5 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;overflow:hidden}
  #stage{position:fixed;inset:0}
  #stage canvas{display:block}
  .top{position:fixed;top:18px;left:20px;right:20px;display:flex;justify-content:space-between;align-items:center;gap:12px;z-index:5;pointer-events:none}
  .top>*{pointer-events:auto}
  .brand{display:flex;gap:10px;align-items:center;font-weight:600;letter-spacing:.04em}
  .mark{width:22px;height:22px;border-radius:50%;border:2px solid var(--mint);box-shadow:0 0 14px #59e3b166}
  .chip{display:flex;gap:8px;align-items:center;padding:6px 12px;border:1px solid var(--line);border-radius:999px;background:var(--glass);backdrop-filter:blur(10px);color:var(--muted);font-size:12px}
  .chip button{border:0;background:transparent;color:var(--muted);cursor:pointer;font:inherit;padding:0 0 0 6px;border-left:1px solid var(--line)}
  .chip button[aria-pressed=true]{color:var(--mint)}
  .dot{width:7px;height:7px;border-radius:50%;background:var(--slate)}
  .dot.running{background:var(--mint);box-shadow:0 0 10px var(--mint);animation:pulse 2.4s ease-in-out infinite}
  .dot.stopped{background:var(--coral);box-shadow:0 0 10px var(--coral)}
  @keyframes pulse{50%{opacity:.35}}
  .label{position:fixed;left:0;top:0;transform:translate(-50%,-50%);text-align:center;pointer-events:none;z-index:2;white-space:nowrap}
  .label b{display:block;font-weight:400;font-size:20px;letter-spacing:-.01em;font-variant-numeric:tabular-nums}
  .label span{display:block;font-size:9.5px;letter-spacing:.2em;text-transform:uppercase;color:var(--muted)}
  .label.core b{font-size:24px;font-weight:300}
  .label.name{font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:var(--muted)}
  .label.tip b{font-size:15px}
  .tooltip{position:fixed;z-index:6;pointer-events:none;padding:5px 10px;border-radius:8px;background:var(--glass);border:1px solid var(--line);backdrop-filter:blur(8px);font-size:12px;opacity:0;transform:translate(12px,12px);transition:opacity .15s}
  .tooltip.on{opacity:1}
  .hint{position:fixed;bottom:18px;left:50%;transform:translateX(-50%);font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:var(--muted);opacity:.7;transition:opacity .6s;z-index:2;pointer-events:none}
  .fallback{position:fixed;inset:0;display:none;place-items:center;color:var(--muted);text-align:center;padding:24px}
  .drawer{position:fixed;top:0;right:0;height:100%;width:min(440px,100%);background:var(--glass);backdrop-filter:blur(22px);border-left:1px solid var(--line);transform:translateX(102%);visibility:hidden;transition:transform .4s cubic-bezier(.2,.8,.2,1),visibility 0s linear .4s;z-index:10;display:flex;flex-direction:column}
  .drawer.open{transform:none;visibility:visible;transition:transform .4s cubic-bezier(.2,.8,.2,1)}
  .d-head{display:flex;align-items:center;gap:12px;padding:20px 20px 12px}
  .d-head h2{margin:0;font-size:17px;font-weight:500}
  .d-head small{display:block;color:var(--muted);font-size:11px;letter-spacing:.14em;text-transform:uppercase}
  .ring-ico{width:30px;height:30px;border-radius:50%;border:2px solid currentColor;box-shadow:0 0 12px currentColor;flex:none;display:grid;place-items:center;font-size:13px}
  .fi{display:flex;line-height:1}
  .close{width:36px;height:36px;border-radius:50%;border:1px solid var(--line);background:transparent;color:var(--text);cursor:pointer;font-size:18px;line-height:1}
  .close:hover{background:#ffffff10}
  .rail{display:flex;gap:6px;padding:0 20px 14px;border-bottom:1px solid var(--line);flex-wrap:wrap}
  .rail button{width:34px;height:34px;display:grid;place-items:center;padding:0;font-size:14px;border-radius:50%;border:2px solid currentColor;background:transparent;color:inherit;cursor:pointer;opacity:.4;transition:opacity .2s,transform .2s}
  .rail button[aria-current=true]{opacity:1;box-shadow:0 0 10px currentColor}
  .rail button:hover{opacity:.8;transform:scale(1.08)}
  .d-body{flex:1;overflow:auto;padding:16px 20px 32px}
  .stats{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:18px}
  .stat{padding:12px 14px;border:1px solid var(--line);border-radius:14px;background:#ffffff06}
  .stat b{display:block;font-size:22px;font-weight:300;font-variant-numeric:tabular-nums}
  .stat span{font-size:11px;color:var(--muted)}
  .seg{display:flex;gap:4px;margin-bottom:12px;flex-wrap:wrap}
  .seg button{border:1px solid var(--line);background:transparent;color:var(--muted);border-radius:999px;padding:4px 11px;font:inherit;font-size:12px;cursor:pointer}
  .seg button[aria-pressed=true]{color:var(--ink);background:var(--text);border-color:var(--text)}
  .list{display:flex;flex-direction:column;gap:6px}
  .item{display:block;width:100%;text-align:left;font:inherit;color:inherit;border:1px solid var(--line);background:#ffffff05;border-radius:14px;padding:10px 12px}
  button.item{cursor:pointer}
  button.item:hover{background:#ffffff0c}
  .item .meta{display:flex;align-items:center;gap:8px;font-size:11px;color:var(--muted);margin-bottom:3px}
  .item .meta .when{margin-left:auto;font-variant-numeric:tabular-nums}
  .item p{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
  .item[aria-expanded=true] p{-webkit-line-clamp:unset}
  .item .more{display:none;margin-top:8px;font-size:12px;color:var(--muted)}
  .item[aria-expanded=true] .more{display:block}
  .pill{display:inline-flex;align-items:center;gap:5px}
  .pill:before{content:"";width:7px;height:7px;border-radius:50%;background:currentColor}
  .hours{display:grid;grid-template-columns:repeat(6,1fr);gap:6px}
  .hour{border:1px solid var(--line);border-radius:12px;padding:8px 6px;text-align:center;font-size:11px}
  .hour i{display:block;width:14px;height:14px;margin:0 auto 4px;border-radius:50%;border:3px solid currentColor}
  .hour span{color:var(--muted)}
  .md h3{font-size:13px;margin:16px 0 4px}
  .md p,.md li{color:#c9d3e0;margin:4px 0;overflow-wrap:anywhere}
  .md ul{padding-left:18px;margin:4px 0}
  .kv{display:grid;grid-template-columns:auto 1fr;gap:6px 16px;font-size:13px;margin:0 0 16px}
  .kv dt{color:var(--muted)}
  .kv dd{margin:0;overflow-wrap:anywhere}
  .tags{display:flex;flex-wrap:wrap;gap:6px}
  .tags span{border:1px solid var(--line);border-radius:999px;padding:3px 10px;font-size:12px}
  .empty{color:var(--muted);text-align:center;padding:30px 0}
  .back{display:inline-flex;align-items:center;gap:4px;border:0;background:transparent;color:var(--muted);font:inherit;font-size:12px;cursor:pointer;padding:0 0 12px}
  .back:hover{color:var(--text)}
  .files{display:flex;flex-direction:column;gap:4px;margin:12px 0}
  .files button{display:flex;align-items:center;gap:8px;border:1px solid var(--line);background:transparent;color:var(--muted);border-radius:10px;padding:7px 10px;font:inherit;font-size:12px;cursor:pointer;text-align:left}
  .files button:hover{background:#ffffff0c}
  .files button span{flex:1;overflow-wrap:anywhere;color:var(--text)}
  .files button[aria-pressed=true]{border-color:var(--pink);background:#f0a6ca14}
  .viewer{border:1px solid var(--line);border-radius:14px;padding:12px 14px;background:#ffffff04}
  .code{margin:8px 0;padding:10px 12px;border-radius:10px;background:#0000004d;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;overflow-wrap:anywhere;color:#d6dfeb}
  .viewer>.code{margin:0;padding:0;background:transparent}
  .md h1{font-size:15px;margin:4px 0 8px}
  .md p code,.md li code{font:12px ui-monospace,SFMono-Regular,Menlo,monospace;padding:1px 5px;border-radius:5px;background:#ffffff12}
  .note{margin-top:12px;font-size:11px;color:var(--muted)}
  .list-head{font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);margin:0 0 8px}
  .search{width:100%;padding:9px 12px;margin:0 0 10px;border-radius:10px;border:1px solid var(--line);background:#ffffff08;color:var(--text);font:inherit}
  .search:focus{outline:2px solid var(--sky);outline-offset:1px}
  .setting{border:1px solid var(--line);border-radius:14px;padding:14px;background:#ffffff05}
  .setting-head{display:flex;align-items:baseline;justify-content:space-between;margin-bottom:12px}
  .setting-head small{color:var(--muted);font-size:11px}
  .swatches{display:flex;flex-wrap:wrap;gap:10px;margin-bottom:14px}
  .swatch{width:34px;height:34px;border-radius:50%;border:2px solid transparent;cursor:pointer;box-shadow:inset 0 0 0 3px var(--ink)}
  .swatch[aria-pressed=true]{border-color:var(--text);box-shadow:inset 0 0 0 3px var(--ink),0 0 12px currentColor}
  .custom{display:flex;align-items:center;gap:10px;font-size:12px;color:var(--muted)}
  .custom input{width:44px;height:30px;padding:0;border:1px solid var(--line);border-radius:8px;background:transparent;cursor:pointer}
  .custom code{font:12px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--text)}
  .styles{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:8px}
  .style-btn{aspect-ratio:1;display:grid;place-items:center;padding:7px;border:1px solid var(--line);border-radius:12px;background:#ffffff05;cursor:pointer}
  .style-btn:hover{background:#ffffff0f}
  .style-btn[aria-pressed=true]{border-color:var(--text);box-shadow:0 0 12px #ffffff22}
  .mini{display:grid;width:100%;gap:1px}
  .mini i{aspect-ratio:1;border-radius:1px}
  .label.zzz{font-weight:700;color:var(--sky);transition:opacity .4s}
  .zzz i{display:inline-block;font-style:normal;font-size:11px;opacity:.7;animation:zfloat 2.4s ease-in-out infinite}
  .zzz i:nth-child(2){font-size:14px;animation-delay:.8s}
  .zzz i:nth-child(3){font-size:17px;animation-delay:1.6s}
  @keyframes zfloat{0%{opacity:0;transform:translate(0,6px)}30%{opacity:.9}100%{opacity:0;transform:translate(8px,-14px)}}
  .label.badge{font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--pink);padding:2px 8px;border:1px solid #f0a6ca55;border-radius:999px;background:#f0a6ca14;transition:opacity .4s}
  .chart-bar{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:0 0 10px}
  .chart-bar .seg,.chart-bar .list-head{margin:0}
  .charts{display:grid;grid-template-columns:1fr 1fr;gap:8px}
  .chart{min-width:0;padding:12px;border:1px solid var(--line);border-radius:14px;background:#ffffff06}
  .chart.wide{grid-column:1/-1}
  .chart-head{display:flex;justify-content:space-between;align-items:baseline;gap:8px;font-size:12px;margin-bottom:8px}
  .chart-head small{color:var(--muted);font-size:11px;font-variant-numeric:tabular-nums}
  .chart-empty{color:var(--muted);font-size:12px;text-align:center;padding:18px 0}
  .chart-foot{margin-top:6px;font-size:11px;color:var(--muted);font-variant-numeric:tabular-nums}
  .ring-row{display:flex;align-items:center;gap:12px}
  .ring-chart{display:block;flex:none;width:72px;height:72px}
  .ring-chart .ring-value{fill:var(--text);font-size:15px;font-weight:300;text-anchor:middle;dominant-baseline:central;font-variant-numeric:tabular-nums}
  .bars-chart{display:block;width:100%;height:auto;margin-bottom:6px}
  .bars-chart .tick{fill:var(--muted);font-size:9px}
  .bars-chart .tick.end{text-anchor:end}
  .bars-chart .axis{stroke:var(--line);stroke-width:1}
  .bars-chart .grid{stroke:var(--line);stroke-width:1;stroke-dasharray:2 3}
  .bars-chart .hit{fill:transparent}
  .bars-chart .bar:hover .hit{fill:#ffffff0a}
  .bars-chart .fill{fill:currentColor;filter:drop-shadow(0 0 2px currentColor)}
  .bar{transform-box:fill-box;transform-origin:50% 100%}
  .arc{fill:none;stroke:currentColor;stroke-width:6;stroke-linecap:round;filter:drop-shadow(0 0 3px currentColor)}
  .track{fill:none;stroke:#ffffff14;stroke-width:6;stroke-linecap:round}
  .legend{display:flex;flex-wrap:wrap;gap:4px 10px;font-size:11px;color:var(--muted)}
  .ring-row .legend{flex-direction:column;gap:3px;min-width:0}
  .legend span{display:inline-flex;align-items:center;gap:5px}
  .legend i{width:7px;height:7px;border-radius:50%;flex:none;box-shadow:0 0 6px currentColor}
  .legend b{color:var(--text);font-weight:500;font-variant-numeric:tabular-nums}
  .hbars{display:flex;flex-direction:column;gap:6px}
  .hrow{display:grid;grid-template-columns:minmax(0,8.5em) 1fr auto;gap:8px;align-items:center;font-size:12px}
  .hrow span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--muted)}
  .hrow b{font-weight:500;font-variant-numeric:tabular-nums}
  .hbar{display:block;width:100%;height:10px;overflow:visible}
  .charts.enter .bar{animation:rise .6s cubic-bezier(.2,.8,.2,1) both}
  .charts.enter .arc{animation:glowin .7s ease-out both}
  @keyframes rise{from{transform:scaleY(0)}}
  @keyframes glowin{from{opacity:0}}
  .btn{display:inline-flex;align-items:center;gap:6px;min-height:32px;border:1px solid var(--line);background:#ffffff08;color:var(--text);border-radius:999px;padding:6px 12px;font:inherit;font-size:12px;cursor:pointer}
  .btn:hover{background:#ffffff14}
  .btn:disabled{opacity:.5;cursor:default}
  .btn.primary{background:var(--amber);border-color:var(--amber);color:var(--ink)}
  .btn.danger{color:var(--coral);border-color:#f47d7966}
  .actions{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 12px}
  .notice{margin:0 0 12px;padding:9px 12px;border:1px solid #f2c66d55;border-radius:12px;background:#f2c66d12;color:var(--amber);font-size:12px}
  .confirm{margin:0 0 12px;padding:10px 12px;border:1px solid #f47d7966;border-radius:12px;background:#f47d7910;font-size:12px}
  .confirm .actions{margin:8px 0 0}
  .done{margin:0 0 10px;color:var(--mint);font-size:12px}
  .form-error{margin:0 0 10px;color:var(--coral);font-size:12px;overflow-wrap:anywhere}
  .field{display:flex;flex-direction:column;gap:4px;min-width:0;margin:0 0 12px;padding:0;border:0}
  .field[hidden]{display:none}
  .field>label,.field>legend{padding:0;font-size:12px;color:var(--muted)}
  .field input,.field select,.field textarea{width:100%;min-width:0;padding:8px 10px;border-radius:10px;border:1px solid var(--line);background:#ffffff08;color:var(--text);font:inherit}
  .field input:focus,.field select:focus,.field textarea:focus{outline:2px solid var(--sky);outline-offset:1px}
  .field textarea{resize:vertical}
  .field small{font-size:11px;color:var(--muted)}
  .field [aria-invalid=true]{border-color:var(--coral)}
  .field option{background:#0e1524;color:var(--text)}
  .field-error{color:var(--coral);font-size:11px}
  .form-error:empty,.field-error:empty,.done:empty{display:none}
  .daypick{display:flex;flex-wrap:wrap;gap:6px}
  .daypick label{display:inline-flex;align-items:center;gap:4px;border:1px solid var(--line);border-radius:999px;padding:4px 10px;font-size:12px;cursor:pointer}
  .daypick input{width:auto;margin:0}
  .row2{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:0 10px}
  .preview{margin:0 0 12px;padding:10px 12px;border:1px solid var(--line);border-radius:12px;background:#ffffff05;font-size:12px}
  .preview ol{margin:4px 0 0;padding-left:18px;font-variant-numeric:tabular-nums}
  .preview li.muted{list-style:none;margin-left:-18px;color:var(--muted)}
  .item .sched{font-size:12px;color:var(--muted);overflow-wrap:anywhere}
  .files .pill{flex:none}
  @media (max-width:420px){.charts{grid-template-columns:1fr}.row2{grid-template-columns:minmax(0,1fr)}}
  @media (max-width:640px){.drawer{top:auto;bottom:0;height:78%;height:78dvh;width:100%;border-left:0;border-top:1px solid var(--line);border-radius:22px 22px 0 0;transform:translateY(102%)}.label.core b{font-size:20px}.label span{letter-spacing:.12em;font-size:8.5px}}
  @media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
</style>
<script type="importmap">
{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js","three/addons/":"https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/"}}
</script>
</head>
<body>
<div id="stage"></div>
<header class="top">
  <div class="brand"><div class="mark"></div>inoai</div>
  <div class="chip"><span id="status-dot" class="dot"></span><span id="status-text">loading</span><button id="refresh" type="button" aria-pressed="true" title="Auto refresh every minute">auto</button></div>
</header>
<div id="labels"></div>
<div id="tooltip" class="tooltip" role="status"></div>
<div id="hint" class="hint">tap a ring</div>
<div id="fallback" class="fallback">The ring view needs WebGL and the three.js CDN. Open the drawer from the status chip.</div>
<aside id="drawer" class="drawer" aria-hidden="true" aria-labelledby="d-title">
  <div class="d-head"><div id="d-ico" class="ring-ico"></div><div style="flex:1"><small id="d-kicker"></small><h2 id="d-title"></h2></div><button id="d-close" class="close" type="button" aria-label="Close details">×</button></div>
  <nav id="d-rail" class="rail" aria-label="Sections"></nav>
  <div id="d-body" class="d-body"></div>
</aside>

<script type="module">
// ---------- data ----------
const EMPTY = { profile: { agentInstanceId: 'unknown', provider: 'unknown', transport: 'unknown', workspaceIds: [], status: 'unknown' }, metrics: { messages24h: 0, messages30d: 0, failedReplies24h: 0, failedReplies30d: 0, activeSessions: 0, messagesPerSession: 0 }, agentMarkdown: '', skills: [], skillDetails: [], tasks: [], taskRuns: [], tools: [], health: [], messages: [], memories: [], insights: null };
async function loadData() {
  try {
    const data = await (await fetch('/api/ui-data', { cache: 'no-store' })).json();
    return data && !data.error ? { ...EMPTY, ...data } : { ...EMPTY, unavailable: true };
  } catch { return { ...EMPTY, unavailable: true }; }
}

const HOUR = 3_600_000, DAY = 24 * HOUR;
const RANK = { unknown: 0, healthy: 1, degraded: 2, restarted: 3, blocked: 4 };
function healthState(event) {
  let detail = {};
  try { detail = JSON.parse(event.detail ?? '{}') ?? {}; } catch { /* plain-text detail */ }
  if (event.eventType === 'heartbeat_recovery') return 'healthy';
  if (detail.status === 'blocked') return 'blocked';
  if (detail.action === 'restart') return 'restarted';
  if (detail.status === 'degraded') return 'degraded';
  if (detail.status === 'healthy') return 'healthy';
  return 'unknown';
}
function describe(detail) {
  if (!detail) return 'No detail recorded';
  try {
    const parsed = JSON.parse(detail);
    return Object.entries(parsed).filter(([key]) => key !== 'status').map(([key, value]) => key.replaceAll('_', ' ') + ' ' + value).join(' · ');
  } catch { return detail; }
}
function derive(data) {
  const now = Date.now(), m = data.metrics;
  const end = Math.floor(now / HOUR) * HOUR + HOUR;
  const hours = Array.from({ length: 24 }, (_, i) => ({ start: end - (24 - i) * HOUR, state: 'unknown', events: [] }));
  for (const event of data.health) {
    const slot = hours[Math.floor((Date.parse(event.createdAt) - (end - DAY)) / HOUR)];
    if (!slot) continue;
    const state = healthState(event);
    slot.events.push({ ...event, state });
    if (RANK[state] > RANK[slot.state]) slot.state = state;
  }
  const known = hours.filter((h) => h.state !== 'unknown');
  const recent = data.messages.filter((x) => now - Date.parse(x.createdAt) <= DAY);
  const replies24h = recent.filter((x) => x.direction === 'agent').length;
  const share = (items, test) => items.length ? items.filter(test).length / items.length : 0;
  return {
    data, m, hours,
    healthPct: known.length ? Math.round(100 * known.filter((h) => h.state === 'healthy').length / known.length) : null,
    // A full activity ring means twice the 30-day daily average.
    activityFrac: m.messages30d ? Math.min(1, m.messages24h / ((m.messages30d / 30) * 2)) : 0,
    failureFrac: replies24h ? Math.min(1, m.failedReplies24h / replies24h) : 0,
    activeTasks: data.tasks.filter((x) => x.state === 'active'),
    reviewedFrac: share(data.memories, (x) => x.review?.state === 'completed'),
    name: data.profile.agentInstanceId.replace(/^inoai-connect-?/, '') || data.profile.agentInstanceId,
  };
}
let view = derive(await loadData());

// ---------- drawer (plain DOM, works without WebGL) ----------
const ICONS = { profile: 'robot', health: 'heart-rate', activity: 'chart-line-up', failures: 'triangle-warning', conversations: 'comments', tasks: 'calendar-clock', memory: 'brain', skills: 'sparkles', settings: 'settings' };
const icon = (key) => h('i', { class: 'fi fi-rr-' + (ICONS[key] ?? key), 'aria-hidden': 'true' });
const CSS = { profile: 'var(--text)', health: 'var(--mint)', activity: 'var(--sky)', failures: 'var(--coral)', conversations: 'var(--sky)', tasks: 'var(--amber)', memory: 'var(--violet)', skills: 'var(--pink)', settings: 'var(--muted)' };
const STATE_CSS = { healthy: 'var(--mint)', degraded: 'var(--amber)', restarted: 'var(--coral)', blocked: 'var(--coral)', unknown: 'var(--slate)', completed: 'var(--mint)', failed: 'var(--coral)', processing: 'var(--amber)', pending: 'var(--amber)', running: 'var(--mint)', stopped: 'var(--coral)', active: 'var(--mint)', paused: 'var(--amber)', cancelled: 'var(--slate)' };
const h = (tag, props = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) { if (k === 'class') el.className = v; else if (k === 'style') el.style.cssText = v; else if (k.startsWith('on')) el.addEventListener(k.slice(2), v); else el.setAttribute(k, v); }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
  return el;
};
const clock = (ms) => new Date(ms).toTimeString().slice(0, 5);
const when = (iso) => { const t = Date.parse(iso); return Date.now() - t < DAY ? clock(t) : new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' · ' + clock(t); };
const pill = (state, text = state) => h('span', { class: 'pill', style: 'color:' + (STATE_CSS[state] ?? 'var(--muted)') }, text);
const toggle = (e) => { const b = e.currentTarget; b.setAttribute('aria-expanded', String(b.getAttribute('aria-expanded') !== 'true')); };
const empty = (text = 'Nothing here yet') => h('div', { class: 'empty' }, text);
const messageItem = (x) => h('button', { class: 'item', type: 'button', 'aria-expanded': 'false', onclick: toggle },
  h('div', { class: 'meta' }, x.direction === 'agent' ? 'agent' : 'owner', pill(x.state), h('span', { class: 'when' }, when(x.createdAt))),
  h('p', {}, x.body), h('div', { class: 'more' }, '#' + x.id + ' · ' + x.workspaceId + ' · ' + x.transport + ' · updated ' + when(x.updatedAt)));
const reviewKey = (x) => x.review ? (x.review.state === 'completed' ? 'reviewed' : 'in review') : 'not reviewed';
const memoryItem = (x) => h('button', { class: 'item', type: 'button', 'aria-expanded': 'false', onclick: toggle },
  h('div', { class: 'meta' }, x.origin, pill(x.review ? (x.review.state === 'completed' ? 'completed' : 'processing') : 'unknown', reviewKey(x)), h('span', { class: 'when' }, when(x.createdAt))),
  h('p', {}, x.body),
  h('div', { class: 'more' }, '#' + x.id + ' · ' + (x.review ? 'Review #' + x.review.id + ' · ' + x.review.state + (x.review.recap ? ' · ' + x.review.recap : '') : 'No linked memory review yet')));
// Task rows: kind, state, next due time, and run history on expand.
const taskKind = (x) => {
  if (x.taskType !== 'recurring') return 'one-time';
  const hours = (x.intervalSeconds ?? 0) / 3600;
  return 'every ' + (hours % 24 === 0 ? hours / 24 + 'd' : hours + 'h');
};

// ---------- task client: schedule preview and writes ----------
// This section uses only Intl, fetch, and the token meta tag, so tests can run it.
// The preview mirrors nextRunAt in src/inoai/tasks/schedule.ts. The server stays authoritative.
const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const zoneFormatters = new Map();
function zoneParts(unix, timeZone) {
  let format = zoneFormatters.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
    zoneFormatters.set(timeZone, format);
  }
  const parts = {};
  for (const { type, value } of format.formatToParts(new Date(unix * 1000))) if (type !== 'literal') parts[type] = Number(value);
  return parts;
}
const zoneWall = (unix, tz) => { const p = zoneParts(unix, tz); return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) / 1000; };
const zoneOffset = (unix, tz) => zoneWall(unix, tz) - unix;
// A repeated local time resolves to its first instant; a skipped one to the first instant after the gap.
function zoneToUnix(year, month, day, hour, minute, tz) {
  const wall = Date.UTC(year, month - 1, day, hour, minute) / 1000;
  const guesses = [wall - zoneOffset(wall - 86400, tz), wall - zoneOffset(wall + 86400, tz)];
  const valid = guesses.filter((at) => zoneWall(at, tz) === wall).sort((a, b) => a - b);
  if (valid.length) return valid[0];
  let low = Math.min(...guesses), high = Math.max(...guesses);
  const target = zoneOffset(high, tz);
  while (high - low > 60) { const middle = low + Math.floor((high - low) / 120) * 60; if (zoneOffset(middle, tz) === target) high = middle; else low = middle; }
  return high;
}
function nextClockRun(schedule, tz, after) {
  const [hour, minute] = schedule.time.split(':').map(Number);
  const allowed = schedule.kind === 'days' ? schedule.days : schedule.kind === 'weekly' ? [schedule.day] : null;
  const start = zoneParts(after, tz);
  for (let offset = 0; offset <= 8; offset += 1) {
    const date = new Date(Date.UTC(start.year, start.month - 1, start.day + offset));
    if (allowed && !allowed.includes(WEEKDAYS[(date.getUTCDay() + 6) % 7])) continue;
    const at = zoneToUnix(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), hour, minute, tz);
    if (at > after) return at;
  }
  return null;
}
function nextTaskRun(spec, after, runsSoFar) {
  const s = spec.schedule;
  if (s.kind === 'once' && runsSoFar >= 1) return null;
  if (spec.maxRuns != null && runsSoFar >= spec.maxRuns) return null;
  const next = s.kind === 'once' ? s.at ?? after : s.kind === 'interval' ? after + s.hours * 3600 : nextClockRun(s, spec.timezone, after);
  if (next === null || (spec.endsAt != null && next > spec.endsAt)) return null;
  return next;
}
// The next runs in order. Each run is computed after the previous one, as the scheduler does.
function previewRuns(spec, now, runsSoFar = 0, count = 3) {
  const runs = [];
  let after = now, done = runsSoFar;
  while (runs.length < count) { const next = nextTaskRun(spec, after, done); if (next === null) break; runs.push(next); after = next; done += 1; }
  return runs;
}
const pad2 = (n) => String(n).padStart(2, '0');
// datetime-local values are wall-clock times in the task's time zone.
function localInputToUnix(value, tz) {
  const match = /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2})/.exec(value ?? '');
  return match ? zoneToUnix(Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4]), Number(match[5]), tz) : null;
}
function unixToLocalInput(unix, tz) {
  const p = zoneParts(unix, tz);
  return p.year + '-' + pad2(p.month) + '-' + pad2(p.day) + 'T' + pad2(p.hour) + ':' + pad2(p.minute);
}
const TOKEN_HEADER = 'x-inoai-token';
const uiToken = () => document.querySelector('meta[name="inoai-ui-token"]')?.getAttribute('content') ?? '';
// Sends one task write as JSON with the per-launch token. Without a token, nothing is sent.
async function taskWrite(method, path, body = {}) {
  const token = uiToken();
  if (!/^[0-9a-f]+$/.test(token)) return { ok: false, status: 0, error: 'This page has no write token. Reload the page.', fields: {} };
  let response;
  try {
    response = await fetch(path, { method, cache: 'no-store', headers: { 'content-type': 'application/json', [TOKEN_HEADER]: token }, body: JSON.stringify(body) });
  } catch { return { ok: false, status: 0, error: 'The UI server is not reachable. Try again.', fields: {} }; }
  let data = null;
  try { data = await response.json(); } catch { /* not JSON */ }
  if (response.ok && data?.task) return { ok: true, status: response.status, task: data.task };
  return { ok: false, status: response.status, error: data?.error ?? 'Request failed (' + response.status + ').', fields: data?.fields ?? {}, retryable: data?.retryable === true };
}
// Text fields that the read model redacted. Saving one unchanged would store the placeholder.
const REDACTED_SOURCE = { title: 'title', instruction: 'goal', expectedOutput: 'outputSpec' };
const REDACTED_ERROR = 'Re-enter this text before saving. It still shows hidden values.';
function unchangedRedacted(task, spec) {
  const errors = {};
  for (const key of task?.redactedFields ?? []) if (REDACTED_SOURCE[key] && (spec[key] ?? '') === (task[REDACTED_SOURCE[key]] ?? '')) errors[key] = REDACTED_ERROR;
  return errors;
}
// Creates a task, or edits the given task. An edit that still holds redacted text is refused before any request.
async function saveTask(task, spec) {
  const errors = unchangedRedacted(task, spec);
  if (Object.keys(errors).length) return { ok: false, status: 0, error: 'Fix the fields marked below.', fields: errors };
  return task ? taskWrite('PATCH', '/api/tasks/' + task.id, spec) : taskWrite('POST', '/api/tasks', spec);
}
// ---------- end task client ----------

// ---------- tasks: list, detail, and form ----------
// taskView: { mode: 'list' } | { mode: 'detail', id, run, confirm, busy, error, done } | { mode: 'form', id }
let taskView = { mode: 'list' };
const READ_ONLY_STATES = ['completed', 'cancelled'];
const KIND_OPTIONS = [['now', 'Once, now'], ['at', 'Once, at a time'], ['interval', 'Every N hours'], ['daily', 'Daily'], ['days', 'Selected days'], ['weekly', 'Weekly']];
const DAY_NAMES = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };
const ACTION_DONE = { run: 'Run requested. It starts when the agent picks it up.', pause: 'Task paused.', resume: 'Task resumed.', cancel: 'Task cancelled. A run in progress finishes.' };
const isProcessing = (x) => x.runs.lastState === 'processing';
const taskName = (x) => x.title || x.goal;
const scheduleText = (x) => x.scheduleLabel ?? taskKind(x);
const stamp = (iso) => iso ? new Date(iso).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) : '—';
const zoneStamp = (unix, tz) => new Date(unix * 1000).toLocaleString(undefined, { timeZone: tz, weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const browserZone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } };
// Canonical IANA names from the browser, plus the selected zone and UTC.
function timeZoneNames(selected) {
  let zones = [];
  try { zones = Intl.supportedValuesOf('timeZone'); } catch { /* older browser */ }
  return [...new Set([...zones, selected, 'UTC'].filter(Boolean))].sort();
}
const stoppedNotice = (v) => v.data.profile.status === 'stopped' ? h('div', { class: 'notice', role: 'status' }, 'Changes run when the agent is running.') : null;
const actionButton = (label, onclick, kind = '', ico = null, busy = false) => h('button', { type: 'button', class: 'btn ' + kind, onclick, ...(busy ? { disabled: '' } : {}) }, ico ? icon(ico) : null, label);
function redrawTasks(keepScroll = true) {
  if (openSection !== 'tasks') return;
  const body = document.getElementById('d-body'), scroll = body.scrollTop;
  openDrawer('tasks', true);
  if (keepScroll) body.scrollTop = scroll;
}
const showTasks = (next) => { taskView = next; redrawTasks(false); };
async function reloadView() {
  view = derive(await loadData());
  renderStatus();
  listeners.forEach((fn) => fn(view));
}
async function runTaskAction(id, action) {
  const run = taskView.run;
  taskView = { mode: 'detail', id, run, busy: true };
  redrawTasks();
  const result = await taskWrite('POST', '/api/tasks/' + id + '/' + action);
  if (result.ok) await reloadView();
  if (taskView.mode === 'detail' && taskView.id === id) taskView = { mode: 'detail', id, run, error: result.ok ? null : result.error, done: result.ok ? ACTION_DONE[action] : null };
  redrawTasks();
}
const taskRow = (x) => h('button', { class: 'item', type: 'button', 'data-task': String(x.id), onclick: () => showTasks({ mode: 'detail', id: x.id }) },
  h('div', { class: 'meta' }, pill(x.state), isProcessing(x) ? pill('processing', 'running') : null,
    h('span', { class: 'when' }, x.state === 'active' && x.nextDueAt ? 'next ' + stamp(x.nextDueAt) : stamp(x.createdAt))),
  h('p', {}, taskName(x)),
  h('div', { class: 'sched' }, scheduleText(x)));
function taskList(v) {
  return { kicker: v.activeTasks.length + ' active', title: v.data.tasks.length + ' tasks', body: [
    stoppedNotice(v),
    h('div', { class: 'actions' }, actionButton('New task', () => showTasks({ mode: 'form' }), 'primary', 'plus')),
    searchable({ state: searchState.tasks, items: v.data.tasks, noun: 'tasks', options: ['all', 'active', 'paused', 'completed', 'cancelled'], key: (x) => x.state,
      text: (x) => [x.title ?? '', x.goal, '#' + x.id, scheduleText(x)].join(' '), render: taskRow, placeholder: 'Search title, goal or #id' })] };
}
function taskDetail(v) {
  const x = v.data.tasks.find((t) => t.id === taskView.id);
  if (!x) { taskView = { mode: 'list' }; return taskList(v); }
  const runs = (v.data.taskRuns ?? []).filter((r) => r.taskId === x.id);
  const selected = runs.find((r) => r.id === taskView.run) ?? runs[0];
  const busy = taskView.busy === true, processing = isProcessing(x);
  const controls = READ_ONLY_STATES.includes(x.state)
    ? h('div', { class: 'note', style: 'margin:0 0 12px' }, 'This task is ' + x.state + ' and read-only.')
    : taskView.confirm
      ? h('div', { class: 'confirm', role: 'group', 'aria-label': 'Confirm cancel' }, h('span', {}, 'Are you sure? Cancel stops future runs. A run in progress finishes. This cannot be undone.'),
        h('div', { class: 'actions' },
          actionButton('Yes, cancel task', () => runTaskAction(x.id, 'cancel'), 'danger', 'cross-circle', busy),
          actionButton('Keep task', () => { taskView = { ...taskView, confirm: false }; redrawTasks(); }, '', null, busy)))
      : h('div', { class: 'actions' },
        processing ? null : actionButton('Edit', () => showTasks({ mode: 'form', id: x.id }), '', 'edit', busy),
        x.state === 'active' ? actionButton('Run now', () => runTaskAction(x.id, 'run'), '', 'play', busy) : null,
        x.state === 'active' ? actionButton('Pause', () => runTaskAction(x.id, 'pause'), '', 'pause', busy) : null,
        x.state === 'paused' ? actionButton('Resume', () => runTaskAction(x.id, 'resume'), '', 'play', busy) : null,
        actionButton('Cancel task', () => { taskView = { ...taskView, confirm: true, error: null, done: null }; redrawTasks(); }, 'danger', 'cross-circle', busy));
  const result = !selected ? null
    : selected.result !== null ? (selected.result.trim() ? markdown(selected.result, true) : empty('result.md is empty'))
      : empty(selected.resultNote ?? 'No result.md');
  return { kicker: 'task #' + x.id + ' · ' + x.state, title: taskName(x), body: [
    h('button', { class: 'back', type: 'button', onclick: () => showTasks({ mode: 'list' }) }, icon('angle-small-left'), 'all tasks'),
    stoppedNotice(v),
    h('div', { class: 'done', role: 'status' }, taskView.done ?? ''),
    h('div', { class: 'form-error', role: 'alert' }, taskView.error ?? ''),
    controls,
    processing && !READ_ONLY_STATES.includes(x.state) ? h('div', { class: 'note', style: 'margin:0 0 12px' }, 'A run is in progress. Edit returns when it finishes.') : null,
    h('dl', { class: 'kv' },
      h('dt', {}, 'Schedule'), h('dd', {}, scheduleText(x)),
      h('dt', {}, 'Next run'), h('dd', {}, x.state === 'active' && x.nextDueAt ? stamp(x.nextDueAt) : '—'),
      h('dt', {}, 'Time zone'), h('dd', {}, x.timezone ?? '—'),
      h('dt', {}, 'Runs'), h('dd', {}, x.runs.completed + ' completed · ' + x.runs.failed + ' failed'),
      h('dt', {}, 'Instruction'), h('dd', { style: 'white-space:pre-wrap' }, x.goal),
      h('dt', {}, 'Expected output'), h('dd', { style: 'white-space:pre-wrap' }, x.outputSpec ?? '—'),
      h('dt', {}, 'Created'), h('dd', {}, stamp(x.createdAt))),
    h('div', { class: 'list-head' }, 'Run history · ' + (runs.length >= 20 ? 'newest 20' : runs.length)),
    runs.length ? h('div', { class: 'files', role: 'list', 'aria-label': 'Run history' }, runs.map((r) => h('button', { type: 'button', 'aria-pressed': String(r === selected), onclick: () => { taskView = { ...taskView, run: r.id }; redrawTasks(); } },
      pill(r.state), h('span', {}, 'Run #' + r.id + ' · ' + stamp(r.startedAt)), h('small', {}, r.completedAt ? duration(Math.max(0, (Date.parse(r.completedAt) - Date.parse(r.startedAt)) / 1000)) : '')))) : empty('No runs yet'),
    selected ? h('div', { class: 'list-head', style: 'margin-top:12px' }, 'Run #' + selected.id + ' · result.md') : null,
    selected ? h('div', { class: 'viewer' }, result) : null,
    selected?.failureDetail ? h('div', { class: 'note' }, 'Failure: ' + selected.failureDetail) : null] };
}
// Form values from a task. A new task starts with the browser's time zone.
function taskDraft(x) {
  const draft = { title: '', instruction: '', expectedOutput: '', kind: 'now', at: '', hours: '1', time: '09:00', days: ['mon', 'tue', 'wed', 'thu', 'fri'], day: 'mon', timezone: browserZone(), until: '', maxRuns: '' };
  if (!x) return draft;
  const tz = x.timezone || 'UTC';
  const due = x.nextDueAt ? Date.parse(x.nextDueAt) / 1000 : null;
  const once = x.scheduleKind ? x.scheduleKind === 'once' : x.taskType !== 'recurring';
  const kind = once ? (due !== null && due * 1000 > Date.now() ? 'at' : 'now') : x.scheduleKind ?? 'interval';
  const days = (x.scheduleDays ?? '').split(',').filter((d) => WEEKDAYS.includes(d));
  return { ...draft, title: x.title ?? '', instruction: x.goal, expectedOutput: x.outputSpec ?? '', kind, at: kind === 'at' ? unixToLocalInput(due, tz) : '',
    hours: String(x.intervalSeconds ? Math.max(1, Math.round(x.intervalSeconds / 3600)) : 1), time: x.scheduleTime ?? draft.time,
    days: days.length ? days : draft.days, day: days[0] ?? draft.day, timezone: tz,
    until: x.endsAt ? unixToLocalInput(Date.parse(x.endsAt) / 1000, tz) : '', maxRuns: x.maxRuns == null ? '' : String(x.maxRuns) };
}
function taskForm(v) {
  const x = taskView.id === undefined ? null : v.data.tasks.find((t) => t.id === taskView.id);
  if (taskView.id !== undefined && (!x || READ_ONLY_STATES.includes(x.state) || isProcessing(x))) { taskView = x ? { mode: 'detail', id: x.id } : { mode: 'list' }; return SECTIONS.tasks(v); }
  const d = taskDraft(x);
  const errors = {}, controls = {};
  const errorSlot = (key) => (errors[key] = h('div', { class: 'field-error', id: 'tf-error-' + key.replace('.', '-') }));
  const field = (id, label, control, keys, hint = null) => {
    controls[id] = control; control.id = 'tf-' + id;
    return h('div', { class: 'field', 'data-field': id }, h('label', { for: 'tf-' + id }, label), control, hint ? h('small', {}, hint) : null, keys.map(errorSlot));
  };
  const option = (value, label, selected) => h('option', { value, ...(selected ? { selected: '' } : {}) }, label);
  const hidden = (key, hint = null) => (x?.redactedFields ?? []).includes(key) ? 'Shown with hidden values. Re-enter this text before saving.' : hint;
  const titleField = field('title', 'Title', h('input', { type: 'text', maxlength: '100', value: d.title, autocomplete: 'off' }), ['title'], hidden('title'));
  const instructionField = field('instruction', 'Instruction (required)', h('textarea', { rows: '4', maxlength: '4000', required: '' }, d.instruction), ['instruction'], hidden('instruction'));
  const outputField = field('output', 'Expected output', h('textarea', { rows: '2', maxlength: '2000' }, d.expectedOutput), ['expectedOutput'], hidden('expectedOutput', 'Optional. For example: a Markdown list of failing jobs.'));
  const kindField = field('kind', 'Schedule', h('select', {}, KIND_OPTIONS.map(([value, label]) => option(value, label, value === d.kind))), ['schedule', 'schedule.kind']);
  const atField = field('at', 'Run at', h('input', { type: 'datetime-local', value: d.at }), ['schedule.at']);
  const hoursField = field('hours', 'Every (hours)', h('input', { type: 'number', min: '1', step: '1', inputmode: 'numeric', value: d.hours }), ['schedule.hours'], 'At least 1 hour.');
  const timeField = field('time', 'At (24-hour time)', h('input', { type: 'time', value: d.time }), ['schedule.time']);
  const dayField = field('day', 'Day', h('select', {}, WEEKDAYS.map((day) => option(day, DAY_NAMES[day], day === d.day))), ['schedule.day']);
  const dayBoxes = {};
  const daysField = h('fieldset', { class: 'field', 'data-field': 'days' }, h('legend', {}, 'Days'),
    h('div', { class: 'daypick' }, WEEKDAYS.map((day) => h('label', {}, dayBoxes[day] = h('input', { type: 'checkbox', value: day, ...(d.days.includes(day) ? { checked: '' } : {}) }), DAY_NAMES[day]))), errorSlot('schedule.days'));
  const zoneField = field('zone', 'Time zone', h('select', {}, timeZoneNames(d.timezone).map((zone) => option(zone, zone, zone === d.timezone))), ['timezone'],
    x ? 'Times on this form use this time zone.' : 'Filled from this browser. Times on this form use this time zone.');
  const untilField = field('until', 'Until (optional)', h('input', { type: 'datetime-local', value: d.until }), ['endsAt'], 'No runs after this time.');
  const maxField = field('max', 'Run limit (optional)', h('input', { type: 'number', min: '1', step: '1', inputmode: 'numeric', value: d.maxRuns }), ['maxRuns'], 'Stops after this many runs.');
  const general = h('div', { class: 'form-error', role: 'alert' });
  const previewHead = h('div', { class: 'list-head', style: 'margin:0' }), previewList = h('ol');
  const saveLabel = x ? 'Save changes' : 'Create task';
  const save = h('button', { type: 'submit', class: 'btn primary' }, icon(x ? 'disk' : 'plus'), saveLabel);
  const runsSoFar = x ? x.runs.completed + x.runs.failed : 0;
  const read = () => {
    const kind = controls.kind.value, tz = controls.zone.value, local = {};
    let schedule;
    if (kind === 'now') schedule = { kind: 'once' };
    else if (kind === 'at') { const at = localInputToUnix(controls.at.value, tz); if (at === null) local['schedule.at'] = 'Choose a run time.'; schedule = { kind: 'once', at }; }
    else if (kind === 'interval') schedule = { kind, hours: controls.hours.value === '' ? null : Number(controls.hours.value) };
    else if (kind === 'daily') schedule = { kind, time: controls.time.value };
    else if (kind === 'days') schedule = { kind, time: controls.time.value, days: WEEKDAYS.filter((day) => dayBoxes[day].checked) };
    else schedule = { kind: 'weekly', time: controls.time.value, day: controls.day.value };
    const once = kind === 'now' || kind === 'at';
    let endsAt = null, maxRuns = null;
    if (!once && controls.until.value) { endsAt = localInputToUnix(controls.until.value, tz); if (endsAt === null) local.endsAt = 'Choose a valid stop time.'; }
    if (!once && controls.max.value !== '') maxRuns = Number(controls.max.value);
    const spec = { title: controls.title.value, instruction: controls.instruction.value, expectedOutput: controls.output.value.trim() ? controls.output.value : null, schedule, timezone: tz, endsAt, maxRuns };
    return { spec, local };
  };
  const previewable = (spec) => {
    const s = spec.schedule;
    if (s.kind === 'once') return s.at !== null;
    if (s.kind === 'interval') return Number.isInteger(s.hours) && s.hours >= 1;
    if (!/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(s.time)) return false;
    if (s.kind === 'days' && !s.days.length) return false;
    return spec.maxRuns === null || (Number.isInteger(spec.maxRuns) && spec.maxRuns >= 1);
  };
  const update = () => {
    const kind = controls.kind.value, once = kind === 'now' || kind === 'at';
    atField.hidden = kind !== 'at'; hoursField.hidden = kind !== 'interval'; timeField.hidden = !['daily', 'days', 'weekly'].includes(kind);
    daysField.hidden = kind !== 'days'; dayField.hidden = kind !== 'weekly'; untilField.hidden = once; maxField.hidden = once;
    const { spec, local } = read();
    previewHead.textContent = 'Next runs · ' + spec.timezone;
    let runs = [];
    const ok = !Object.keys(local).length && previewable(spec);
    if (ok) { try { runs = previewRuns(spec, Math.floor(Date.now() / 1000), runsSoFar, 3); } catch { runs = []; } }
    previewList.replaceChildren(...(runs.length ? runs.map((at) => h('li', {}, zoneStamp(at, spec.timezone)))
      : [h('li', { class: 'muted' }, ok ? 'No run before the stop condition.' : 'Complete the schedule to see its next runs.')]));
  };
  const clearErrors = () => {
    general.textContent = '';
    for (const slot of Object.values(errors)) slot.textContent = '';
    for (const control of [...Object.values(controls), ...Object.values(dayBoxes)]) control.removeAttribute('aria-invalid');
  };
  const FIELD_OF = { title: 'title', instruction: 'instruction', expectedOutput: 'output', schedule: 'kind', 'schedule.kind': 'kind', 'schedule.at': 'at', 'schedule.hours': 'hours',
    'schedule.time': 'time', 'schedule.day': 'day', timezone: 'zone', endsAt: 'until', maxRuns: 'max' };
  const showErrors = (fields) => {
    const extra = [];
    for (const [key, message] of Object.entries(fields ?? {})) {
      if (errors[key]) errors[key].textContent = message; else extra.push(message);
      controls[FIELD_OF[key]]?.setAttribute('aria-invalid', 'true');
    }
    return extra;
  };
  const submit = async (event) => {
    event.preventDefault();
    clearErrors();
    const { spec, local } = read();
    if (Object.keys(local).length) { showErrors(local); general.textContent = 'Fix the fields marked below.'; return; }
    save.disabled = true; save.lastChild.textContent = 'Saving…';
    const result = await saveTask(x, spec);
    if (!result.ok) {
      save.disabled = false; save.lastChild.textContent = saveLabel;
      const extra = showErrors(result.fields);
      general.textContent = [result.status === 400 && Object.keys(result.fields ?? {}).length ? 'Fix the fields marked below.' : result.error, ...extra].join(' ');
      general.scrollIntoView?.({ block: 'nearest' });
      return;
    }
    await reloadView();
    showTasks({ mode: 'detail', id: result.task.id, done: x ? 'Task saved.' : 'Task created.' });
  };
  const form = h('form', { novalidate: '', 'aria-label': x ? 'Edit task' : 'New task', onsubmit: submit, oninput: update, onchange: update },
    general, titleField, instructionField, outputField, kindField, atField, hoursField, timeField, daysField, dayField,
    h('div', { class: 'row2' }, untilField, maxField), zoneField,
    h('div', { class: 'preview', 'aria-live': 'polite' }, previewHead, previewList, h('div', { class: 'note', style: 'margin-top:6px' }, 'Preview only. The server checks the schedule when you save.')),
    h('div', { class: 'actions' }, save, actionButton('Discard', () => showTasks(x ? { mode: 'detail', id: x.id } : { mode: 'list' }))));
  update();
  return { kicker: x ? 'edit task #' + x.id : 'new task', title: x ? taskName(x) : 'New task', body: [
    h('button', { class: 'back', type: 'button', onclick: () => showTasks(x ? { mode: 'detail', id: x.id } : { mode: 'list' }) }, icon('angle-small-left'), x ? 'back to task' : 'all tasks'),
    stoppedNotice(v), form] };
}

// Searchable list: text search plus one filter row. Each section keeps its own
// query and filter, so they survive refreshes and section switches.
const SEARCH_RESULT_LIMIT = 200;
const searchState = { conversations: { query: '', option: 'all' }, tasks: { query: '', option: 'all' }, memory: { query: '', option: 'all' } };
function searchable({ state, items, noun, options, key, text, render, placeholder }) {
  const count = h('div', { class: 'list-head' }), results = h('div', { class: 'list' });
  const run = () => {
    const query = state.query.trim().toLowerCase();
    const rows = items.filter((x) => (state.option === 'all' || key(x) === state.option) && (!query || text(x).toLowerCase().includes(query)));
    count.textContent = rows.length + ' of ' + items.length + ' ' + noun;
    results.replaceChildren(...(rows.length ? rows.slice(0, SEARCH_RESULT_LIMIT).map(render) : [empty(query ? 'No matches' : 'Nothing here yet')]));
    if (rows.length > SEARCH_RESULT_LIMIT) results.append(h('div', { class: 'note' }, 'Showing the newest ' + SEARCH_RESULT_LIMIT + ' · refine the search'));
  };
  const input = h('input', { type: 'search', class: 'search', placeholder, 'aria-label': placeholder, value: state.query, oninput: (e) => { state.query = e.currentTarget.value; run(); } });
  const seg = h('div', { class: 'seg' }, options.map((option) => h('button', { type: 'button', 'aria-pressed': String(option === state.option), onclick: (e) => {
    state.option = option; seg.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b === e.currentTarget))); run();
  } }, option)));
  run();
  return h('div', {}, input, seg, count, results);
}
const NEWLINE = String.fromCharCode(10), TICK = String.fromCharCode(96), FENCE = TICK.repeat(3);
// Inline code spans; everything stays text nodes.
const inline = (text) => text.split(TICK).map((part, i) => i % 2 ? h('code', {}, part) : part);
function markdown(source, keepTitle = false) {
  const box = h('div', { class: 'md' }); let ul = null, code = null;
  let lines = source.split(NEWLINE);
  if (lines[0] === '---') { const end = lines.indexOf('---', 1); if (end > 0) lines = lines.slice(end + 1); }
  for (const line of lines) {
    if (line.startsWith(FENCE)) { ul = null; if (code) code = null; else box.append(h('pre', { class: 'code' }, code = h('code'))); continue; }
    if (code) { code.append(line + NEWLINE); continue; }
    if (/^# /.test(line)) { ul = null; if (keepTitle) box.append(h('h1', {}, line.slice(2))); continue; }
    if (/^#{2,} /.test(line)) { ul = null; box.append(h('h3', {}, line.replace(/^#+ /, ''))); }
    else if (/^[-*] /.test(line)) { if (!ul) box.append(ul = h('ul')); ul.append(h('li', {}, inline(line.slice(2)))); }
    else if (line.trim()) { ul = null; box.append(h('p', {}, inline(line))); }
  }
  return box.children.length ? box : empty('agent.md is empty');
}
// Skill drill-in: which skill and file the drawer shows.
let skillView = null;
const showSkill = (id, file) => { skillView = { id, file }; openDrawer('skills', true); };
const fileSize = (n) => n < 1024 ? n + ' B' : (n / 1024).toFixed(1) + ' KB';
const skillDescription = (skill) => {
  const text = skill.files.find((f) => f.path === 'SKILL.md')?.text ?? '';
  const match = text.split(NEWLINE).find((line) => line.startsWith('description:'));
  return match ? match.slice('description:'.length).trim() : '';
};
function skillDetail(v) {
  const skill = v.data.skillDetails.find((s) => s.id === skillView.id);
  if (!skill) { skillView = null; return SECTIONS.skills(v); }
  const file = skill.files.find((f) => f.path === skillView.file) ?? skill.files[0];
  const enabled = Object.entries(skill.capabilities).filter(([, value]) => value !== false && value !== 'false');
  const viewer = !file ? empty('No files in this package')
    : file.text === null ? empty('Binary or large file · ' + fileSize(file.size))
    : file.path.toLowerCase().endsWith(".md") ? markdown(file.text, true)
    : h('pre', { class: 'code' }, h('code', {}, file.text));
  return { kicker: 'skill · v' + skill.version, title: skill.id, body: [
    h('button', { class: 'back', type: 'button', onclick: () => { skillView = null; openDrawer('skills', true); } }, icon('angle-small-left'), 'all skills'),
    h('div', { class: 'tags' }, enabled.length ? enabled.map(([key, value]) => h('span', {}, value === true ? key : key + ': ' + value)) : h('span', {}, 'no extra capabilities')),
    h('div', { class: 'files' }, skill.files.map((f) => h('button', { type: 'button', 'aria-pressed': String(f === file), onclick: () => showSkill(skill.id, f.path) },
      icon(f.path.toLowerCase().endsWith(".md") ? 'document' : f.text === null ? 'picture' : 'file-code'), h('span', {}, f.path), h('small', {}, fileSize(f.size))))),
    h('div', { class: 'viewer' }, viewer),
    h('div', { class: 'note' }, 'approved ' + when(skill.approvedAt))] };
}
// ---------- activity insights: hand-drawn SVG charts ----------
// Charts use DOM nodes and text only. The selected window is a module variable,
// so it survives the 60-second refresh.
const INSIGHT_WINDOWS = ['24h', '7d', '30d'];
let insightWindow = '24h', chartsEnter = false;
const SVG_NS = 'http://www.w3.org/2000/svg';
const sv = (tag, attrs = {}, ...kids) => {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
  return el;
};
const svgTip = (text) => sv('title', {}, text);
const compact = (n) => n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(Math.round(n));
const duration = (s) => s < 60 ? Math.round(s) + 's' : s < 3600 ? (s / 60).toFixed(1) + 'm' : (s / 3600).toFixed(1) + 'h';
const usd = (n) => '$' + (n > 0 && n < 0.01 ? n.toFixed(4) : n.toFixed(2));
const bucketLabel = (iso, bucket) => bucket === 'hour' ? iso.slice(11, 16) : iso.slice(5, 10);
const causeLabel = (cause) => cause.replace('runtime_failure:', 'runtime ').replace('turn_failed:', 'turn ').replaceAll('_', ' ');
const noData = (text = 'no data yet') => h('div', { class: 'chart-empty' }, text);
const legend = (rows) => h('div', { class: 'legend' }, rows.map(([color, label, value]) => h('span', {}, h('i', { style: 'background:' + color + ';color:' + color }), label, h('b', {}, value))));
const chartCard = (key, title, sub, body, wide = false) => h('section', { class: 'chart' + (wide ? ' wide' : ''), 'data-chart': key, 'aria-label': title },
  h('div', { class: 'chart-head' }, h('span', {}, title), sub ? h('small', {}, sub) : null), body);
// A ring split into glowing arcs. Round caps eat into each arc, so arcs are
// shortened by the cap width plus a small visible gap.
function ringChart(parts, center, label) {
  const R = 30, C = 2 * Math.PI * R, total = parts.reduce((sum, p) => sum + p.value, 0), live = parts.filter((p) => p.value > 0);
  const svg = sv('svg', { viewBox: '0 0 80 80', class: 'ring-chart', role: 'img', 'aria-label': label }, sv('circle', { cx: 40, cy: 40, r: R, class: 'track' }));
  const gap = live.length > 1 ? 9 : 0;
  let at = 0;
  for (const p of live) {
    const len = (p.value / total) * C;
    svg.append(sv('circle', { cx: 40, cy: 40, r: R, class: 'arc', style: 'color:' + p.color + (gap ? '' : ';stroke-linecap:butt'), transform: 'rotate(-90 40 40)',
      'stroke-dasharray': Math.max(0.01, len - gap).toFixed(2) + ' ' + C.toFixed(2), 'stroke-dashoffset': (-(at + gap / 2)).toFixed(2) }, svgTip(p.tip)));
    at += len;
  }
  svg.append(sv('text', { x: 40, y: 41, class: 'ring-value' }, center));
  return svg;
}
// Stacked bars, one per bucket, scaled to the busiest bucket.
function stackedBars(series, keys, bucket, format, label) {
  const W = 300, TOP = 12, BASE = 78, n = series.length, slot = W / n, bw = Math.min(18, Math.max(2, slot * 0.62));
  const peak = Math.max(1, ...series.map((row) => keys.reduce((sum, k) => sum + row[k.key], 0)));
  const svg = sv('svg', { viewBox: '0 0 300 94', class: 'bars-chart', role: 'img', 'aria-label': label },
    sv('line', { x1: 0, x2: W, y1: TOP, y2: TOP, class: 'grid' }),
    sv('line', { x1: 0, x2: W, y1: BASE + 0.5, y2: BASE + 0.5, class: 'axis' }),
    sv('text', { x: 0, y: TOP - 4, class: 'tick' }, 'peak ' + format(peak)));
  series.forEach((row, i) => {
    const g = sv('g', { class: 'bar' }, svgTip(bucketLabel(row.start, bucket) + ' UTC · ' + keys.map((k) => k.label + ' ' + format(row[k.key])).join(' · ')),
      sv('rect', { x: (i * slot).toFixed(2), y: TOP, width: slot.toFixed(2), height: BASE - TOP, class: 'hit' }));
    let y = BASE;
    for (const k of keys) {
      const height = (row[k.key] / peak) * (BASE - TOP);
      if (height <= 0) continue;
      y -= height;
      g.append(sv('rect', { x: (i * slot + (slot - bw) / 2).toFixed(2), y: y.toFixed(2), width: bw.toFixed(2), height: Math.max(0.8, height).toFixed(2), rx: Math.min(2, bw / 2).toFixed(2), class: 'fill', style: 'color:' + k.color }));
    }
    svg.append(g);
  });
  svg.append(sv('text', { x: 0, y: 91, class: 'tick' }, bucketLabel(series[0].start, bucket) + ' UTC'), sv('text', { x: W, y: 91, class: 'tick end' }, bucketLabel(series[n - 1].start, bucket)));
  return svg;
}
// Horizontal bars with a label and count per row.
const HBAR_LIMIT = 6;
function hbars(rows, color, label) {
  const peak = Math.max(1, ...rows.map((r) => r.value));
  const list = h('div', { class: 'hbars', role: 'list', 'aria-label': label }, rows.slice(0, HBAR_LIMIT).map((r) => h('div', { class: 'hrow', role: 'listitem', title: r.label + ': ' + r.value },
    h('span', {}, r.label),
    sv('svg', { class: 'hbar', 'aria-hidden': 'true' }, sv('line', { x1: 3, x2: '98%', y1: 5, y2: 5, class: 'track' }), sv('line', { x1: 3, x2: (2 + (r.value / peak) * 96).toFixed(1) + '%', y1: 5, y2: 5, class: 'arc', style: 'color:' + color })),
    h('b', {}, r.value))));
  if (rows.length > HBAR_LIMIT) list.append(h('div', { class: 'note' }, '+' + (rows.length - HBAR_LIMIT) + ' more'));
  return list;
}
function insightCharts(w) {
  const per = w.bucket === 'hour' ? 'per hour' : 'per day';
  const tk = w.tokens.totals, tokenSum = tk.input + tk.cached + tk.output;
  const tokenKeys = [{ key: 'input', label: 'input', color: 'var(--sky)' }, { key: 'cached', label: 'cached', color: 'var(--violet)' }, { key: 'output', label: 'output', color: 'var(--mint)' }];
  const ct = w.conversationTypes, convTotal = ct.chat + ct.oneTime + ct.recurring;
  const conv = [['var(--sky)', 'chat', ct.chat], ['var(--amber)', 'one-time', ct.oneTime], ['var(--violet)', 'recurring', ct.recurring]];
  const tr = w.taskRuns, runTotal = tr.completed + tr.failed;
  const runs = [['var(--mint)', 'completed', tr.completed], ['var(--coral)', 'failed', tr.failed]];
  const volumeKeys = [{ key: 'owner', label: 'owner', color: 'var(--sky)' }, { key: 'agent', label: 'agent', color: 'var(--mint)' }];
  const owner = w.volume.reduce((sum, b) => sum + b.owner, 0), agent = w.volume.reduce((sum, b) => sum + b.agent, 0);
  const rt = w.replyTime;
  const failureTotal = w.failures.reduce((sum, f) => sum + f.count, 0), skillTotal = w.skills.reduce((sum, s) => sum + s.count, 0);
  const ringParts = (rows) => rows.map(([color, label, value]) => ({ color, value, tip: label + ': ' + value }));
  return [
    chartCard('tokens', 'Token usage', tokenSum ? compact(tokenSum) + ' · ' + per : per, tokenSum ? [
      stackedBars(w.tokens.series, tokenKeys, w.bucket, compact, 'Token usage ' + per),
      legend(tokenKeys.map((k) => [k.color, k.label, compact(tk[k.key])])),
      h('div', { class: 'chart-foot' }, compact(tokenSum) + ' tokens · ' + tk.turns + (tk.turns === 1 ? ' turn' : ' turns') + (tk.costUsd !== null ? ' · ' + usd(tk.costUsd) : ''))] : noData(), true),
    chartCard('conversation-types', 'Conversation types', convTotal ? compact(convTotal) + ' msgs' : '', convTotal
      ? h('div', { class: 'ring-row' }, ringChart(ringParts(conv), compact(convTotal), 'Conversation types'), legend(conv.map(([c, l, v]) => [c, l, compact(v)]))) : noData()),
    chartCard('task-runs', 'Task runs', runTotal ? runTotal + ' runs' : '', runTotal
      ? h('div', { class: 'ring-row' }, ringChart(ringParts(runs), compact(runTotal), 'Task runs'), legend(runs.map(([c, l, v]) => [c, l, compact(v)]))) : noData()),
    chartCard('volume', 'Message volume', owner + agent ? compact(owner + agent) + ' · ' + per : per, owner + agent ? [
      stackedBars(w.volume, volumeKeys, w.bucket, compact, 'Message volume ' + per),
      legend([['var(--sky)', 'owner', compact(owner)], ['var(--mint)', 'agent', compact(agent)]])] : noData(), true),
    chartCard('reply-time', 'Reply time', rt.count ? rt.count + (rt.count === 1 ? ' reply' : ' replies') : '', rt.count && rt.medianSeconds !== null && rt.p90Seconds !== null
      ? h('div', { class: 'ring-row' },
        ringChart([{ color: 'var(--mint)', value: rt.medianSeconds, tip: 'median ' + duration(rt.medianSeconds) }, { color: 'var(--amber)', value: Math.max(0, rt.p90Seconds - rt.medianSeconds), tip: 'p90 ' + duration(rt.p90Seconds) }], duration(rt.medianSeconds), 'Reply time'),
        legend([['var(--mint)', 'median', duration(rt.medianSeconds)], ['var(--amber)', 'p90', duration(rt.p90Seconds)]]))
      : noData('no replies yet'), true),
    chartCard('failures', 'Failures by cause', failureTotal ? String(failureTotal) : '', w.failures.length
      ? hbars(w.failures.map((f) => ({ label: causeLabel(f.cause), value: f.count })), 'var(--coral)', 'Failures by cause') : noData(), true),
    chartCard('skills', 'Skill calls', skillTotal ? String(skillTotal) : '', w.skills.length
      ? hbars(w.skills.map((s) => ({ label: s.skill, value: s.count })), 'var(--pink)', 'Skill calls') : noData(), true),
  ];
}
const SECTIONS = {
  profile: (v) => ({ kicker: 'agent', title: v.data.profile.agentInstanceId, body: [
    h('dl', { class: 'kv' },
      h('dt', {}, 'Status'), h('dd', {}, pill(v.data.profile.status)),
      h('dt', {}, 'Provider'), h('dd', {}, v.data.profile.provider),
      h('dt', {}, 'Transport'), h('dd', {}, v.data.profile.transport),
      h('dt', {}, 'Workspaces'), h('dd', {}, v.data.profile.workspaceIds.join(', ') || '—'),
      h('dt', {}, 'Storage'), h('dd', {}, 'SQLite · read-only')),
    markdown(v.data.agentMarkdown)] }),
  health: (v) => ({ kicker: 'last 24 hours', title: v.healthPct === null ? 'No heartbeats yet' : v.healthPct + '% healthy', body: [
    h('div', { class: 'hours' }, [...v.hours].reverse().map((x) => h('div', { class: 'hour', title: x.state, style: 'color:' + STATE_CSS[x.state] }, h('i'), h('span', {}, clock(x.start))))),
    ...(() => {
      const anomalies = v.hours.flatMap((x) => x.events).filter((x) => x.state !== 'healthy').reverse();
      return [h('div', { class: 'list-head', style: 'margin-top:16px' }, 'Anomaly event log · ' + anomalies.length),
        anomalies.length ? h('div', { class: 'list' }, anomalies.map((x) =>
          h('div', { class: 'item' }, h('div', { class: 'meta' }, pill(x.state), h('span', { class: 'when' }, when(x.createdAt))), h('p', {}, describe(x.detail)))))
          : empty('No anomalies in the last 24 hours')];
    })()] }),
  activity: (v) => {
    // The window switch redraws only the charts, so scroll position stays put.
    const box = h('div', { class: 'charts' + (chartsEnter ? ' enter' : '') });
    chartsEnter = false;
    const draw = () => { const w = v.data.insights?.[insightWindow]; box.replaceChildren(...(w ? insightCharts(w) : [empty('Charts need a newer UI server')])); };
    draw();
    const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Chart window' }, INSIGHT_WINDOWS.map((key) => h('button', { type: 'button', 'data-window': key, 'aria-pressed': String(key === insightWindow), onclick: (e) => {
      insightWindow = key; seg.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b === e.currentTarget))); box.classList.add('enter'); draw();
    } }, key)));
    return { kicker: 'activity', title: v.m.messages24h + ' messages today', body: [
      h('div', { class: 'stats' }, [[v.m.messages24h, 'last 24h'], [v.m.messages30d, 'last 30 days'], [v.m.activeSessions, 'active sessions'], [v.m.messagesPerSession, 'msgs / session · 24h']].map(([value, label]) => h('div', { class: 'stat' }, h('b', {}, value), h('span', {}, label)))),
      h('div', { class: 'chart-bar' }, h('div', { class: 'list-head' }, 'insights'), seg),
      box,
      h('div', { class: 'note' }, 'Chart buckets are UTC and end with the current hour or day. The tiles above roll from now.')] };
  },
  failures: (v) => ({ kicker: 'failed replies', title: v.m.failedReplies24h + ' today · ' + v.m.failedReplies30d + ' in 30d', body: [
    (() => { const rows = v.data.messages.filter((x) => x.direction === 'agent' && x.state === 'failed').map(messageItem); return rows.length ? h('div', { class: 'list' }, rows) : empty('No failed replies'); })()] }),
  tasks: (v) => taskView.mode === 'form' ? taskForm(v) : taskView.mode === 'detail' ? taskDetail(v) : taskList(v),
  conversations: (v) => ({ kicker: 'messages', title: 'Conversations', body: [searchable({
    state: searchState.conversations, items: v.data.messages, noun: 'messages', options: ['all', 'completed', 'failed', 'processing'], key: (x) => x.state,
    text: (x) => [x.body, '#' + x.id, x.workspaceId, x.direction === 'agent' ? 'agent' : 'owner'].join(' '), render: messageItem, placeholder: 'Search text, #id or workspace' })] }),
  memory: (v) => ({ kicker: 'memory', title: v.data.memories.length + ' memories', body: [searchable({
    state: searchState.memory, items: v.data.memories, noun: 'memories', options: ['all', 'reviewed', 'in review', 'not reviewed'], key: reviewKey,
    text: (x) => [x.body, '#' + x.id, x.origin, x.review?.recap ?? ''].join(' '), render: memoryItem, placeholder: 'Search memory, #id or recap' })] }),
  skills: (v) => skillView ? skillDetail(v) : ({ kicker: 'enabled locally', title: v.data.skills.length + ' skills', body: [
    v.data.skillDetails.length ? h('div', { class: 'list' }, v.data.skillDetails.map((s) => h('button', { class: 'item', type: 'button', onclick: () => showSkill(s.id, 'SKILL.md') },
      h('div', { class: 'meta' }, 'v' + s.version, h('span', {}, s.files.length + (s.files.length === 1 ? ' file' : ' files')), h('span', { class: 'when' }, icon('angle-small-right'))),
      h('p', {}, h('b', {}, s.id)), skillDescription(s) ? h('p', { style: 'color:var(--muted);font-size:12px' }, skillDescription(s)) : null)))
      : v.data.skills.length ? h('div', { class: 'tags' }, v.data.skills.map((s) => h('span', {}, s))) : empty('No skills enabled'),
    v.data.tools.length ? h('div', { class: 'tags', style: 'margin-top:12px' }, v.data.tools.map((s) => h('span', {}, s))) : null] }),
  settings: () => ({ kicker: 'settings', title: 'Appearance', body: [
    h('div', { class: 'setting' },
      h('div', { class: 'setting-head' }, h('span', {}, 'Robot style'), h('small', {}, robotStyle(robotStyleId).name)),
      h('div', { class: 'styles' }, ROBOT_STYLES.map((style) => h('button', { type: 'button', class: 'style-btn', title: style.name, 'aria-label': style.name, 'aria-pressed': String(style.id === robotStyleId), onclick: () => setRobotStyle(style.id) }, robotPreview(style))))),
    h('div', { class: 'setting', style: 'margin-top:12px' },
      h('div', { class: 'setting-head' }, h('span', {}, 'Accessory'), h('small', {}, robotAccessory(robotAccessoryId).name)),
      h('div', { class: 'styles' }, ROBOT_ACCESSORIES.map((item) => h('button', { type: 'button', class: 'style-btn', title: item.name, 'aria-label': item.name, 'aria-pressed': String(item.id === robotAccessoryId), onclick: () => setRobotAccessory(item.id) }, robotPreview(robotStyle(robotStyleId), item.id))))),
    h('div', { class: 'setting', style: 'margin-top:12px' },
      h('div', { class: 'setting-head' }, h('span', {}, 'Body colour'), h('small', {}, 'saved in this browser')),
      h('div', { class: 'swatches' }, ROBOT_COLORS.map(([name, hex]) => h('button', { type: 'button', class: 'swatch', title: name, 'aria-label': name, 'aria-pressed': String(hex === robotColor), style: 'background:' + hex + ';color:' + hex, onclick: () => setRobotColor(hex) }))),
      h('div', { class: 'custom' },
        h('label', { for: 'robot-color' }, 'Custom'),
        h('input', { id: 'robot-color', type: 'color', value: robotColor, oninput: (e) => setRobotColor(e.currentTarget.value, false), onchange: (e) => setRobotColor(e.currentTarget.value) }),
        h('code', {}, robotColor),
        h('button', { type: 'button', class: 'back', style: 'padding:0;margin-left:auto', onclick: () => setRobotColor(ROBOT_COLORS[0][1]) }, icon('rotate-left'), 'reset'))),
    h('div', { class: 'setting', style: 'margin-top:12px' },
      h('div', { class: 'setting-head' }, h('span', {}, 'Accent colour'), h('small', {}, robotAccent)),
      h('div', { class: 'swatches' },
        h('button', { type: 'button', class: 'swatch', title: 'auto', 'aria-label': 'auto accent', 'aria-pressed': String(robotAccent === 'auto'), style: 'color:' + robotColor + ';background:linear-gradient(135deg,' + robotColor + ' 50%,color-mix(in srgb, ' + robotColor + ' 60%, #000) 50%)', onclick: () => setRobotAccent('auto') }),
        ROBOT_ACCENTS.map(([name, hex]) => h('button', { type: 'button', class: 'swatch', title: name, 'aria-label': name + ' accent', 'aria-pressed': String(hex === robotAccent), style: 'background:' + hex + ';color:' + hex, onclick: () => setRobotAccent(hex) })))),
    h('div', { class: 'setting', style: 'margin-top:12px' },
      h('div', { class: 'setting-head' }, h('span', {}, 'Finish')),
      h('div', { class: 'seg' }, ROBOT_FINISHES.map((finish) => h('button', { type: 'button', 'aria-pressed': String(finish === robotFinish), onclick: () => setRobotFinish(finish) }, finish))))] }),
};

// Robot colour: a per-agent browser preference. Storage can be unavailable, so
// every read and write is guarded and the default always works.
const ROBOT_COLORS = [['clay', '#c8664a'], ['mint', '#59e3b1'], ['sky', '#7cc4ff'], ['violet', '#a78bfa'], ['pink', '#f0a6ca'], ['amber', '#f2c66d'], ['steel', '#9aa8bd']];
const robotColorKey = () => 'inoai.robotColor.' + view.data.profile.agentInstanceId;
const readRobotColor = () => { try { const stored = localStorage.getItem(robotColorKey()); if (/^#[0-9a-f]{6}$/i.test(stored ?? '')) return stored; } catch { /* storage unavailable */ } return ROBOT_COLORS[0][1]; };
let robotColor = readRobotColor();
let paintRobot = () => {};
function setRobotColor(hex, rerender = true) {
  robotColor = hex.toLowerCase();
  try { localStorage.setItem(robotColorKey(), robotColor); } catch { /* storage unavailable */ }
  paintRobot(robotColor);
  if (rerender) openDrawer('settings', true); else document.querySelector('.custom code')?.replaceChildren(robotColor);
}

// Robot styles: pixel maps drawn as voxels. H body, D darker body, E eye
// (blinks), M mouth, G status glow, a status light, s stem, A arm (swings),
// L leg. Rows in one map share a width.
const ROBOT_STYLES = [
  { id: 'classic', name: 'classic', rows: ['.....a.....', '.....s.....', '.HHHHHHHHH.', '.HHEHHHEHH.', '.HHEHHHEHH.', 'AHHHHHHHHHA', '.HHHHHHHHH.', '..LL...LL..'] },
  { id: 'visor', name: 'visor', rows: ['....a.a....', '....s.s....', '..HHHHHHH..', '..HGGGGGH..', '..HHHHHHH..', '.ADDDDDDDA.', '..DDDDDDD..', '..L.....L..'] },
  { id: 'round', name: 'round', rows: ['.....a.....', '...HHHHH...', '..HHHHHHH..', '.HHEEHEEHH.', '.HHEEHEEHH.', '.HHHMMMHHH.', '..HHHHHHH..', '...L...L...'] },
  { id: 'tank', name: 'tank', rows: ['.....a.....', '...HHHHH...', '...HEHEH...', '...HHHHH...', '.AHHHHHHHA.', '.DDDDDDDDD.', 'DLDLDLDLDLD'] },
  { id: 'slim', name: 'slim', rows: ['....a....', '....s....', '..HHHHH..', '..HEHEH..', '..HHHHH..', '...HHH...', '.AHHHHHA.', '..HHHHH..', '..L...L..'] },
  { id: 'crab', name: 'crab', rows: ['.A.......A.', '.AA.....AA.', '..HHHHHHH..', '.HHEHHHEHH.', 'HHHHHHHHHHH', '.HHHHHHHHH.', '.L.L...L.L.'] },
  { id: 'cyclops', name: 'cyclops', rows: ['.....a.....', '.....s.....', '..HHHHHHH..', '..HHEEEHH..', '..HHEEEHH..', '..HHHHHHH..', '.AHDDDDDHA.', '...L...L...'] },
  { id: 'ghost', name: 'ghost', rows: ['...HHHHH...', '..HHHHHHH..', '.HHEHHHEHH.', '.HHEHHHEHH.', '.HHHHHHHHH.', 'AHHHMMMHHHA', '.HHHHHHHHH.', '.H.H.H.H.H.'] },
  { id: 'cat', name: 'cat', rows: ['.H.......H.', '.HH.....HH.', '.HHHHHHHHH.', '.HHEHHHEHH.', '.HHHHGHHHH.', '.HHHHHHHHH.', '..AHHHHHA..', '..L.....L..'] },
  { id: 'tv', name: 'retro tv', rows: ['...a...a...', '...s...s...', '.HHHHHHHHH.', '.HGGGGGGGH.', '.HGEGGGEGH.', '.HGGGGGGGH.', '.HHHHHHHHH.', '..L.....L..'] },
  { id: 'owl', name: 'owl', rows: ['.H.......H.', '.HHHHHHHHH.', '.HEEHHHEEH.', '.HEEHHHEEH.', '.HHHHGHHHH.', 'AHHHHHHHHHA', '.HHHHHHHHH.', '..L.....L..'] },
  { id: 'frog', name: 'frog', rows: ['.EE.....EE.', '.HHH...HHH.', '.HHHHHHHHH.', '.HMMMMMMMH.', '.HHHHHHHHH.', 'AHHHHHHHHHA', '.LL.....LL.'] },
  { id: 'knight', name: 'knight', rows: ['....DDD....', '....DDD....', '..HHHHHHH..', '..HEEEEEH..', '..HHHHHHH..', '.AHDDDDDHA.', '..DDDDDDD..', '..L.....L..'] },
  { id: 'bunny', name: 'bunny', rows: ['..H.....H..', '..H.....H..', '..H.....H..', '.HHHHHHHHH.', '.HHEHHHEHH.', '.HHHHGHHHH.', '.HHHHHHHHH.', '..AHHHHHA..', '..L.....L..'] },
  { id: 'alien', name: 'alien', rows: ['..a.....a..', '...s...s...', '..HHHHHHH..', '.HHHHHHHHH.', '.HEEHHHEEH.', '.HEEHHHEEH.', '..HHHMHHH..', '...AHHHA...', '....L.L....'] },
  { id: 'drone', name: 'drone', rows: ['DDDD...DDDD', '..s.....s..', '..HHHHHHH..', '.HHEHHHEHH.', '.HHHHGHHHH.', '...DDDDD...', '....L.L....'] },
  { id: 'pirate', name: 'pirate', rows: ['..DDDDDDD..', '.DDDDDDDDD.', '.HHHHHHHHH.', '.HDDHHHEHH.', '.HHHHHHHHH.', '.HHMMMMMHH.', 'AHHHHHHHHHA', '..L.....L..'] },
  { id: 'snowman', name: 'snowman', rows: ['....DDD....', '...DDDDD...', '...HEHEH...', '...HHHHH...', '..AHHHHHA..', '..HHHGHHH..', '..HHHHHHH..', '...L...L...'] },
  { id: 'spider', name: 'spider', rows: ['....a.a....', '..HHHHHHH..', '.HHEHEHEHH.', 'LHHHHHHHHHL', '.LHHHHHHHL.', 'L.L.....L.L'] },
  { id: 'chibi', name: 'chibi', rows: ['....a....', '..HHHHH..', '.HHHHHHH.', '.HEHHHEH.', '.HHHMHHH.', '..AHHHA..', '..L...L..'] },
];
const robotStyle = (id) => ROBOT_STYLES.find((style) => style.id === id) ?? ROBOT_STYLES[0];
const robotStyleKey = () => 'inoai.robotStyle.' + view.data.profile.agentInstanceId;
const readRobotStyle = () => { try { return robotStyle(localStorage.getItem(robotStyleKey())).id; } catch { /* storage unavailable */ } return ROBOT_STYLES[0].id; };
let robotStyleId = readRobotStyle();
let shapeRobot = () => {};
function setRobotStyle(id) {
  robotStyleId = robotStyle(id).id;
  try { localStorage.setItem(robotStyleKey(), robotStyleId); } catch { /* storage unavailable */ }
  shapeRobot(robotStyleId);
  openDrawer('settings', true);
}
function robotPreview(style, accessoryId = robotAccessoryId) {
  const light = STATE_CSS[view.data.profile.status] ?? 'var(--slate)';
  const accent = robotAccent === 'auto' ? 'color-mix(in srgb, ' + robotColor + ' 60%, #000)' : robotAccent;
  const fill = { H: robotColor, s: robotColor, A: robotColor, L: robotColor, D: accent, E: '#050608', M: '#050608', G: light, a: light, ...ACCESSORY_COLORS };
  const rows = robotGrid(style, accessoryId).rows;
  return h('span', { class: 'mini', style: 'grid-template-columns:repeat(' + rows[0].length + ',1fr)', 'aria-hidden': 'true' },
    rows.flatMap((row) => [...row].map((ch) => h('i', { style: fill[ch] ? 'background:' + fill[ch] : '' }))));
}

// Accessories: pixel overlays stamped onto a style. 'top' sits on the head and
// replaces its antenna, 'float' hovers above the robot, and 'face' and 'chest'
// sit in front of the body. Accessory letters are fixed colours.
const ACCESSORY_COLORS = { Y: '#f2c66d', K: '#3d4658', W: '#e7edf4', R: '#f47d79', B: '#7cc4ff', P: '#f0a6ca', V: '#a78bfa', N: '#59e3b1' };
const ROBOT_ACCESSORIES = [
  { id: 'none', name: 'none', anchor: 'top', rows: [] },
  { id: 'crown', name: 'crown', anchor: 'top', rows: ['Y.Y.Y', 'YYYYY'] },
  { id: 'party', name: 'party hat', anchor: 'top', rows: ['..Y..', '..P..', '.PVP.', 'PVPVP'] },
  { id: 'tophat', name: 'top hat', anchor: 'top', rows: ['.KKK.', '.KKK.', '.RRR.', 'KKKKK'] },
  { id: 'cap', name: 'cap', anchor: 'top', rows: ['.BBB...', 'BBBBBBB'] },
  { id: 'beanie', name: 'beanie', anchor: 'top', rows: ['..R..', '.WWW.', 'WWWWW'] },
  { id: 'flower', name: 'flower', anchor: 'top', rows: ['.P.', 'PYP', '.P.', '.N.'] },
  { id: 'halo', name: 'halo', anchor: 'float', rows: ['.YYYYY.', 'Y.....Y', '.YYYYY.'] },
  { id: 'shades', name: 'shades', anchor: 'face', rows: ['KKKKKKK'] },
  { id: 'bowtie', name: 'bow tie', anchor: 'chest', rows: ['R.R', 'RRR', 'R.R'] },
];
const robotAccessory = (id) => ROBOT_ACCESSORIES.find((item) => item.id === id) ?? ROBOT_ACCESSORIES[0];
// The style's rows with the accessory stamped in. 'under' keeps the body letter
// beneath each face or chest overlay cell, so the scene can layer the two.
function robotGrid(style, accessoryId) {
  const item = robotAccessory(accessoryId), width = style.rows[0].length;
  const blank = () => Array(width).fill('.');
  let rows = style.rows.map((row) => [...row]);
  let headTop = rows.findIndex((row) => row.some((ch) => 'HDEGM'.includes(ch)));
  if (item.anchor === 'top' && item.rows.length) {
    rows = rows.map((row, y) => (y < headTop ? row.map((ch) => (ch === 'a' || ch === 's' ? '.' : ch)) : row));
    const missing = item.rows.length - headTop;
    if (missing > 0) { rows = [...Array.from({ length: missing }, blank), ...rows]; headTop += missing; }
  }
  if (item.anchor === 'float') { rows = [...Array.from({ length: item.rows.length + 1 }, blank), ...rows]; headTop += item.rows.length + 1; }
  const under = rows.map(blank);
  const stamp = (top, overlay) => item.rows.forEach((line, j) => [...line].forEach((ch, i) => {
    const x = Math.floor((width - line.length) / 2) + i, y = top + j;
    if (ch === '.' || x < 0 || x >= width || y < 0 || y >= rows.length) return;
    if (overlay) under[y][x] = rows[y][x];
    rows[y][x] = ch;
  }));
  if (item.anchor === 'top') stamp(headTop - item.rows.length, false);
  else if (item.anchor === 'float') stamp(0, false);
  else if (item.anchor === 'face') { const eyeRow = rows.findIndex((row) => row.includes('E')); stamp(eyeRow >= 0 ? eyeRow : headTop + 1, true); }
  else {
    const lastBody = rows.length - 1 - [...rows].reverse().findIndex((row) => row.some((ch) => ch === 'H' || ch === 'D'));
    stamp(Math.max(headTop + 1, lastBody - item.rows.length + 1), true);
  }
  while (rows.length > 1 && rows[0].every((ch) => ch === '.')) { rows.shift(); under.shift(); }
  return { rows: rows.map((row) => row.join('')), under };
}

// Accessory, accent colour, and finish: per-agent browser preferences.
const prefKey = (name) => 'inoai.' + name + '.' + view.data.profile.agentInstanceId;
const readPref = (name, valid, fallback) => { try { const value = localStorage.getItem(prefKey(name)); if (value !== null && valid(value)) return value; } catch { /* storage unavailable */ } return fallback; };
const writePref = (name, value) => { try { localStorage.setItem(prefKey(name), value); } catch { /* storage unavailable */ } };
const ROBOT_ACCENTS = [['ink', '#1c2433'], ['white', '#e7edf4'], ...ROBOT_COLORS];
const ROBOT_FINISHES = ['matte', 'shiny', 'glow', 'wire'];
let robotAccessoryId = readPref('robotAccessory', (value) => ROBOT_ACCESSORIES.some((item) => item.id === value), 'none');
let robotAccent = readPref('robotAccent', (value) => value === 'auto' || /^#[0-9a-f]{6}$/i.test(value), 'auto');
let robotFinish = readPref('robotFinish', (value) => ROBOT_FINISHES.includes(value), 'matte');
function setRobotAccessory(id) { robotAccessoryId = robotAccessory(id).id; writePref('robotAccessory', robotAccessoryId); shapeRobot(robotStyleId); openDrawer('settings', true); }
function setRobotAccent(value) { robotAccent = value; writePref('robotAccent', value); paintRobot(robotColor); openDrawer('settings', true); }
function setRobotFinish(value) { robotFinish = value; writePref('robotFinish', value); paintRobot(robotColor); openDrawer('settings', true); }
const drawer = document.getElementById('drawer'), rail = document.getElementById('d-rail');
let openSection = null, drawerShiftPx = 0;
Object.keys(SECTIONS).forEach((key) => rail.append(h('button', { type: 'button', 'aria-label': key, title: key, style: 'color:' + CSS[key], onclick: () => openDrawer(key) }, icon(key))));
function openDrawer(key, keepSkill = false) {
  if (!keepSkill) { skillView = null; taskView = { mode: 'list' }; }
  // Charts animate on a fresh open, not on the 60-second refresh.
  chartsEnter = !keepSkill;
  const s = SECTIONS[key](view);
  openSection = key;
  const ico = document.getElementById('d-ico');
  ico.style.color = CSS[key]; ico.replaceChildren(icon(key));
  document.getElementById('d-kicker').textContent = s.kicker;
  document.getElementById('d-title').textContent = s.title;
  document.getElementById('d-body').replaceChildren(...s.body.filter(Boolean));
  document.getElementById('d-body').scrollTop = 0;
  rail.querySelectorAll('button').forEach((b) => b.setAttribute('aria-current', String(b.title === key)));
  drawer.classList.add('open'); drawer.setAttribute('aria-hidden', 'false');
  drawerShiftPx = innerWidth > 900 ? drawer.offsetWidth / 2 : 0;
  document.getElementById('hint').style.opacity = 0;
}
function closeDrawer() { openSection = null; drawer.classList.remove('open'); drawer.setAttribute('aria-hidden', 'true'); drawerShiftPx = 0; }
document.getElementById('d-close').addEventListener('click', closeDrawer);
addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });
document.querySelector('.chip').addEventListener('click', (e) => { if (e.target.id !== 'refresh') openDrawer('profile'); });

function renderStatus() {
  const p = view.data.profile, dot = document.getElementById('status-dot');
  dot.className = 'dot ' + p.status;
  document.getElementById('status-text').textContent = view.data.unavailable ? 'data unavailable' : [p.status, p.provider, p.transport].join(' · ');
  document.title = 'inoai · ' + view.name;
}
renderStatus();

// ---------- refresh ----------
const refreshButton = document.getElementById('refresh');
refreshButton.addEventListener('click', () => refreshButton.setAttribute('aria-pressed', String(refreshButton.getAttribute('aria-pressed') !== 'true')));
const listeners = [];
setInterval(async () => {
  if (refreshButton.getAttribute('aria-pressed') !== 'true' || document.hidden) return;
  view = derive(await loadData());
  renderStatus();
  listeners.forEach((fn) => fn(view));
  // Re-render an open drawer, but never while someone is typing in it or has the task form open.
  if (openSection && !(openSection === 'tasks' && taskView.mode === 'form') && !drawer.contains(document.activeElement?.matches('input') ? document.activeElement : null)) { const scroll = document.getElementById('d-body').scrollTop; openDrawer(openSection, true); document.getElementById('d-body').scrollTop = scroll; }
}, 60_000);

// ---------- three.js ring scene ----------
let THREE, EffectComposer, RenderPass, UnrealBloomPass, OutputPass;
try {
  THREE = await import('three');
  ({ EffectComposer } = await import('three/addons/postprocessing/EffectComposer.js'));
  ({ RenderPass } = await import('three/addons/postprocessing/RenderPass.js'));
  ({ UnrealBloomPass } = await import('three/addons/postprocessing/UnrealBloomPass.js'));
  ({ OutputPass } = await import('three/addons/postprocessing/OutputPass.js'));
} catch {
  document.getElementById('fallback').style.display = 'grid';
  document.getElementById('hint').hidden = true;
}
if (THREE) startScene();

function startScene() {
  const COLORS = { mint: 0x59e3b1, amber: 0xf2c66d, coral: 0xf47d79, sky: 0x7cc4ff, violet: 0xa78bfa, pink: 0xf0a6ca, slate: 0x2e3d56 };
  const STATE_COLOR = { healthy: COLORS.mint, degraded: COLORS.amber, restarted: COLORS.coral, blocked: COLORS.coral, unknown: COLORS.slate };
  const STATUS_COLOR = { running: COLORS.mint, stopped: COLORS.coral, unknown: COLORS.slate };
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const stage = document.getElementById('stage');
  let renderer;
  try { renderer = new THREE.WebGLRenderer({ antialias: true }); } catch { document.getElementById('fallback').style.display = 'grid'; return; }
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  stage.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x060a13);
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 200);
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.55, 0.35, 0.18);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  const root = new THREE.Group(); scene.add(root);
  const core = new THREE.Group(); core.position.y = 0.9; root.add(core);
  const tilt = new THREE.Group(); core.add(tilt);
  const hits = [];
  const hitMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide });
  const basic = (color, opacity = 1) => new THREE.MeshBasicMaterial({ color, transparent: opacity < 1, opacity });
  const placeCW = (mesh, start, angle) => { mesh.rotation.z = Math.PI / 2 - start - angle; };
  const torusArc = (r, tube, angle) => new THREE.TorusGeometry(r, tube, 12, Math.max(4, Math.ceil(angle * 48)), Math.max(0.001, angle));
  const arc = (r, tube, angle, color, opacity) => new THREE.Mesh(torusArc(r, tube, angle), basic(color, opacity));
  function setArc(mesh, r, tube, frac) { mesh.geometry.dispose(); const a = Math.max(0.001, frac * Math.PI * 2); mesh.geometry = torusArc(r, tube, a); placeCW(mesh, 0, a); }
  function hitBand(parent, inner, outer, start, angle, info) {
    const mesh = new THREE.Mesh(new THREE.RingGeometry(inner, outer, 24, 1, Math.PI / 2 - start - angle, angle), hitMat);
    mesh.userData = info; parent.add(mesh); hits.push(mesh); return mesh;
  }
  function ticks(r, count, len, color, opacity) {
    const points = [];
    for (let i = 0; i < count; i++) { const a = (i / count) * Math.PI * 2, l = i % 5 === 0 ? len * 2 : len; points.push(Math.cos(a) * r, Math.sin(a) * r, 0, Math.cos(a) * (r + l), Math.sin(a) * (r + l), 0); }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
    return new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity }));
  }

  const outerTicks = ticks(3.7, 120, 0.08, 0x3a5070, 0.55); tilt.add(outerTicks);

  // Health: 24 hourly segments, oldest to newest clockwise from the top.
  const step = (Math.PI * 2) / 24, gap = 0.04;
  const healthSegs = Array.from({ length: 24 }, (_, i) => {
    const seg = arc(3.3, 0.06, step - gap, COLORS.slate);
    placeCW(seg, i * step + gap / 2, step - gap); seg.scale.setScalar(0.001); tilt.add(seg);
    hitBand(tilt, 3.05, 3.6, i * step, step, { section: 'health', seg, tip: () => clock(view.hours[i].start) + ' · ' + view.hours[i].state });
    return seg;
  });

  tilt.add(arc(2.7, 0.03, Math.PI * 2, COLORS.sky, 0.12));
  const activityArc = arc(2.7, 0.06, 0.001, COLORS.sky); tilt.add(activityArc);
  const activityHead = new THREE.Mesh(new THREE.SphereGeometry(0.11, 16, 16), basic(0xd8efff)); tilt.add(activityHead);
  hitBand(tilt, 2.5, 2.9, 0, Math.PI * 2, { section: 'activity', tip: () => view.m.messages24h + ' messages · 24h' });

  tilt.add(arc(2.25, 0.025, Math.PI * 2, COLORS.coral, 0.1));
  const failureArc = arc(2.25, 0.055, 0.001, COLORS.coral); tilt.add(failureArc);
  const failureHead = new THREE.Mesh(new THREE.SphereGeometry(0.09, 16, 16), basic(0xffd0ce)); tilt.add(failureHead);
  hitBand(tilt, 2.05, 2.45, 0, Math.PI * 2, { section: 'failures', tip: () => view.m.failedReplies24h + ' failed replies · 24h' });

  tilt.add(arc(1.75, 0.008, Math.PI * 2, COLORS.pink, 0.25));
  const orbitGroup = new THREE.Group(); tilt.add(orbitGroup);
  hitBand(tilt, 1.55, 1.95, 0, Math.PI * 2, { section: 'skills', tip: () => view.data.skills.length + ' skills' });

  const statusRing = arc(1.3, 0.012, Math.PI * 2, COLORS.slate, 0.8); tilt.add(statusRing);

  // Pixel robot in the core, built from voxels in the selected style. Status
  // lights and glow cells share the antenna material, which shows status.
  // robotBody holds the voxels and turns on its own; robot anchors the labels.
  const robot = new THREE.Group(), robotBody = new THREE.Group(); robot.add(robotBody); tilt.add(robot);
  scene.add(new THREE.AmbientLight(0xffffff, 0.75));
  const sun = new THREE.DirectionalLight(0xffffff, 1.6); sun.position.set(-2, 3, 6); scene.add(sun);
  const bodyMat = new THREE.MeshPhongMaterial(), accentMat = new THREE.MeshPhongMaterial(), eyeMat = basic(0x050608), antennaMat = basic(COLORS.slate);
  const accessoryMats = {};
  const accessoryMat = (ch) => (accessoryMats[ch] ??= new THREE.MeshPhongMaterial({ color: ACCESSORY_COLORS[ch], shininess: 40 }));
  paintRobot = (hex) => {
    bodyMat.color.set(hex);
    if (robotAccent === 'auto') accentMat.color.set(hex).multiplyScalar(0.6); else accentMat.color.set(robotAccent);
    for (const mat of [bodyMat, accentMat]) {
      mat.wireframe = robotFinish === 'wire';
      mat.shininess = robotFinish === 'shiny' ? 40 : 0;
      mat.specular.setScalar(robotFinish === 'shiny' ? 0.18 : 0);
      mat.emissive.copy(mat.color).multiplyScalar(robotFinish === 'glow' ? 0.45 : 0);
    }
  };
  paintRobot(robotColor);
  let eyes = [], arms = [], antennas = [];
  shapeRobot = (id) => {
    robotBody.traverse((part) => part.geometry?.dispose());
    robotBody.clear();
    eyes = []; arms = []; antennas = [];
    const { rows, under } = robotGrid(robotStyle(id), robotAccessoryId), cols = rows[0].length;
    const cell = Math.min(0.13, 1.45 / cols, 1.05 / rows.length);
    const voxel = new THREE.BoxGeometry(cell * 0.96, cell * 0.96, cell * 1.6);
    const eyeVoxel = new THREE.BoxGeometry(cell * 0.9, cell * 0.96, cell * 0.5);
    const bulb = new THREE.SphereGeometry(cell * 0.6, 16, 16);
    const bodyFor = (ch) => (ch === 'D' ? accentMat : ch === 'G' ? antennaMat : bodyMat);
    rows.forEach((row, y) => [...row].forEach((ch, x) => {
      if (ch === '.') return;
      const at = (mesh, z = 0) => { mesh.position.set((x - (cols - 1) / 2) * cell, ((rows.length - 1) / 2 - y) * cell, z); robotBody.add(mesh); return mesh; };
      if (ch === 'a') { antennas.push(at(new THREE.Mesh(bulb, antennaMat))); return; }
      if (ACCESSORY_COLORS[ch]) {
        const below = under[y][x];
        if (below === '.') { at(new THREE.Mesh(voxel, accessoryMat(ch))); return; }
        at(new THREE.Mesh(voxel, bodyFor(below)));
        at(new THREE.Mesh(eyeVoxel, accessoryMat(ch)), cell * 0.95);
        return;
      }
      const body = at(new THREE.Mesh(voxel, bodyFor(ch)));
      if (ch === 'E' || ch === 'M') { const face = at(new THREE.Mesh(eyeVoxel, eyeMat), cell * 0.8); if (ch === 'E') eyes.push(face); }
      if (ch === 'A') { body.userData.baseY = body.position.y; arms.push(body); }
    }));
    Object.assign(robot.userData, { halfHeight: rows.length * cell / 2, halfWidth: cols * cell / 2, cell });
  };
  shapeRobot(robotStyleId);
  const coreHit = new THREE.Mesh(new THREE.CircleGeometry(1.3, 48), hitMat);
  coreHit.userData = { section: 'profile', tip: () => 'agent profile' }; tilt.add(coreHit); hits.push(coreHit);

  const satellites = [
    { key: 'tasks', x: -3.3, color: COLORS.amber, word: 'tasks', value: (v) => v.activeTasks.length, segmented: true,
      tip: (v) => v.activeTasks.length + ' active tasks · ' + v.activeTasks.filter((x) => x.taskType === 'recurring').length + ' recurring' },
    { key: 'memory', x: 0, color: COLORS.violet, word: 'memory', frac: (v) => v.reviewedFrac, value: (v) => v.data.memories.length },
    { key: 'skills', x: 3.3, color: COLORS.pink, word: 'skills', value: (v) => v.data.skills.length, segmented: true },
  ].map((sat) => {
    const group = new THREE.Group(); group.position.set(sat.x, -3.95, 0); root.add(group);
    group.add(arc(0.72, 0.02, Math.PI * 2, sat.color, 0.15));
    const spin = ticks(0.9, 36, 0.05, sat.color, 0.35); group.add(spin);
    const fill = sat.segmented ? new THREE.Group() : arc(0.72, 0.045, 0.001, sat.color); group.add(fill);
    const hit = new THREE.Mesh(new THREE.CircleGeometry(1.05, 32), hitMat);
    hit.userData = { section: sat.key, sat: group, tip: () => (sat.tip ? sat.tip(view) : sat.key) }; group.add(hit); hits.push(hit);
    return { ...sat, group, spin, fill };
  });

  {
    const n = 1200, pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { const r = 18 + Math.random() * 40, t = Math.random() * Math.PI * 2, p = Math.acos(2 * Math.random() - 1); pos.set([r * Math.sin(p) * Math.cos(t), r * Math.sin(p) * Math.sin(t), -Math.abs(r * Math.cos(p))], i * 3); }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    var stars = new THREE.Points(g, new THREE.PointsMaterial({ color: 0x6f86aa, size: 0.07, transparent: true, opacity: 0.6 })); scene.add(stars);
  }

  // Rebuild the parts whose shape depends on the data.
  let orbiters = [], orbitAngle = 0, lastFrameT = 0;
  function applyView(v) {
    v.hours.forEach((hour, i) => healthSegs[i].material.color.setHex(STATE_COLOR[hour.state]));
    statusRing.material.color.setHex(STATUS_COLOR[v.data.profile.status] ?? COLORS.slate);
    antennaMat.color.setHex(STATUS_COLOR[v.data.profile.status] ?? COLORS.slate);
    // One orbiting light per enabled skill; each is its own hover and click target.
    for (const old of orbiters) hits.splice(hits.indexOf(old), 1);
    orbitGroup.traverse((part) => part.geometry?.dispose());
    orbitGroup.clear();
    const skillIds = v.data.skills.slice(0, 24);
    orbiters = skillIds.map((skill, i) => {
      // An invisible, larger sphere is the hit target; the visible light sits inside it.
      const s = new THREE.Mesh(new THREE.SphereGeometry(0.2, 12, 12), hitMat);
      s.add(new THREE.Mesh(new THREE.SphereGeometry(0.075, 16, 16), basic(COLORS.pink)));
      s.userData = { phase: (i / skillIds.length) * Math.PI * 2, section: 'skills', skill, tip: () => skill };
      orbitGroup.add(s); hits.push(s); return s;
    });
    // Segmented rings: one segment per active task (sky one-time, amber recurring) and per skill.
    const segment = (sat, colors) => {
      sat.fill.traverse((part) => part.geometry?.dispose());
      sat.fill.clear();
      const sStep = (Math.PI * 2) / Math.max(1, colors.length), sGap = Math.min(0.12, sStep * 0.3);
      colors.forEach((color, i) => { const p = arc(0.72, 0.045, sStep - sGap, color); placeCW(p, i * sStep + sGap / 2, sStep - sGap); sat.fill.add(p); });
    };
    segment(satellites[0], v.activeTasks.map((x) => (x.taskType === 'recurring' ? COLORS.amber : COLORS.sky)));
    segment(satellites[2], v.data.skills.map(() => satellites[2].color));
    labels.name.textContent = v.name;
  }

  // HTML labels projected from 3D points.
  const labelsEl = document.getElementById('labels');
  const makeLabel = (cls, word) => { const el = h('div', { class: 'label ' + cls }, h('b', {}, '0'), h('span', {}, word)); labelsEl.append(el); return el; };
  const labels = { core: makeLabel('core', ''), activity: makeLabel('tip', 'msgs'), failure: makeLabel('tip', 'failed') };
  labels.core.querySelector('span').remove();
  labels.name = h('div', { class: 'label name' }); labelsEl.append(labels.name);
  satellites.forEach((s) => { s.label = makeLabel('', s.word); });
  applyView(view);
  listeners.push(applyView);

  const v3 = new THREE.Vector3();
  function place(el, obj, local = [0, 0, 0]) {
    v3.set(...local); obj.localToWorld(v3); v3.project(camera);
    el.style.left = (v3.x * 0.5 + 0.5) * innerWidth + 'px'; el.style.top = (-v3.y * 0.5 + 0.5) * innerHeight + 'px';
  }
  const tipPoint = (r, frac, pad) => { const a = Math.PI / 2 - frac * Math.PI * 2; return [Math.cos(a) * (r + pad), Math.sin(a) * (r + pad), 0]; };

  // Interaction.
  const raycaster = new THREE.Raycaster(), pointer = new THREE.Vector2(9, 9), parallax = new THREE.Vector2();
  const tooltip = document.getElementById('tooltip');
  let hovered = null;
  // Hover tooltips only make sense for a mouse; touch taps open the drawer.
  let mousePointer = true;
  addEventListener('pointerdown', (e) => { mousePointer = e.pointerType === 'mouse'; });
  addEventListener('pointermove', (e) => {
    mousePointer = e.pointerType === 'mouse';
    pointer.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
    parallax.copy(pointer);
    tooltip.style.left = e.clientX + 'px'; tooltip.style.top = e.clientY + 'px';
  });
  renderer.domElement.addEventListener('click', (e) => {
    pointer.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1); pick();
    if (hovered?.skill) showSkill(hovered.skill, 'SKILL.md'); else if (hovered) openDrawer(hovered.section); else closeDrawer();
  });
  function pick() {
    raycaster.setFromCamera(pointer, camera);
    const hit = raycaster.intersectObjects(hits, false)[0];
    hovered = hit ? hit.object.userData : null;
    renderer.domElement.style.cursor = hovered ? 'pointer' : 'default';
    tooltip.classList.toggle('on', !!hovered && mousePointer);
    if (hovered) tooltip.textContent = hovered.tip();
  }

  function resize() {
    const w = innerWidth, ht = innerHeight;
    renderer.setSize(w, ht); composer.setSize(w, ht); bloom.setSize(w, ht);
    camera.aspect = w / ht;
    const tan = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    camera.position.z = Math.max(10.4 / (2 * tan), 9 / (2 * tan * camera.aspect));
    camera.updateProjectionMatrix();
  }
  addEventListener('resize', resize); resize();

  // Animated values ease toward the current view, so refreshes glide.
  const shown = { health: 0, activity: 0, failure: 0, messages: 0, failed: 0, sats: [0, 0, 0], satValues: [0, 0, 0] };
  const approach = (from, to, k) => Math.abs(to - from) < 0.0005 ? to : from + (to - from) * k;
  const ease = (t) => 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3);
  const timer = new THREE.Clock();
  let hop = 0;

  // Reactions from the data: mood (sleep when stopped, worried when the latest
  // heartbeat was not healthy), faster motion while a turn is processing, a turn
  // when new messages arrive, a sweat drop on failure spikes, and a short badge
  // when a skill is used.
  const reaction = { mood: 'happy', sweat: false, working: false, turnStart: null, badge: null, messages: null, skills: null };
  const drop = new THREE.Mesh(new THREE.SphereGeometry(0.085, 14, 14), basic(COLORS.sky)); robot.add(drop);
  const badgeLight = new THREE.Mesh(new THREE.SphereGeometry(0.07, 16, 16), basic(COLORS.pink)); robot.add(badgeLight);
  const zzz = h('div', { class: 'label zzz', 'aria-hidden': 'true' }, h('i', {}, 'z'), h('i', {}, 'z'), h('i', {}, 'z')); labelsEl.append(zzz);
  const badgeLabel = h('div', { class: 'label badge' }); labelsEl.append(badgeLabel);
  function react(v) {
    const known = v.hours.filter((hour) => hour.state !== 'unknown');
    const latest = known[known.length - 1]?.state;
    reaction.mood = v.data.profile.status === 'stopped' ? 'sleep' : latest && latest !== 'healthy' ? 'worried' : 'happy';
    reaction.sweat = v.m.failedReplies24h >= 3 || v.failureFrac >= 0.15;
    reaction.working = v.data.messages.some((x) => x.state === 'processing' && Date.now() - Date.parse(x.createdAt) < 30 * 60_000);
    const skills = v.data.insights?.['24h']?.skills ?? [];
    if (reaction.messages !== null && v.m.messages24h > reaction.messages && !reduceMotion) reaction.turnStart = timer.getElapsedTime();
    const fresh = reaction.skills && skills.find((s) => s.count > (reaction.skills.get(s.skill) ?? 0));
    if (fresh) reaction.badge = { skill: fresh.skill, start: timer.getElapsedTime() };
    reaction.messages = v.m.messages24h;
    reaction.skills = new Map(skills.map((s) => [s.skill, s.count]));
  }
  react(view);
  listeners.push(react);
  const one = new THREE.Vector3(1, 1, 1), big = new THREE.Vector3(1.1, 1.1, 1.1);
  function frame() {
    const t = reduceMotion ? 10 : timer.getElapsedTime();
    const spin = reduceMotion ? 0 : t;
    const k = reduceMotion ? 1 : 0.06;
    const ready = (delay) => t > delay;
    healthSegs.forEach((seg, i) => { const target = hovered?.seg === seg ? 1.04 : 1; seg.scale.setScalar(Math.max(0.001, ease((t - 0.2 - i * 0.035) / 0.7) * target)); });
    const prev = { a: shown.activity, f: shown.failure };
    if (ready(0.6)) { shown.activity = approach(shown.activity, view.activityFrac, k); shown.messages = approach(shown.messages, view.m.messages24h, k); }
    if (ready(0.9)) { shown.failure = approach(shown.failure, view.failureFrac, k); shown.failed = approach(shown.failed, view.m.failedReplies24h, k); }
    if (ready(0.2)) shown.health = approach(shown.health, view.healthPct ?? 0, k);
    if (prev.a !== shown.activity || !activityArc.userData.drawn) { setArc(activityArc, 2.7, 0.06, shown.activity); activityArc.userData.drawn = true; }
    if (prev.f !== shown.failure || !failureArc.userData.drawn) { setArc(failureArc, 2.25, 0.055, Math.max(0.004, shown.failure)); failureArc.userData.drawn = true; }
    activityHead.position.set(...tipPoint(2.7, shown.activity, 0));
    failureHead.position.set(...tipPoint(2.25, Math.max(0.004, shown.failure), 0));
    activityHead.visible = shown.activity > 0.002; failureHead.visible = shown.failure > 0.002;
    satellites.forEach((s, i) => {
      if (ready(1 + i * 0.15)) {
        shown.satValues[i] = approach(shown.satValues[i], s.value(view), k);
        if (!s.segmented) { const before = shown.sats[i]; shown.sats[i] = approach(shown.sats[i], s.frac(view), k); if (before !== shown.sats[i] || !s.fill.userData.drawn) { setArc(s.fill, 0.72, 0.045, Math.max(0.004, shown.sats[i])); s.fill.userData.drawn = true; } }
        else s.fill.scale.setScalar(Math.max(0.001, ease((t - 1 - i * 0.15) / 0.8)));
      } else if (s.segmented) s.fill.scale.setScalar(0.001);
      s.spin.rotation.z = spin * (i % 2 ? -0.15 : 0.15);
      s.group.scale.lerp(hovered?.sat === s.group ? big : one, 0.15);
      s.group.position.y = -3.95 + Math.sin(spin * 0.8 + i) * 0.04;
      s.label.querySelector('b').textContent = Math.round(shown.satValues[i]);
    });
    // Skill lights orbit slowly and pause while one is hovered, so it is easy to click.
    if (!hovered?.skill) orbitAngle += Math.max(0, t - lastFrameT) * 0.25;
    lastFrameT = t;
    orbiters.forEach((o) => {
      const a = o.userData.phase - orbitAngle;
      o.position.set(Math.cos(a) * 1.75, Math.sin(a) * 1.75, 0);
      const lit = reaction.badge?.skill === o.userData.skill || hovered === o.userData;
      o.scale.setScalar(lit ? 1.6 + 0.3 * Math.sin(spin * 8) : 1);
    });
    statusRing.material.opacity = 0.45 + 0.4 * (0.5 + 0.5 * Math.sin(spin * 2.2));
    statusRing.scale.setScalar(1 + 0.015 * Math.sin(spin * 2.2));
    hop += ((hovered?.section === 'profile' ? 0.08 : 0) - hop) * 0.15;
    const busy = reaction.working ? 2.6 : 1;
    robot.position.y = Math.sin(spin * 1.6 * busy) * (reaction.working ? 0.05 : 0.035) + hop;
    robot.rotation.y += ((parallax.x * 0.35) - robot.rotation.y) * 0.08;
    robot.rotation.x += ((-parallax.y * 0.3) - robot.rotation.x) * 0.08;
    const now = reduceMotion ? timer.getElapsedTime() : t;
    const turn = reaction.turnStart === null ? 1 : Math.min(1, (now - reaction.turnStart) / 0.9);
    if (turn >= 1) reaction.turnStart = null;
    robotBody.rotation.y = ease(turn) * Math.PI * 2;
    const blink = !reduceMotion && t % 4.2 < 0.13 ? 0.12 : 1;
    eyes.forEach((eye) => {
      eye.scale.y = reaction.mood === 'sleep' ? 0.12 : blink;
      eye.rotation.z = reaction.mood === 'worried' ? -Math.sign(eye.position.x) * 0.45 : 0;
    });
    arms.forEach((arm, i) => { arm.position.y = arm.userData.baseY + Math.sin(spin * 3 * busy + i * Math.PI) * (reaction.working ? 0.03 : 0.018); });
    const { halfWidth, halfHeight, cell: robotCell } = robot.userData;
    const fall = reduceMotion ? 0.3 : (t % 1.6) / 1.6;
    drop.visible = reaction.sweat && reaction.mood !== 'sleep';
    drop.position.set(halfWidth * 0.75, halfHeight * (0.7 - fall * 0.8), robotCell * 1.2);
    drop.scale.setScalar(1 - fall * 0.5);
    const badgeAge = reaction.badge ? now - reaction.badge.start : Infinity;
    if (badgeAge > 6) reaction.badge = null;
    badgeLight.visible = badgeAge <= 6;
    badgeLight.position.set(0, -halfHeight * 0.25, robotCell * 1.4);
    badgeLight.scale.setScalar(1 + 0.3 * Math.sin(now * 8));
    if (reaction.badge) badgeLabel.textContent = reaction.badge.skill;
    badgeLabel.style.opacity = badgeAge <= 6 ? '1' : '0';
    zzz.style.opacity = reaction.mood === 'sleep' ? '1' : '0';
    antennas.forEach((light) => light.scale.setScalar(1 + 0.18 * Math.sin(spin * 3.2)));
    outerTicks.rotation.z = -spin * 0.03;
    stars.rotation.z = spin * 0.004;
    tilt.rotation.x += ((-0.22 - parallax.y * 0.12) - tilt.rotation.x) * 0.05;
    tilt.rotation.y += ((parallax.x * 0.22) - tilt.rotation.y) * 0.05;
    const unitsPerPx = (2 * camera.position.z * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) / innerHeight;
    root.position.x += (-drawerShiftPx * unitsPerPx - root.position.x) * 0.08;
    scene.updateMatrixWorld();
    labels.core.querySelector('b').textContent = view.healthPct === null ? '—' : Math.round(shown.health) + '%';
    labels.activity.querySelector('b').textContent = Math.round(shown.messages);
    labels.failure.querySelector('b').textContent = Math.round(shown.failed);
    place(labels.core, robot, [0, robot.userData.halfHeight + 0.3, 0]);
    place(labels.name, robot, [0, -robot.userData.halfHeight - 0.26, 0]);
    place(zzz, robot, [halfWidth * 0.8, halfHeight + 0.05, 0]);
    place(badgeLabel, robot, [halfWidth + 0.45, -halfHeight * 0.25, 0]);
    place(labels.activity, tilt, tipPoint(2.7, shown.activity, 1.5));
    place(labels.failure, tilt, tipPoint(2.25, Math.max(0.004, shown.failure), -0.42));
    satellites.forEach((s) => place(s.label, s.group));
    pick();
    composer.render();
    requestAnimationFrame(frame);
  }
  frame();
}
</script>
</body>
</html>
`;
}
