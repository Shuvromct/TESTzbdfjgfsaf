import { q } from '@/lib/db';
import { esc, fmt, pct, shell, page, gone, linkOpen, today } from '@/lib/chairman';

/**
 * The Chairman's link — the timeline.
 *
 * The same picture the project office works from: weeks across, tasks down,
 * a bar from each start date to each deadline with the share already done
 * drawn darker inside it. Grouped by phase, because seventy-odd bars in one
 * column is a wall.
 *
 * Two differences from the one inside the application, both because there
 * is no script on this page:
 *
 *   the window   is chosen with a link rather than a button — the near view
 *                (a fortnight behind, ten weeks ahead) and the full run of
 *                the project are two addresses, so either can be sent to
 *                somebody exactly as it is being looked at
 *   the phases   do not fold. Folding is a thing you do while reading, and
 *                it would need either script or a round trip for each one.
 */
export const dynamic = 'force-dynamic';

const PHASES = ['Phase 1 – IAUP Readiness', 'Event – IAUP Meeting',
                'Phase 2 – Silver Jubilee', 'Closeout & Care'];

const phaseCls = (p: string) => ({
  'Phase 1 – IAUP Readiness': 'g1', 'Event – IAUP Meeting': 'g2',
  'Phase 2 – Silver Jubilee': 'g3', 'Closeout & Care': 'g4',
} as any)[p] || 'g1';

/* A date column arrives as 'YYYY-MM-DD' (see lib/db.ts). Counting in whole
   days from the epoch keeps every bar on the same ruler and never lets a
   time zone move one by a day. */
const day = (d: any) => Math.floor(Date.parse(`${String(d).slice(0, 10)}T00:00:00Z`) / 864e5);

