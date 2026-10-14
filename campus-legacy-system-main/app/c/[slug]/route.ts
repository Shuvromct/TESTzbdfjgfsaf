import { q } from '@/lib/db';
import {
  esc, fmt, money, pct, tone, bar, kpi, shell, page, gone, linkOpen,
  face, priDot, tagc,
} from '@/lib/chairman';

/**
 * The Chairman's link — the overview.
 *
 * What this page is for, and what it deliberately leaves out, is set down
 * in lib/chairman.ts. The register itself is at /c/<slug>/tasks and one
 * task is at /c/<slug>/t/<id>; all three share the frame and the rule.
 */
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  try {
    const { slug } = await ctx.params;
    if (!(await linkOpen(slug))) return gone();

    const [tasks, milestones, budget, depts, users] = await Promise.all([
      q(`select * from task_state order by id`),
      q(`select * from milestone_state order by sort_order, due_on`),
      q(`select approved, committed, paid, forecast_rest, qty, rate, other_costs from budget_lines`),
      q(`select id, name from departments order by name`),
      q(`select id, name from users`),
    ]);

    const name = (id: any) => (users.find((u: any) => u.id === id) || {}).name || '—';
    const dept = (id: any) => (depts.find((d: any) => d.id === id) || {}).name || '—';
    const parents = tasks.filter((t: any) => t.is_task);
    const n = (f: (t: any) => boolean) => tasks.filter(f).length;
    const dur = parents.reduce((a: number, t: any) => a + Number(t.duration_days || 0), 0);
    const weighted = dur
      ? parents.reduce((a: number, t: any) =>
          a + Number(t.duration_days || 0) * Number(t.effective_progress || 0), 0) / dur : 0;
    const sum = (k: string) => budget.reduce((a: number, b: any) => a + (Number(b[k]) || 0), 0);
    const estimated = budget.reduce((a: number, b: any) =>
      a + (Number(b.qty) || 0) * (Number(b.rate) || 0) + (Number(b.other_costs) || 0), 0);

    const STATS = ['Pending', 'In Progress', 'Under Review', 'Approved', 'Ongoing', 'Due soon',
                   'Delayed', 'On Hold', 'Completed – evidence gap', 'Completed'];
    const PHASES = ['Phase 1 – IAUP Readiness', 'Event – IAUP Meeting',
                    'Phase 2 – Silver Jubilee', 'Closeout & Care'];
    const rank = (s: string) =>
      ({ 'Delayed': 0, 'Due soon': 1, 'Completed – evidence gap': 2 } as any)[s] ?? 3;
    const attention = tasks
      .filter((t: any) => ['Delayed', 'Due soon', 'Completed – evidence gap'].includes(t.effective_status))
      .sort((a: any, b: any) => rank(a.effective_status) - rank(b.effective_status)
        || String(a.deadline || '').localeCompare(String(b.deadline || '')));

    const base = `/c/${encodeURIComponent(slug)}`;
    const link = (id: string) => `<a href="${base}/t/${encodeURIComponent(id)}">${esc(id)}</a>`;
    /* Every figure here is a question — "which eleven?" — and the register
       can already answer it, so each one links to itself filtered. */
    const see = (p: Record<string, string>) =>
      `${base}/tasks?${new URLSearchParams(p).toString()}`;

    const body = `
  <div class="kpis">
    ${kpi('Tasks', parents.length, '', see({ kind: 'task' }))}
    ${kpi('Sub-tasks', tasks.length - parents.length, '', see({ kind: 'sub' }))}
    ${kpi('Completed', n((t: any) => t.effective_status === 'Completed'), '',
          see({ status: 'Completed' }))}
    ${kpi('In progress', n((t: any) => t.status === 'In Progress'), '',
          see({ status: 'In Progress' }))}
    ${kpi('Ongoing', n((t: any) => t.effective_status === 'Ongoing'), '',
          see({ status: 'Ongoing' }))}
    ${kpi('Delayed', n((t: any) => t.effective_status === 'Delayed'),
          n((t: any) => t.effective_status === 'Delayed') ? 'bad' : '',
          see({ status: 'Delayed' }))}
    ${kpi('Weighted progress', pct(weighted))}
    ${kpi('Evidence gaps', n((t: any) => t.effective_status === 'Completed – evidence gap'),
          n((t: any) => t.effective_status === 'Completed – evidence gap') ? 'warn' : '',
          see({ status: 'Completed – evidence gap' }))}
  </div>

  <div class="two">
    <div class="card"><h2>Status at a glance</h2>
      <table><tbody>${STATS.map(st => {
        const c = n((t: any) => t.effective_status === st);
        const to = see({ status: st });
        return `<tr class="${c ? 'pick' : ''}">
          <td>${c ? `<a href="${to}" style="text-decoration:none">
            <span class="st ${tone(st)}">${esc(st)}</span></a>`
            : `<span class="st ${tone(st)}">${esc(st)}</span>`}</td>
          <td class="n">${c ? `<a class="linky" href="${to}">${c}</a>` : c}</td>
          <td style="width:40%">${bar(tasks.length ? c / tasks.length : 0)}</td></tr>`;
      }).join('')}</tbody></table>
    </div>
    <div class="card"><h2>Budget (BDT)</h2>
      <table><tbody>
        <tr><td>Estimated</td><td class="n">${money(estimated)}</td></tr>
        <tr><td>Approved</td><td class="n">${money(sum('approved'))}</td></tr>
        <tr><td>Committed</td><td class="n">${money(sum('committed'))}</td></tr>
        <tr><td>Paid to date</td><td class="n">${money(sum('paid'))}</td></tr>
        <tr><td>Forecast final</td><td class="n">${money(sum('paid') + sum('forecast_rest'))}</td></tr>
      </tbody></table>
      <p class="note">Project totals. Individual quotations and payments are not shown here.</p>
    </div>
  </div>

  <div class="two">
    <div class="card"><h2>Progress by phase</h2>
      <table><thead><tr><th>Phase</th><th class="n">Tasks</th><th class="n">Done</th>
        <th style="width:34%">Progress</th></tr></thead><tbody>
      ${PHASES.map(ph => {
        const ts = tasks.filter((t: any) => t.phase === ph && t.is_task);
        const d = ts.reduce((a: number, t: any) => a + Number(t.duration_days || 0), 0);
        const w = d ? ts.reduce((a: number, t: any) =>
          a + Number(t.duration_days || 0) * Number(t.effective_progress || 0), 0) / d : 0;
        return `<tr><td class="ti"><a href="${base}/tasks?phase=${encodeURIComponent(ph)}">${esc(ph)}</a></td>
          <td class="n">${ts.length}</td>
          <td class="n">${ts.filter((t: any) => t.effective_status === 'Completed').length}</td>
          <td>${bar(w)}</td></tr>`;
      }).join('')}
      </tbody></table>
    </div>
    <div class="card"><h2>Gates and milestones</h2>
      ${!milestones.length ? `<p class="note" style="margin:0">No gates have been set for this
        project yet.</p>` : `<div class="scroll"><table><thead><tr><th>Gate</th><th>Milestone</th>
        <th class="n">Date</th><th>Standing</th></tr></thead><tbody>
      ${milestones.map((m: any) => `<tr><td class="id">${esc(m.id)}</td>
        <td class="ti">${esc(m.title)}</td><td class="dt n">${esc(fmt(m.due_on))}</td>
        <td><span class="st ${String(m.flag).startsWith('Achieved') ? 'st-done'
          : m.flag === 'Overdue' || m.flag === 'Missed' ? 'st-late'
          : m.flag === 'Within 7 days' ? 'st-soon' : ''}">${esc(m.flag)}</span></td></tr>`).join('')}
      </tbody></table></div>`}
    </div>
  </div>

  <div class="card"><h2>Needs attention — ${attention.length}</h2>
    ${attention.length ? `<div class="scroll"><table><thead><tr>
      <th>Task</th><th>Title</th><th>Lead department</th><th>Responsible</th>
      <th class="n">Deadline</th><th>Standing</th><th class="n">Done</th>
    </tr></thead><tbody>
    ${attention.slice(0, 40).map((t: any) => `<tr>
      <td class="id">${priDot(t.priority)}${link(t.id)}</td>
      <td class="ti line"><span title="${esc(t.title)}"><a
        href="${base}/t/${encodeURIComponent(t.id)}">${esc(t.title)}</a></span></td>
      <td class="dp">${tagc(dept(t.lead_dept_id) === '—' ? '' : dept(t.lead_dept_id))}</td>
      <td class="who">${face(name(t.owner_id) === '—' ? '' : name(t.owner_id))}</td>
      <td class="dt n">${esc(fmt(t.deadline))}</td>
      <td><span class="st ${tone(t.effective_status)}">${esc(t.effective_status)}</span>
        ${Number(t.delay_days) > 0 ? ` <span class="note">${Number(t.delay_days)} d late</span>` : ''}</td>
      <td class="n">${pct(t.effective_progress)}</td>
    </tr>`).join('')}
    </tbody></table></div>
    ${attention.length > 40 ? `<p class="note">The forty most urgent of ${attention.length}.
      <a href="${base}/tasks?late=1">See them all</a>.</p>` : ''}`
    : '<p class="note">Nothing is late, due within three days, or missing its evidence.</p>'}
  </div>

  <div class="card"><h2>Department workload</h2>
    <div class="scroll"><table><thead><tr><th>Department</th><th class="n">Items</th>
      <th class="n">Done</th><th class="n">Delayed</th><th style="width:28%">Progress</th>
    </tr></thead><tbody>
    ${depts.map((d: any) => {
      const ts = tasks.filter((t: any) => t.lead_dept_id === d.id);
      if (!ts.length) return '';
      const ps = ts.filter((t: any) => t.is_task);
      const dd = ps.reduce((a: number, t: any) => a + Number(t.duration_days || 0), 0);
      const w = dd ? ps.reduce((a: number, t: any) =>
        a + Number(t.duration_days || 0) * Number(t.effective_progress || 0), 0) / dd : 0;
      const late = ts.filter((t: any) => t.effective_status === 'Delayed').length;
      return `<tr><td class="ti"><a href="${base}/tasks?dept=${encodeURIComponent(d.id)}">${esc(d.name)}</a></td>
        <td class="n">${ts.length}</td>
        <td class="n">${ts.filter((t: any) => t.effective_status === 'Completed').length}</td>
        <td class="n">${late || '—'}</td><td>${bar(w)}</td></tr>`;
    }).join('')}
    </tbody></table></div>
  </div>`;

    return page(shell(slug, 'overview', 'Project overview', body));
  } catch {
    return gone();
  }
}
