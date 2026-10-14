import { q } from '@/lib/db';
import { esc, fmt, pct, tone, shell, page, gone, linkOpen,
         face, priDot, tagc } from '@/lib/chairman';

/**
 * The Chairman's link — the task register.
 *
 * Seventy-odd tasks in one table, with a search box and two pickers. The
 * filtering is done on the server and carried in the address, because there
 * is no script on this page: a filtered view is a link, which means it can
 * be sent to somebody else exactly as it is being looked at.
 */
export const dynamic = 'force-dynamic';

const STATUSES = ['Pending', 'In Progress', 'Under Review', 'Approved', 'Ongoing',
                  'Due soon', 'Delayed', 'On Hold', 'Completed – evidence gap', 'Completed'];
const PHASES = ['Phase 1 – IAUP Readiness', 'Event – IAUP Meeting',
                'Phase 2 – Silver Jubilee', 'Closeout & Care'];

export async function GET(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  try {
    const { slug } = await ctx.params;
    if (!(await linkOpen(slug))) return gone();

    const url = new URL(req.url);
    const qs = (url.searchParams.get('q') || '').trim().slice(0, 80);
    const phase = url.searchParams.get('phase') || '';
    const deptId = url.searchParams.get('dept') || '';
    const status = url.searchParams.get('status') || '';
    const late = url.searchParams.get('late') === '1';
    /* The Overview's "Tasks" and "Sub-tasks" figures both land here. */
    const kind = url.searchParams.get('kind') || '';

    const [all, depts, users] = await Promise.all([
      q(`select * from task_state order by id`),
      q(`select id, name from departments order by name`),
      q(`select id, name from users`),
    ]);

    const name = (id: any) => (users.find((u: any) => u.id === id) || {}).name || '';
    const dept = (id: any) => (depts.find((d: any) => d.id === id) || {}).name || '—';

    const needle = qs.toLowerCase();
    const list = all.filter((t: any) => {
      if (kind === 'task' && !t.is_task) return false;
      if (kind === 'sub' && t.is_task) return false;
      if (phase && t.phase !== phase) return false;
      if (deptId && t.lead_dept_id !== deptId) return false;
      if (status && t.effective_status !== status) return false;
      if (late && !['Delayed', 'Due soon', 'Completed – evidence gap'].includes(t.effective_status)) return false;
      if (needle) {
        const hay = `${t.id} ${t.title} ${t.site || ''} ${name(t.owner_id)}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    }).sort((a: any, b: any) =>
      String(a.id).localeCompare(String(b.id), undefined, { numeric: true }));

    const base = `/c/${encodeURIComponent(slug)}`;
    const opt = (v: string, label: string, cur: string) =>
      `<option value="${esc(v)}" ${cur === v ? 'selected' : ''}>${esc(label)}</option>`;

    const filtered = !!(qs || phase || deptId || status || late || kind);

    const body = `
  <form class="filters" method="get" action="${base}/tasks">
    ${kind ? `<input type="hidden" name="kind" value="${esc(kind)}">` : ''}
    <input type="search" name="q" value="${esc(qs)}" placeholder="Search by ID, title, zone or person…"
           aria-label="Search the register" size="32">
    <select name="phase" aria-label="Phase">
      ${opt('', 'Every phase', phase)}${PHASES.map(p => opt(p, p, phase)).join('')}
    </select>
    <select name="dept" aria-label="Lead department">
      ${opt('', 'Every department', deptId)}
      ${depts.map((d: any) => opt(d.id, d.name, deptId)).join('')}
    </select>
    <select name="status" aria-label="Standing">
      ${opt('', 'Any standing', status)}${STATUSES.map(s => opt(s, s, status)).join('')}
    </select>
    <button type="submit">Show</button>
    ${filtered ? `<a href="${base}/tasks" class="note">Clear</a>` : ''}
  </form>

  <div class="card">
    <h2>${kind === 'task' ? 'Tasks' : kind === 'sub' ? 'Sub-tasks' : 'Task register'}
      — ${list.length}${filtered ? ` of ${all.length}` : ''}</h2>
    ${filtered ? `<p class="note" style="margin:-4px 0 12px">
      ${[kind === 'task' ? 'tasks only' : kind === 'sub' ? 'sub-tasks only' : '',
         status ? `standing: ${status}` : '', phase, deptId ? 'one department' : '',
         late ? 'late, due or missing evidence' : '', qs ? `“${qs}”` : '']
        .filter(Boolean).map(x => esc(x)).join(' · ')}
      · <a href="${base}/tasks">show everything</a></p>` : ''}
    ${list.length ? `<div class="scroll"><table><thead><tr>
      <th>Task</th><th class="ti">Task / Sub-task</th><th class="dp">Lead department</th>
      <th class="who">Responsible</th>
      <th class="n">Deadline</th><th class="stc">Standing</th><th class="n">Done</th>
    </tr></thead><tbody>
    ${list.map((t: any) => {
      const late = Number(t.delay_days) > 0 && t.effective_status === 'Delayed';
      /* The sub-tasks of a task read as a block of their own: a cooler
         ground and a rail at the left edge, exactly as on the main site. */
      const cls = t.parent_id ? 'kid' : `row-${tone(t.effective_status) || 'none'}`;
      return `<tr class="${cls}">
      <td class="id">${priDot(t.priority)}${t.parent_id ? '↳ ' : ''}<a
        href="${base}/t/${encodeURIComponent(t.id)}">${esc(t.id)}</a></td>
      <td class="ti line"><span title="${esc(t.title)}"><a
        href="${base}/t/${encodeURIComponent(t.id)}">${esc(t.title)}</a></span></td>
      <td class="dp">${tagc(dept(t.lead_dept_id) === '—' ? '' : dept(t.lead_dept_id))}</td>
      <td class="who">${face(name(t.owner_id))}</td>
      <td class="dt n">${esc(fmt(t.deadline))}${late
        ? ` <b class="od">${Number(t.delay_days)}d</b>` : ''}</td>
      <td class="stc"><span class="st ${tone(t.effective_status)}">${esc(t.effective_status)}</span></td>
      <td class="n">${pct(t.effective_progress)}</td>
    </tr>`; }).join('')}
    </tbody></table></div>`
    : `<p class="note">No task matches that. <a href="${base}/tasks">Show all ${all.length}</a>.</p>`}
  </div>

  <p class="note">A dot by the task number is its priority — red critical, amber high.
    Open any task to see its dates, what is still missing, the remarks, the Chairman's
    acceptance criteria and the photographs.</p>`;

    return page(shell(slug, 'tasks', 'Task register', body));
  } catch {
    return gone();
  }
}