export async function GET(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  try {
    const { slug } = await ctx.params;
    if (!(await linkOpen(slug))) return gone();

    const url = new URL(req.url);
    const full = url.searchParams.get('span') === 'full';
    const phase = url.searchParams.get('phase') || '';
    const base = `/c/${encodeURIComponent(slug)}`;

    const rows = await q(`select * from task_state order by id`);
    const all = rows.filter((t: any) =>
      t.start_on && t.deadline && (!phase || t.phase === phase));

    const now = day(today());
    if (!all.length) {
      return page(shell(slug, 'timeline', 'Timeline', `
        <div class="card"><h2>Timeline</h2>
        <p class="note">No task${phase ? ' in this phase' : ''} has both a start date and a
          deadline, so there is nothing to draw.
          ${phase ? `<a href="${base}/timeline">Every phase</a>.` : ''}</p></div>`));
    }

    const lo = full ? Math.min(...all.map((t: any) => day(t.start_on))) : now - 14;
    const hi = full ? Math.max(...all.map((t: any) => day(t.deadline))) : now + 70;
    const span = Math.max(hi - lo, 1);
    const pos = (d: number) => ((d - lo) / span) * 100;

    /* Weeks when the window is short enough to read them, months when not. */
    const ticks: [number, string][] = [];
    if (!full) {
      const first = lo - ((new Date(lo * 864e5).getUTCDay() || 7) - 1);
      for (let w = first; w <= hi; w += 7)
        if (w >= lo) ticks.push([w, new Date(w * 864e5)
          .toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })]);
    } else {
      const d = new Date(lo * 864e5); d.setUTCDate(1);
      while (Math.floor(+d / 864e5) <= hi) {
        const x = Math.floor(+d / 864e5);
        if (x >= lo) ticks.push([x, d.toLocaleDateString('en-GB',
          { month: 'short', year: '2-digit', timeZone: 'UTC' })]);
        d.setUTCMonth(d.getUTCMonth() + 1);
      }
    }

    const bins = new Map<string, any[]>();
    for (const t of all.sort((a: any, b: any) =>
      String(a.id).localeCompare(String(b.id), undefined, { numeric: true }))) {
      const k = t.phase || 'No phase';
      if (!bins.has(k)) bins.set(k, []);
      bins.get(k)!.push(t);
    }
    const order = PHASES.filter(x => bins.has(x))
      .concat([...bins.keys()].filter(k => !PHASES.includes(k)));

    let shown = 0, outside = 0;
    const band = (name: string) => {
      const list = bins.get(name)!;
      const late = list.filter((t: any) => t.effective_status === 'Delayed').length;
      const inside = list.filter((t: any) => day(t.deadline) >= lo && day(t.start_on) <= hi);
      shown += inside.length; outside += list.length - inside.length;

      return `<section class="tl-sec">
        <div class="tl-fold">${esc(name)}
          <span class="count${late ? ' bad' : ''}">${list.length}</span>
          ${late ? `<span class="small">${late} delayed</span>` : ''}</div>
        ${list.map((t: any) => {
          const a = day(t.start_on), b = day(t.deadline);
          const link = `${base}/t/${encodeURIComponent(t.id)}`;
          const nm = `<div class="tl-name"><a href="${link}">${t.parent_id ? '↳ ' : ''}${esc(t.id)}</a>
            ${esc(t.title)}</div>`;
          if (b < lo || a > hi) return `<div class="tl-row off">${nm}
            <div class="tl-track"><span class="tl-away">${b < lo
              ? 'ended ' + esc(fmt(t.deadline)) : 'starts ' + esc(fmt(t.start_on))}</span></div></div>`;

          const from = Math.max(a, lo), to = Math.min(b, hi);
          const left = pos(from);
          const width = Math.max(pos(to) - left, 1.2);
          const progress = Number(t.effective_progress) || 0;
          const done = progress > 0 ? Math.min(width * progress, width) : 0;
          const cls = t.effective_status === 'Delayed' ? 'late' : phaseCls(t.phase);
          const title = `${t.title} — ${fmt(t.start_on)} to ${fmt(t.deadline)} · ${pct(progress)}`;
          return `<div class="tl-row">${nm}
            <div class="tl-track">
              <a class="tl-bar bar-${cls}${a === b ? ' dot' : ''}" href="${link}"
                 style="left:${left.toFixed(2)}%${a === b ? '' : `;width:${width.toFixed(2)}%`}"
                 title="${esc(title)}">${a === b ? '◆'
                   : (done ? `<b style="width:${((done / width) * 100).toFixed(1)}%"></b>` : '')}</a>
              ${b <= hi ? `<span class="tl-when"
                style="left:${Math.min(left + width, 97).toFixed(2)}%">${esc(fmt(t.deadline))}</span>` : ''}
              ${a < lo ? '<span class="tl-edge l">‹</span>' : ''}
              ${b > hi ? '<span class="tl-edge r">›</span>' : ''}
            </div></div>`;
        }).join('')}
      </section>`;
    };
    const body = order.map(band).join('');

    const keep = (p: Record<string, string>) => {
      const s = new URLSearchParams();
      if (phase) s.set('phase', phase);
      for (const [k, v] of Object.entries(p)) { if (v) s.set(k, v); else s.delete(k); }
      const qs = s.toString();
      return `${base}/timeline${qs ? `?${qs}` : ''}`;
    };

    const html = `
  <div class="filters">
    <form method="get" action="${base}/timeline">
      ${full ? '<input type="hidden" name="span" value="full">' : ''}
      <select name="phase" aria-label="Phase">
        <option value="">Every phase</option>
        ${PHASES.map(p => `<option value="${esc(p)}" ${phase === p ? 'selected' : ''}>${esc(p)}</option>`).join('')}
      </select>
      <button type="submit">Show</button>
    </form>
    <span class="seg">
      <a href="${keep({ span: '' })}" class="${full ? '' : 'on'}">Next ten weeks</a>
      <a href="${keep({ span: 'full' })}" class="${full ? 'on' : ''}">The whole project</a>
    </span>
  </div>

  <p class="note">${shown} task${shown === 1 ? '' : 's'} drawn${outside
    ? ` · ${outside} outside this window` : ''} · as at ${esc(today())}.
    The darker part of a bar is the share already done; a red bar is past its deadline;
    a diamond is a task that starts and ends on the same day.</p>

  <div class="card tl">
    <div class="tl-scale"><div class="tl-name"></div>
      <div class="tl-track">
        ${ticks.map(([d, l]) =>
          `<span class="tl-tick" style="left:${pos(d).toFixed(2)}%">${esc(l)}</span>`).join('')}
        ${now >= lo && now <= hi
          ? `<span class="tl-now" style="left:${pos(now).toFixed(2)}%"><b>today</b></span>` : ''}
      </div>
    </div>
    ${body}
  </div>`;

    return page(shell(slug, 'timeline', 'Timeline', html));
  } catch {
    return gone();
  }
}
