import { q, one } from '@/lib/db';
import { esc, fmt, money, pct, tone, bar, shell, page, gone, linkOpen,
         face, priDot } from '@/lib/chairman';

/**
 * The Chairman's link — one task.
 *
 * Everything the project record holds about a piece of work, except the
 * things nobody outside the office should be handed: no email addresses, no
 * telephone numbers, no audit trail of who typed what, and nothing that
 * could change a record. What is still missing before the task can close is
 * said plainly, because that is usually the question being asked.
 */
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, ctx: { params: Promise<{ slug: string; id: string }> }) {
  try {
    const { slug, id } = await ctx.params;
    if (!(await linkOpen(slug))) return gone();

    const t = await one(`select * from task_state where id = $1`, [decodeURIComponent(id)]);
    if (!t) return gone();

    const [subs, photos, budget, roles, depts, users] = await Promise.all([
      q(`select * from task_state where parent_id = $1 order by id`, [t.id]),
      q(`select * from photos where task_id = $1 and deleted_at is null order by kind, taken_at`, [t.id]),
      q(`select * from budget_lines where task_id = $1 order by id`, [t.id]),
      q(`select r.role, d.name from task_roles r join departments d on d.id = r.dept_id
          where r.task_id = $1 and r.role = 'S' order by d.name`, [t.id]),
      q(`select id, name from departments`),
      q(`select id, name from users`),
    ]);

    const name = (uid: any) => (users.find((u: any) => u.id === uid) || {}).name || '';
    const dept = (did: any) => (depts.find((d: any) => d.id === did) || {}).name || '—';
    const base = `/c/${encodeURIComponent(slug)}`;
    const or = (v: any, fallback = '—') => (v === null || v === undefined || v === '') ? fallback : esc(v);

    const gaps: string[] = t.audit_gaps || [];
    const spent = budget.reduce((a: number, b: any) => a + (Number(b.paid) || 0), 0);
    const approved = budget.reduce((a: number, b: any) => a + (Number(b.approved) || 0), 0);

    /* Before, during and after, side by side.
       --------------------------------------------------------------------
       A column for each stage, in the order the work happened, so the three
       can be compared by looking across rather than by scrolling. A stage
       with nothing in it still gets its column and says so — "no after
       photograph yet" is a fact about the work, and hiding the column would
       hide it. */
    const stage = (kind: string, label: string) => {
      const set = photos.filter((p: any) => p.kind === kind);
      if (!set.length)
        return `<div class="stage empty"><h3>${esc(label)}</h3>
          <div class="none">none yet</div></div>`;
      return `<div class="stage"><h3>${esc(label)} — ${set.length}</h3>
        <div class="shots">${set.map((p: any) => `<figure>
          <a href="${esc(p.url)}" target="_blank" rel="noopener noreferrer">
            <img src="${esc(p.thumb_url || p.url)}" alt="${esc(p.caption || label)}" loading="lazy">
          </a>
          <figcaption>${or(p.caption, label)}${p.taken_at
            ? `<span class="when">${esc(fmt(p.taken_at))}</span>` : ''}</figcaption>
        </figure>`).join('')}</div></div>`;
    };

    const body = `
  <p class="crumb"><a href="${base}/tasks">← Task register</a>
    ${t.parent_id ? ` · sub-task of <a href="${base}/t/${encodeURIComponent(t.parent_id)}">${esc(t.parent_id)}</a>` : ''}</p>

  <div class="card">
    <h2 style="font-size:19px; margin-bottom:6px">${esc(t.title)}</h2>
    <p class="note" style="margin:0 0 14px">${esc(t.id)} · ${esc(dept(t.lead_dept_id))}
      ${t.phase ? ` · ${esc(t.phase)}` : ''} · ${esc(t.priority)}</p>
    <p style="margin:0 0 10px">
      <span class="st ${tone(t.effective_status)}">${esc(t.effective_status)}</span>
      ${Number(t.delay_days) > 0 ? ` <span class="note">${Number(t.delay_days)} days late</span>` : ''}
      ${t.continuous ? ' <span class="note">runs until the project ends — no finishing date</span>' : ''}
    </p>
    ${bar(Number(t.effective_progress) || 0)}
    <p class="note" style="margin-top:6px">${pct(t.effective_progress)} complete${
      Number(t.sub_count) ? ` · the average of ${Number(t.sub_count)} sub-tasks` : ''}</p>
  </div>

  ${gaps.length ? `<div class="card" style="border-left:3px solid var(--soon)">
    <h2>Marked complete, but the file is not closed</h2>
    <p class="note" style="margin:0">Still missing: <b>${gaps.map(g => esc(g)).join('</b>, <b>')}</b>.</p>
  </div>` : ''}

  <div class="two">
    <div class="card"><h2>Who and where</h2>
      <table class="kv"><tbody>
        <tr><td>Lead department</td><td>${esc(dept(t.lead_dept_id))}</td></tr>
        <tr><td>Responsible person</td><td>${or(name(t.owner_id), 'not named')}</td></tr>
        <tr><td>Supporting departments</td><td>${roles.length
          ? roles.map((r: any) => esc(r.name)).join(', ') : '—'}</td></tr>
        ${t.support_text ? `<tr><td>Supporting, as written</td><td>${esc(t.support_text)}</td></tr>` : ''}
        <tr><td>Verification by</td><td>${or(name(t.verifier_id), 'not named')}</td></tr>
        <tr><td>Approval by</td><td>${or(name(t.approver_id), 'not named')}</td></tr>
        ${t.verified_by ? `<tr><td>Verified</td><td>${esc(name(t.verified_by))}
          on ${esc(fmt(t.verified_on))}</td></tr>` : ''}
        <tr><td>Approval status</td><td>${or(t.approval_status)}</td></tr>
        <tr><td>Category</td><td>${or(t.category)}</td></tr>
        <tr><td>Site / location</td><td>${or(t.site)}</td></tr>
        <tr><td>Implementation route</td><td>${or(t.route)}</td></tr>
      </tbody></table>
    </div>
    <div class="card"><h2>Dates and money</h2>
      <table class="kv"><tbody>
        <tr><td>Assigned</td><td>${esc(fmt(t.assigned_on))}</td></tr>
        <tr><td>Start</td><td>${esc(fmt(t.start_on))}</td></tr>
        <tr><td>Deadline</td><td>${esc(fmt(t.deadline))}${t.continuous
          ? ' <span class="note">held, not measured</span>' : ''}</td></tr>
        <tr><td>Completed on</td><td>${esc(fmt(t.completed_on))}</td></tr>
        <tr><td>Approved budget</td><td>${money(approved)} BDT</td></tr>
        <tr><td>Paid to date</td><td>${money(spent)} BDT</td></tr>
        ${t.depends_on && t.depends_on.length ? `<tr><td>Waits for</td><td>${
          t.depends_on.map((d: string) =>
            `<a href="${base}/t/${encodeURIComponent(d)}">${esc(d)}</a>`).join(', ')}</td></tr>` : ''}
      </tbody></table>
    </div>
  </div>

  ${t.acceptance || t.remarks || t.evidence_ref || t.evidence_url ? `<div class="card">
    <h2>Notes and evidence</h2>
    ${t.acceptance ? `<p class="note" style="margin:0 0 6px">Acceptance criteria (Chairman)</p>
      <p class="quote">${esc(t.acceptance)}</p>` : ''}
    ${t.remarks ? `<p class="note" style="margin:14px 0 6px">Remarks</p>
      <p class="quote">${esc(t.remarks)}</p>` : ''}
    ${t.evidence_ref ? `<p style="margin:14px 0 0"><span class="note">Evidence reference:</span>
      ${esc(t.evidence_ref)}</p>` : ''}
    ${t.evidence_url ? `<p style="margin:8px 0 0"><span class="note">Evidence link:</span>
      <a href="${esc(t.evidence_url)}" target="_blank" rel="noopener noreferrer">${esc(t.evidence_url)}</a></p>` : ''}
  </div>` : ''}

  ${photos.length ? `<div class="card">
    <h2>Photographs — ${photos.length}</h2>
    <div class="stages">
      ${stage('before', 'Before')}${stage('progress', 'In progress')}${stage('after', 'After')}
    </div>
    <p class="note" style="margin:14px 0 0">Taken on site. Click any photograph to see it
      full size.</p>
  </div>` : t.photos_required ? `<div class="card">
    <h2>Photographs</h2><p class="note" style="margin:0">This task cannot close without them,
    and none has been attached yet.</p></div>` : ''}

  ${subs.length ? `<div class="card">
    <h2>Sub-tasks — ${subs.length}</h2>
    <div class="scroll"><table><thead><tr><th>Task</th><th>Task / Sub-task</th>
      <th>Responsible</th><th class="n">Deadline</th><th>Standing</th><th class="n">Done</th>
    </tr></thead><tbody>
    ${subs.map((s: any) => `<tr>
      <td class="id">${priDot(s.priority)}<a href="${base}/t/${encodeURIComponent(s.id)}">${esc(s.id)}</a></td>
      <td class="ti line"><span title="${esc(s.title)}"><a
        href="${base}/t/${encodeURIComponent(s.id)}">${esc(s.title)}</a></span></td>
      <td class="who">${face(name(s.owner_id))}</td>
      <td class="dt n">${esc(fmt(s.deadline))}</td>
      <td><span class="st ${tone(s.effective_status)}">${esc(s.effective_status)}</span></td>
      <td class="n">${pct(s.effective_progress)}</td>
    </tr>`).join('')}
    </tbody></table></div>
  </div>` : ''}

  ${budget.length ? `<div class="card">
    <h2>Budget lines — ${budget.length}</h2>
    <div class="scroll"><table><thead><tr><th>Line</th><th>Item</th><th>Unit</th>
      <th class="n">Qty</th><th class="n">Approved</th><th class="n">Paid</th>
    </tr></thead><tbody>
    ${budget.map((b: any) => `<tr><td class="id">${esc(b.id)}</td>
      <td class="ti">${esc(b.item)}</td><td>${or(b.unit)}</td>
      <td class="n">${b.qty === null ? '—' : esc(b.qty)}</td>
      <td class="n">${money(b.approved)}</td><td class="n">${money(b.paid)}</td></tr>`).join('')}
    </tbody></table></div>
  </div>` : ''}`;

    return page(shell(slug, 'tasks', `${t.id} — ${t.title}`, body));
  } catch {
    return gone();
  }
}
