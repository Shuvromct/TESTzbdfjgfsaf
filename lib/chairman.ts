import { one } from './db';

/**
 * The Chairman's link — what every page of it shares.
 * ---------------------------------------------------------------------------
 * One address, no sign-in, nothing writable. It exists so the project can be
 * shown to somebody who will never hold an account here, and the address is
 * the whole of the protection — which is worth being honest about: anyone
 * who has the link is looking at the project. It is set, moved and switched
 * off from the Administration page, and switching it off kills the link that
 * is already out there.
 *
 * What travels, and what does not
 * -------------------------------
 *   it does        roll-ups, status, gate dates, phase progress, what is
 *                  late, department workload, the budget totals the
 *                  Dashboard already shows, every task with its dates,
 *                  progress, remarks, acceptance criteria, evidence links
 *                  and photographs, and the names of the people responsible
 *   it does not    email addresses, telephone numbers, employee numbers,
 *                  the audit trail, the recycle bin, the accounts, or any
 *                  form, button or endpoint that could change a record
 *
 * Every page is rendered on the server as plain HTML. There is no script on
 * any of them, and none of them calls /api/state, so none of the
 * application's own routes becomes reachable without a session by being
 * linked from here.
 */

export const esc = (s: unknown) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export const ZONE = process.env.PROJECT_TIMEZONE || 'Asia/Dhaka';
export const today = () => new Date().toLocaleDateString('en-CA', { timeZone: ZONE });

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

/** A day, read as three numbers rather than built into a moment — see lib/db.ts. */
export const fmt = (d: any) => {
  if (!d) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d));
  if (m) return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1].slice(2)}`;
  /* Built from MONTHS rather than handed to toLocaleDateString, which in a
     newer ICU writes "Sept" where the rest of the page writes "Sep" — two
     spellings of September on one screen, in a document going to the
     Chairman. */
  const x = new Date(d);
  if (isNaN(+x)) return String(d).slice(0, 10);
  const parts = new Intl.DateTimeFormat('en-GB', {
    day: 'numeric', month: 'numeric', year: 'numeric', timeZone: ZONE,
  }).formatToParts(x);
  const get = (k: string) => Number(parts.find(z => z.type === k)?.value || 0);
  return `${get('day')} ${MONTHS[get('month') - 1]} ${String(get('year')).slice(2)}`;
};
export const money = (n: any) => (n === null || n === undefined || n === '') ? '—'
  : Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
export const pct = (n: any) => `${Math.round((Number(n) || 0) * 100)}%`;

/** Which pill a status wears. The one thing Ongoing must not look like is Delayed. */
export const tone = (s: string) =>
  s === 'Delayed' ? 'st-late'
  : s === 'Due soon' || s === 'Completed – evidence gap' ? 'st-soon'
  : s === 'Completed' ? 'st-done'
  : s === 'In Progress' ? 'st-prog'
  : s === 'Ongoing' ? 'st-cont' : '';

export const bar = (f: number) =>
  `<div class="bar"><i style="width:${Math.max(0, Math.min(100, Math.round(f * 100)))}%"></i></div>`;

/* A figure with a list behind it is a link; one without is left alone.
   The same rule as the application's own Dashboard, which is where the
   habit of pressing them comes from. */
/* ---- a row is one line ----
   The same treatment as the register inside the application: a face
   instead of a name, a chip instead of a repeated word, a dot instead of
   "P0 – Critical", and a title cut where it stops fitting. The whole of
   anything clipped is on hover, and on the task's own page. */
const AV_HUES = ['#3d6ba3', '#2f7d6b', '#8a5f9e', '#b06a3b', '#5a7a4f',
                 '#4b6ea9', '#9a5a6b', '#6b6f8a', '#a2763a', '#497b8c'];

export function initials(name: string) {
  const w = String(name || '').replace(/\(.*?\)/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (!w.length) return '—';
  return ((w[0][0] || '') + (w.length > 1 ? (w[w.length - 1][0] || '') : '')).toUpperCase();
}
export function avHue(name: string) {
  let h = 0;
  for (const c of String(name || '')) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return AV_HUES[h % AV_HUES.length];
}
export const shortName = (n: string) =>
  String(n || '').replace(/\s*\(.*?\)\s*/g, ' ').trim() || String(n || '');

export const face = (full: string) => full
  ? `<span class="face" title="${esc(full)}">
       <i class="av" style="background:${avHue(full)}">${esc(initials(full))}</i>
       <span>${esc(shortName(full))}</span></span>`
  : '<span class="face nobody"><i class="av grey">—</i><span>unassigned</span></span>';

export const priDot = (p: string) => {
  const c = /P0/.test(p || '') ? 'p0' : /P1/.test(p || '') ? 'p1' : 'p2';
  return `<i class="pdot ${c}" title="${esc(p || 'P2 – Medium')}"></i>`;
};
export const tagc = (s: string) => s
  ? `<span class="tagc">${esc(s)}</span>` : '—';

export const kpi = (label: string, value: any, t = '', href = '') => href
  ? `<a class="k${t ? ' ' + t : ''}" href="${esc(href)}"><b>${esc(value)}</b>
       <span>${esc(label)} <span class="go">›</span></span></a>`
  : `<div class="k${t ? ' ' + t : ''}"><b>${esc(value)}</b><span>${esc(label)}</span></div>`;

/** Is this address open, and is it this one? */
export async function linkOpen(slug: string): Promise<boolean> {
  try {
    const row = await one(`select value from settings where key='chairman_link'`);
    const link = (row && row.value) || {};
    return !!link.on && !!link.slug && String(link.slug) === String(slug || '');
  } catch { return false; }
}

export const gone = () => new Response(
  `<!doctype html><meta charset="utf-8"><title>Not found</title>
   <body style="font:16px/1.6 system-ui;margin:12vh auto;max-width:34rem;padding:0 1rem;color:#263">
   <h1 style="font-size:19px">This link is not open.</h1>
   <p>It may have been switched off, or the address may be mistyped.
      Ask the DIU Campus Legacy 25 project office.</p>`,
  { status: 404, headers: { 'content-type': 'text/html; charset=utf-8' } });

const CSS = `
  :root { --ink:#15203a; --muted:#5b6882; --line:#e3e7ef; --card:#fff; --bg:#f5f7fb;
          --blue:#1b3a74; --late:#b4232a; --soon:#9a6400; --done:#1d6b43; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--ink);
         font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
  /* 1180 left the task titles 340px on a 1366 screen — "Issue mandate;
     appoint one Project Directo…" is not a task anybody can read. The
     register and the timeline are tables and take the wider measure; the
     overview keeps the narrower one, because its cards read better short. */
  .wrap { max-width:1240px; margin:0 auto; padding:24px 16px 64px; }
  .wrap.wide { max-width:1600px; }
  header.top { background:var(--blue); color:#fff; padding:20px 0 0; }
  header.top .wrap { padding:0 16px; }
  header.top h1 { margin:0; font-size:21px; letter-spacing:-.01em; }
  header.top h1 a { color:#fff; text-decoration:none; }
  header.top p { margin:6px 0 0; opacity:.82; font-size:13px; }
  nav.tabs { display:flex; gap:4px; margin-top:14px; flex-wrap:wrap; }
  nav.tabs a { color:#fff; opacity:.72; text-decoration:none; font-size:13.5px; font-weight:550;
               padding:9px 14px; border-radius:8px 8px 0 0; }
  nav.tabs a:hover { opacity:1; background:rgba(255,255,255,.1); }
  nav.tabs a.on { opacity:1; background:var(--bg); color:var(--blue); }
  h2 { font-size:15px; margin:0 0 12px; }
  a { color:var(--blue); }
  /* Eighty underlined task titles down a page is a page of underlining, not
     a register. The colour already says they are links; the underline comes
     back on hover, and on anything that is not obviously one. */
  table a { text-decoration:none; }
  table a:hover, table a:focus-visible { text-decoration:underline; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px;
          padding:16px 18px; margin-bottom:16px; }
  .kpis { display:grid; grid-template-columns:repeat(auto-fit,minmax(126px,1fr));
          gap:12px; margin-bottom:16px; }
  .k { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:12px 14px; }
  .k b { display:block; font-size:26px; font-weight:650; line-height:1.1;
         font-variant-numeric:tabular-nums; letter-spacing:-.02em; }
  .k span { display:block; font-size:11.5px; color:var(--muted); margin-top:5px; }
  .k.bad b { color:var(--late); } .k.warn b { color:var(--soon); }
  .two { display:grid; grid-template-columns:1fr 1fr; gap:16px; }
  @media (max-width:860px) { .two { grid-template-columns:1fr; } }
  table { width:100%; border-collapse:collapse; font-size:13.5px; }
  th { text-align:left; font-size:11px; letter-spacing:.04em; text-transform:uppercase;
       color:var(--muted); border-bottom:1px solid var(--line); padding:7px 12px; font-weight:600; }
  /* 13px top and bottom rather than 8: a register is swept down, and the eye
     needs somewhere to rest between one line and the next. */
  td { padding:13px 12px; border-bottom:1px solid var(--line); vertical-align:middle; }
  /* Colour at the left edge rather than across the whole line. Twenty tinted
     rows is every row shouting, so none of them heard; the status is on the
     pill, and the margin carries three pixels of it. */
  tr.row-st-late td:first-child { box-shadow:inset 3px 0 0 var(--late); }
  tr.row-st-soon td:first-child { box-shadow:inset 3px 0 0 var(--soon); }
  tr.row-st-done td:first-child { box-shadow:inset 3px 0 0 #3f9960; }
  tr.row-st-cont td:first-child { box-shadow:inset 3px 0 0 #7fb4c4; }
  /* A task's sub-tasks are a block of their own, on a cooler ground. */
  tr.kid td { background:#eff4fb; border-bottom-color:#dfe7f3; }
  tr.kid td:first-child { box-shadow:inset 3px 0 0 #9ab6de; }
  th:first-child, td:first-child { padding-left:0; }
  th:last-child, td:last-child { padding-right:0; }
  tr:last-child td { border-bottom:0; }
  th.n, td.n { text-align:right; width:1%; white-space:nowrap; }
  td.id, td.dt, td.who, td.dp { width:1%; white-space:nowrap; }
  td.id { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12.5px; }
  /* A name that reads "Md Shafikul I…" is worse than a name on two lines.
     The rows are tall enough for it now. */
  /* Wide enough that almost every name is one line; the rare long post
     wraps to two rather than being cut to "Md Shafikul I…". */
  /* width:1% squeezes a column to its longest word, which once wrapping was
     allowed put Vice-Chancellor on two lines in a 1500px table. The floor
     keeps the column wide enough for a name. */
  td.who, th.who { width:1%; min-width:170px; max-width:26ch;
                   color:var(--muted); font-size:13px; }
  td.who .face > span { white-space:normal; overflow:visible; }
  /* the title takes whatever the content-sized columns leave */
  th.ti, td.ti { width:99%; }
  td.ti.line { max-width:0; }
  /* The class here is stc and not st: .st is the status pill itself, and a
     heading wearing that class came out as a grey pill saying STANDING. */
  th.stc, td.stc { width:1%; white-space:nowrap; }
  td.ti.line > span { display:block; overflow:hidden; text-overflow:ellipsis;
                      white-space:nowrap; }
  .face { display:inline-flex; align-items:center; gap:7px; min-width:0; max-width:100%; }
  .face > span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .face.nobody > span { font-style:italic; }
  .av { width:24px; height:24px; border-radius:50%; flex:0 0 24px; display:inline-grid;
        place-items:center; font-size:11.5px; font-weight:700; color:#fff; }
  .av.grey { background:#c3cbd9; }
  .tagc { display:inline-block; max-width:100%; overflow:hidden; text-overflow:ellipsis;
          white-space:nowrap; vertical-align:bottom; background:#eef1f6; color:var(--muted);
          border-radius:999px; padding:2px 9px; font-size:11.5px; }
  .pdot { display:inline-block; width:7px; height:7px; border-radius:50%; margin-right:7px;
          vertical-align:1px; background:#c8cfdb; }
  .pdot.p0 { background:#c0392b; } .pdot.p1 { background:#c9880f; }
  .od { color:var(--late); font-weight:650; }
  td.dp { width:1%; max-width:24ch; white-space:nowrap; overflow:hidden;
          color:var(--muted); font-size:13px; }
  td.ti { overflow-wrap:anywhere; }
  .scroll { overflow-x:auto; }
  .st { display:inline-block; padding:2px 8px; border-radius:999px; font-size:11.5px;
        white-space:nowrap; background:#eef1f6; color:var(--muted); }
  .st-late { background:#fdeaea; color:var(--late); }
  .st-soon { background:#fdf3e0; color:var(--soon); }
  .st-done { background:#e8f5ee; color:var(--done); }
  .st-prog { background:#e9effb; color:var(--blue); }
  .st-cont { background:#e4eef0; color:#17555e; }
  .bar { background:#eceff5; border-radius:999px; height:7px; min-width:72px; overflow:hidden; }
  .bar i { display:block; height:100%; background:var(--blue); border-radius:999px; }
  .note { color:var(--muted); font-size:12.5px; }
  .kv { width:100%; }
  .kv td:first-child { color:var(--muted); width:1%; white-space:nowrap; padding-right:20px; }
  .quote { background:#f7f9fc; border-left:3px solid var(--line); margin:0;
           padding:10px 14px; border-radius:0 8px 8px 0; font-size:13.5px; }
  .filters { display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin-bottom:16px; }
  .filters input, .filters select {
    font:inherit; font-size:13.5px; padding:8px 10px; border:1px solid var(--line);
    border-radius:6px; background:var(--card); color:var(--ink); }
  .filters button { font:inherit; font-size:13.5px; font-weight:600; padding:8px 16px;
    border:0; border-radius:6px; background:var(--blue); color:#fff; cursor:pointer; }
  /* The photographs are the evidence, and the comparison is the point.
     -----------------------------------------------------------------------
     They used to be three stacked sections, each holding one 180px square in
     a 1200px card — a lonely thumbnail with a hand's width of nothing beside
     it, three times over. Before, during and after now stand side by side and
     read left to right, which is the way somebody actually looks at them, and
     each is big enough to tell what it shows. */
  .stages { display:grid; grid-template-columns:repeat(3,1fr); gap:18px; margin-top:4px; }
  @media (max-width:900px) { .stages { grid-template-columns:1fr; } }
  .stage h3 { font-size:12px; letter-spacing:.04em; text-transform:uppercase;
              color:var(--muted); margin:0 0 8px; font-weight:650; }
  .stage.empty { opacity:.55; }
  .stage .none { font-size:13px; color:var(--muted); border:1px dashed var(--line);
                 border-radius:10px; padding:28px 12px; text-align:center; }
  .shots { display:grid; gap:12px; margin:0; }
  .shots figure { margin:0; }
  /* Four by three, the shape a phone's camera gives and the shape a wall
     photograph wants. Click opens the photograph itself, full size. */
  .shots a { display:block; position:relative; }
  .shots img { width:100%; aspect-ratio:4/3; object-fit:cover; border-radius:10px;
               border:1px solid var(--line); background:#eceff5; display:block; }
  .shots a:hover img { border-color:var(--blue); }
  .shots a::after {
    content:'Open'; position:absolute; right:8px; bottom:8px;
    background:rgba(16,24,48,.72); color:#fff; font-size:11px; font-weight:600;
    padding:3px 8px; border-radius:999px; opacity:0; transition:opacity .12s;
  }
  .shots a:hover::after { opacity:1; }
  .shots figcaption { font-size:12.5px; color:var(--ink); margin-top:7px; line-height:1.45; }
  .shots figcaption .when { color:var(--muted); display:block; font-size:11.5px; }
  .crumb { font-size:13px; color:var(--muted); margin:0 0 10px; }
  .count { display:inline-block; background:#eef1f6; color:var(--muted); border-radius:999px;
           padding:1px 8px; font-size:11.5px; font-weight:600; }
  .count.bad { background:#fdeaea; color:var(--late); }
  .small { font-size:12px; color:var(--muted); }

  /* a pair of links that behave like a switch */
  .seg { display:inline-flex; border:1px solid var(--line); border-radius:6px; overflow:hidden; }
  .seg a { padding:8px 14px; font-size:13.5px; font-weight:550; text-decoration:none;
           color:var(--muted); background:var(--card); }
  .seg a + a { border-left:1px solid var(--line); }
  .seg a.on { background:var(--blue); color:#fff; }
  .seg a:hover:not(.on) { background:#eef2f8; color:var(--ink); }

  /* ---- the timeline ----
     Weeks across, tasks down. The same shape as the one inside the
     application, drawn here with no script: every bar is a link to its
     task and the window is chosen by following one. */
  .tl { padding:0; overflow:hidden; }
  .tl-scale, .tl-row { display:grid; grid-template-columns:minmax(170px,26%) 1fr;
                       align-items:center; gap:12px; }
  .tl-scale { position:sticky; top:0; z-index:2; background:var(--card);
              border-bottom:1px solid var(--line); padding:12px 16px 8px; }
  .tl-scale .tl-track { height:18px; }
  .tl-tick { position:absolute; top:0; transform:translateX(-50%); font-size:10.5px;
             color:var(--muted); white-space:nowrap; font-variant-numeric:tabular-nums; }
  .tl-now { position:absolute; top:-4px; bottom:-9999px; width:2px;
            background:var(--late); opacity:.5; }
  .tl-now b { position:absolute; top:14px; left:3px; font-size:10px; color:#fff;
              background:var(--late); font-weight:650; white-space:nowrap;
              padding:1px 5px; border-radius:0 6px 6px 0; }
  .tl-sec { border-bottom:1px solid var(--line); }
  .tl-sec:last-child { border-bottom:0; }
  .tl-fold { display:flex; align-items:center; gap:8px; padding:9px 16px;
             background:var(--bg); font-size:12.5px; font-weight:650; color:var(--ink);
             text-transform:uppercase; letter-spacing:.05em; }
  .tl-fold .small { text-transform:none; letter-spacing:0; color:var(--late); }
  .tl-row { padding:5px 16px; }
  .tl-row:hover { background:#f3f6fb; }
  .tl-row.off { opacity:.55; }
  .tl-name { font-size:13px; line-height:1.35; min-width:0;
             overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .tl-name a { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; }
  .tl-track { position:relative; height:22px; min-width:0; }
  .tl-bar { position:absolute; top:3px; height:16px; border-radius:3px; display:flex;
            align-items:center; overflow:hidden; background:#7f9cd6; }
  .tl-bar b { display:block; height:100%; background:rgba(0,0,0,.34);
              border-radius:3px 0 0 3px; }
  .tl-bar.dot { width:14px; height:14px; top:4px; background:none; color:var(--blue);
                font-size:13px; justify-content:center; margin-left:-7px; text-decoration:none; }
  .tl-bar.bar-late { background:#d9534f; }
  .tl-bar.bar-g1 { background:#7f9cd6; }
  .tl-bar.bar-g2 { background:#c9a227; }
  .tl-bar.bar-g3 { background:#8a97ad; }
  .tl-bar.bar-g4 { background:#6b7280; }
  .tl-when { position:absolute; top:4px; margin-left:6px; font-size:10.5px;
             color:var(--muted); white-space:nowrap; font-variant-numeric:tabular-nums;
             pointer-events:none; }
  .tl-away { font-size:11.5px; color:var(--muted); font-style:italic; }
  .tl-edge { position:absolute; top:2px; font-size:14px; color:var(--muted); padding:0 2px; }
  .tl-edge.l { left:-10px; }
  .tl-edge.r { right:-10px; }
  @media (max-width:760px) {
    .tl-scale, .tl-row { grid-template-columns:minmax(110px,34%) 1fr; gap:8px; }
    .tl-name { font-size:12px; }
  }

  /* a figure that opens the list behind it */
  a.k { text-decoration:none; color:inherit; display:block;
        transition:border-color .12s, background .12s; }
  a.k:hover { border-color:var(--blue); background:#f3f6fb; }
  a.k .go { color:var(--muted); font-weight:700; }
  a.k:hover .go { color:var(--blue); }
  tr.pick:hover { background:#f3f6fb; }
  td a.linky { font-variant-numeric:tabular-nums; font-weight:600; }
  footer { color:var(--muted); font-size:12px; text-align:center; padding-top:8px; }
  /* The credit sits still.
     ---------------------------------------------------------------------
     Centred in the flow it moved with the page and grew with it, which on a
     document going to the Chairman reads as part of the report rather than a
     signature on it. Pinned to the bottom right, small and quiet, it is
     there without being in the way. */
  .madeby {
    position:fixed; right:12px; bottom:10px; z-index:5;
    font-size:11px; color:var(--muted); letter-spacing:.01em;
    background:rgba(255,255,255,.82); backdrop-filter:blur(3px);
    border:1px solid var(--line-2, #eef1f6); border-radius:999px;
    padding:4px 11px; pointer-events:none; max-width:70vw;
    overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
  }
  .madeby b { font-weight:650; color:var(--ink); }
  /* On a phone it would sit on top of the last row of a table. */
  @media (max-width:560px) { .madeby { position:static; display:block; text-align:center;
    background:none; border:0; margin:4px 0 0; max-width:none; } }
  @media print { .madeby { position:fixed; background:none; border:0; } }
`;

/** Every page wears the same frame, so the three feel like one place. */
export function shell(slug: string, tab: 'overview' | 'tasks' | 'timeline' | '',
                      title: string, body: string) {
  const base = `/c/${encodeURIComponent(slug)}`;
  /* The register and the timeline are tables and want the room; the overview
     is cards and reads better at the narrower measure. */
  const wide = tab === 'tasks' || tab === 'timeline' ? ' wide' : '';
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow, noarchive">
<title>${esc(title)} — DIU Campus Legacy 25</title>
<style>${CSS}</style></head>
<body>
<header class="top"><div class="wrap${wide}">
  <h1><a href="${base}">DIU Campus Legacy 25</a></h1>
  <p>Project DIU-CL25-2026 · implementation overview · as at ${esc(today())}</p>
  <nav class="tabs">
    <a href="${base}" class="${tab === 'overview' ? 'on' : ''}">Overview</a>
    <a href="${base}/tasks" class="${tab === 'tasks' ? 'on' : ''}">Task register</a>
    <a href="${base}/timeline" class="${tab === 'timeline' ? 'on' : ''}">Timeline</a>
  </nav>
</div></header>
<div class="wrap${wide}">
${body}
  <footer>A read-only view of the project record. Figures come from the live register
    and change as the work does.</footer>
</div>
<div class="madeby">Project Office · Created by <b>Md Shafikul Islam Shuvro</b></div>
</body></html>`;
}

export const page = (html: string) => new Response(html, {
  headers: {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-robots-tag': 'noindex, nofollow',
  },
});
