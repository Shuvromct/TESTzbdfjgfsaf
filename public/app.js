/* DIU Campus Legacy 25 — Implementation and Monitoring
   ---------------------------------------------------------------------------
   One file, served static and cached for good; the URL carries the deployment
   id, so a new build is a new URL and a returning browser never asks for the
   old one.

   Everything it knows arrives from GET /api/state in one request — the whole
   project is a few hundred kilobytes, which is small enough that filtering,
   sorting and counting happen here with no further round trip. Everything it
   changes goes back one field at a time, because four people have business
   with the same task and whole-record saves would have them overwriting one
   another.
*/

/* ------------------------------------------------------------------ state */
const DB = {
  me: null, users: [], departments: [], tasks: [], taskRoles: [], budget: [],
  approvals: [], milestones: [], photos: [], survey: [], teams: [],
  studentDays: [], activity: [], steps: [], reference: [], settings: {}, roles: [],
  siteLock: { on: false, msg: '' },
};
const S = {
  view: 'home', taskId: null, tab: 'overview', user: null, sessionId: null,
  q: '', phase: 'All', dept: 'All', mine: false, late: false,
  sort: 'id', group: 'none', tlSpan: 'near', tlShut: [],
  locked: false, lockMessage: '', bootError: '',
};


/* ------------------------------------------------------- what you may do */
/* Three questions, asked everywhere. The answers come from the server with
   the rest of the state; the server asks them again before it writes, so
   hiding a button here is a courtesy, never the control. */
const SEE   = sec => ((DB.me && DB.me.sections) || []).includes(sec);
const MAY   = sec => (((DB.me && DB.me.perms) || {})[sec]) === 'edit';
const KEEPER = () => !!(DB.me && DB.me.keeper);


/* ------------------------------------------------------------ categories */
/* The twenty-six the register already uses, offered as a list so the
   twenty-seventh spelling of "Heritage" never gets invented. Anything
   genuinely new goes in through Other, and is in the list from then on
   because the list is read from the register itself. */
const CATEGORIES = [
  'Academic', 'Buildings', 'Cleaning', 'Closeout', 'Communications', 'Design',
  'Engineering', 'Events', 'Finance', 'Governance', 'Heritage', 'IAUP gallery',
  'Landscape', 'Legacy', 'Maintenance', 'Murals', 'Procurement', 'Readiness',
  'Review', 'Safety', 'Security', 'Site control', 'Sponsorship', 'Student teams',
  'Survey', 'Wayfinding',
];

const OTHER = '__other__';

function categoryList() {
  const used = DB.tasks.map(t => t.category).filter(Boolean);
  return [...new Set([...CATEGORIES, ...used])].sort((a, b) => a.localeCompare(b));
}

function categoryOptions(current) {
  const list = categoryList();
  if (current && !list.includes(current)) list.unshift(current);
  return [['', '— none —']].concat(list.map(c => [c, c])).concat([[OTHER, 'Other…']]);
}

/* Choosing Other turns the list into a box to type in. */
function categoryPicked(sel) {
  if (sel.value !== OTHER) return;
  const box = document.createElement('input');
  box.name = sel.name; box.placeholder = 'Name the new category'; box.value = '';
  sel.replaceWith(box);
  box.focus();
}

/* ---------------------------------------------------------------- helpers */
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const by = (a, k) => a.find(x => x.id === k) || null;
const task = id => by(DB.tasks, id);
const userName = id => (by(DB.users, id) || {}).name || '—';
const deptName = id => (by(DB.departments, id) || {}).name || '—';

/* Today in Dhaka, not today in Greenwich. toISOString() gives the UTC date,
   which is yesterday's from six in the evening — so a date stamped on an
   evening's work went in a day early. 'en-CA' is the locale that formats a
   date as YYYY-MM-DD, which is what the database wants. */
const ZONE = 'Asia/Dhaka';
const TODAY = () => new Date().toLocaleDateString('en-CA', { timeZone: ZONE });
/* A deadline is a day, not a moment. The server sends it as 'YYYY-MM-DD'
   (see lib/db.ts) and it is read as three numbers rather than turned into a
   Date, because a Date carries a zone and the zone can move it to the day
   before — which is how a deadline of the 7th came to be written as the 6th. */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function fmtDate(d) {
  if (!d) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d));
  if (m) return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1].slice(2)}`;
  const x = new Date(d);
  if (isNaN(x)) return esc(String(d).slice(0, 10));
  return x.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' });
}
function fmtWhen(d) {
  if (!d) return '—';
  const x = new Date(d);
  const mins = Math.round((Date.now() - x) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)} h ago`;
  if (mins < 60 * 24 * 7) return `${Math.round(mins / 1440)} d ago`;
  return x.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}
const money = n => (n === null || n === undefined || n === '') ? '—'
  : Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
const pct = n => `${Math.round((Number(n) || 0) * 100)}%`;

/* the status word decides the colour everywhere, so it is worked out once */
const statusClass = s => ({
  'Delayed': 'st-late', 'Due soon': 'st-soon', 'Completed': 'st-done',
  'Completed – evidence gap': 'st-gap', 'In Progress': 'st-prog',
  'Under Review': 'st-rev', 'Approved': 'st-appr', 'On Hold': 'st-hold',
  'Pending': 'st-pend', 'Ongoing': 'st-cont',
}[s] || 'st-pend');

function toast(msg, bad) {
  const t = $('toasts'); if (!t) return;
  const d = document.createElement('div');
  d.className = 'toast' + (bad ? ' bad' : '');
  d.textContent = msg;
  t.appendChild(d);
  setTimeout(() => { d.classList.add('out'); setTimeout(() => d.remove(), 400); }, bad ? 6000 : 3000);
}

/** Who the signed-in person is to this task. Decides what the screen offers. */
/* Being named on a task is a permission of its own — the server says so in
   writableTask() — and the lead department is one of the four chairs: anyone
   in the department that leads the work may move the work along. */
const onLeadDept = t => !!(t && DB.me && DB.me.deptId && t.leadDeptId
                           && t.leadDeptId === DB.me.deptId);
function myPart(t) {
  if (!t || !DB.me) return 'none';
  if (KEEPER()) return 'boss';
  if (t.ownerId === DB.me.id) return 'owner';
  /* Verifier and approver first, so somebody who is both in the lead
     department and the named verifier is still offered the sign-off. */
  if (t.verifierId === DB.me.id) return 'verifier';
  if (t.approverId === DB.me.id) return 'approver';
  if (onLeadDept(t)) return 'owner';
  return 'none';
}
/* The work's own fields: the responsible person, the lead department, or a
   role that may act on other people's records. */
const canEdit = t => KEEPER() || (!!t && !!DB.me && t.ownerId === DB.me.id) || onLeadDept(t);

/* -------------------------------------------------------------------- api */
async function api(path, method, body) {
  const r = await fetch('/api/state' + path, {
    method: method || 'GET',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  if (r.status === 401) { S.user = null; go('login'); throw new Error('signed out'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    /* The server often says more than a sentence — which tasks are holding
       an account, for instance. Thrown away, that detail would have to be
       fetched again or guessed at, so it travels on the error. */
    const e = new Error(j.error || 'The server refused that change.');
    e.detail = j;
    throw e;
  }
  return j;
}

/**
 * Pull the whole project down. False when nobody is signed in.
 *
 * Anything else that goes wrong is put in S.bootError and shown. It used to be
 * swallowed, which meant a server error and a missing session looked identical
 * from here: the Sign in button simply did nothing, and said nothing.
 */
async function boot() {
  let d;
  S.bootError = '';
  try {
    const r = await fetch('/api/state', { credentials: 'same-origin' });
    if (r.status === 401) return false;
    d = await r.json().catch(() => ({ error: `The server replied ${r.status}.` }));
    if (d.error) { S.bootError = d.error; return false; }
  } catch (e) {
    S.bootError = 'The server could not be reached.';
    return false;
  }

  DB.me = d.me; S.user = d.me;
  S.locked = !!d.locked; S.lockMessage = d.lockMessage || '';
  ['users', 'departments', 'tasks', 'taskRoles', 'budget', 'approvals', 'milestones',
   'photos', 'survey', 'teams', 'studentDays', 'activity', 'steps', 'reference', 'roles']
    .forEach(k => { DB[k] = d[k] || []; });
  DB.settings = d.settings || {};
  DB.siteLock = d.siteLock || { on: false, msg: '' };
  return true;
}

/** One task back from the server, slotted into place. */
function putTask(t) {
  const i = DB.tasks.findIndex(x => x.id === t.id);
  const mapped = {
    id: t.id, parentId: t.parent_id ?? t.parentId, title: t.title, category: t.category,
    phase: t.phase, route: t.route, priority: t.priority, site: t.site,
    leadDeptId: t.lead_dept_id ?? t.leadDeptId, ownerId: t.owner_id ?? t.ownerId,
    verifierId: t.verifier_id ?? t.verifierId, approverId: t.approver_id ?? t.approverId,
    assignedOn: t.assigned_on ?? t.assignedOn, startOn: t.start_on ?? t.startOn,
    deadline: t.deadline, completedOn: t.completed_on ?? t.completedOn,
    status: t.status, progress: Number(t.progress),
    approvalStatus: t.approval_status ?? t.approvalStatus,
    photosRequired: t.photos_required ?? t.photosRequired,
    evidenceRef: t.evidence_ref ?? t.evidenceRef, evidenceUrl: t.evidence_url ?? t.evidenceUrl,
    acceptance: t.acceptance, remarks: t.remarks,
    verifiedBy: t.verified_by ?? t.verifiedBy, verifiedOn: t.verified_on ?? t.verifiedOn,
    dependsOn: t.depends_on ?? t.dependsOn ?? [],
    supportText: t.support_text ?? t.supportText ?? '',
    continuous: !!(t.continuous ?? false),
    isTask: t.is_task ?? t.isTask, subCount: Number(t.sub_count ?? t.subCount ?? 0),
    effectiveProgress: Number(t.effective_progress ?? t.effectiveProgress ?? t.progress),
    daysToDeadline: t.days_to_deadline ?? t.daysToDeadline,
    delayDays: Number(t.delay_days ?? t.delayDays ?? 0),
    auditGaps: t.audit_gaps ?? t.auditGaps ?? [],
    auditComplete: t.audit_complete ?? t.auditComplete,
    openWarning: t.open_warning ?? t.openWarning,
    effectiveStatus: t.effective_status ?? t.effectiveStatus ?? t.status,
    durationDays: Number(t.duration_days ?? t.durationDays ?? 0),
    budget: Number(t.budget ?? 0), spent: Number(t.spent ?? 0),
    updatedAt: t.updated_at ?? t.updatedAt,
  };
  if (i >= 0) DB.tasks[i] = mapped; else DB.tasks.push(mapped);
  return mapped;
}


/* ------------------------------------------------------------------ forms */
/* One dialog, used everywhere a prompt() used to be. <dialog> is the browser's
   own — it traps focus, closes on Escape and needs no library. A field is
   {k, label, type, options, value, hint}; save gets an object of the values. */
let _formSave = null;
/* ================================================= a list you can type at =
   A box that shows the chosen name, and a list under it that narrows on any
   part of what is typed — "rahman" finds Mizanur Rahman, "mct" finds the
   department. The real value is kept in a hidden input, so everything that
   reads a form goes on reading it the same way.

   Built rather than borrowed from the browser: <datalist> matches from the
   start of the text in some browsers and anywhere in others, and it hands
   back the label rather than the id, which is the wrong half of the pair. */
function combo(f, v) {
  const opts = (f.options || []).map(x => Array.isArray(x) ? x : [x, x]);
  const chosen = opts.find(o => String(o[0]) === String(v));
  return `<label>${esc(f.label)}</label>
    <div class="combo" data-for="${f.k}">
      <input type="hidden" name="${f.k}" value="${esc(v)}">
      <input type="text" class="comboq" autocomplete="off" spellcheck="false"
        placeholder="${esc(f.hint || 'Type to search…')}"
        value="${esc(chosen ? chosen[1] : '')}"
        oninput="comboType(this)" onclick="comboOpen(this)" onfocus="this.select()"
        onkeydown="comboKey(event,this)">
      <button type="button" class="combox" tabindex="-1" title="Clear"
        onclick="comboClear(this)">×</button>
      <div class="combolist" hidden>${opts.map(([val, lab]) =>
        `<button type="button" class="comboitem${String(val) === String(v) ? ' on' : ''}"
           data-val="${esc(val)}" onclick="comboPick(this)">${esc(lab)}</button>`).join('')}</div>
    </div>`;
}

const comboBox = el => el.closest('.combo');
const comboItems = box => [...box.querySelectorAll('.comboitem')];

/* Opened by a click, by typing, or by the down arrow — not by focus.
   -------------------------------------------------------------------------
   Focus fires when a dialog puts the cursor in its first field, and the click
   that opened the dialog was still travelling up to the document, where the
   handler that shuts stray lists closed it again. Tabbing through a form
   popping a list open at every field was no better. */
function comboOpen(el) {
  const box = comboBox(el);
  /* The whole list, not the one thing already chosen.
     ---------------------------------------------------------------------
     Filtering on the text already in the box meant clicking into a filled
     field showed one row — the name that was there — and changing your mind
     meant clearing the box first. Opening shows everything; the text is
     selected, so typing still replaces it in one go. */
  for (const it of comboItems(box)) it.hidden = false;
  const list = box.querySelector('.combolist');
  list.hidden = false;
  list.classList.remove('empty');
  place(el, list);
  const on = box.querySelector('.comboitem.on');
  if (on) on.scrollIntoView({ block: 'nearest' });
  el.select();
}

/**
 * Where the list goes.
 *
 * Inside the dialog it was cut off by the dialog's own edge — a field near
 * the bottom of a short form opened a list nobody could see or click. So the
 * list is taken out of the flow and put at the field's place on the screen,
 * which no ancestor can clip, and flipped above the field when there is more
 * room up than down.
 */
function place(el, list) {
  const r = el.getBoundingClientRect();
  const below = window.innerHeight - r.bottom - 8;
  const above = r.top - 8;
  const up = below < 160 && above > below;
  list.style.width = r.width + 'px';
  list.style.left = r.left + 'px';
  list.style.maxHeight = Math.max(120, Math.min(248, up ? above : below)) + 'px';
  if (up) { list.style.top = 'auto'; list.style.bottom = (window.innerHeight - r.top + 3) + 'px'; }
  else { list.style.bottom = 'auto'; list.style.top = (r.bottom + 3) + 'px'; }
}

/** Any part of the name, in any case. Nothing else is cleverer than that. */
function comboType(el) {
  const box = comboBox(el);
  const want = el.value.trim().toLowerCase();
  let shown = 0;
  for (const it of comboItems(box)) {
    const hit = !want || it.textContent.toLowerCase().includes(want);
    it.hidden = !hit;
    it.classList.remove('here');
    if (hit) shown++;
  }
  const list = box.querySelector('.combolist');
  list.hidden = false;
  place(el, list);
  list.classList.toggle('empty', shown === 0);
  /* Typing is choosing: a box left holding a name the person has edited into
     something that matches nothing must not quietly keep the old value. */
  const exact = comboItems(box).find(it =>
    it.textContent.trim().toLowerCase() === want && want);
  if (exact) box.querySelector('input[type=hidden]').value = exact.dataset.val;
  else if (!want) box.querySelector('input[type=hidden]').value = '';
}

function comboPick(btn) {
  const box = comboBox(btn);
  /* "Other…" is not a value, it is a request to type one. The dropdown
     turned itself into a text box for that; so does this. */
  if (btn.dataset.val === OTHER) {
    const name = box.dataset.for;
    const fresh = document.createElement('input');
    fresh.name = name;
    fresh.placeholder = 'Name the new category';
    box.replaceWith(fresh);
    fresh.focus();
    return;
  }
  box.querySelector('input[type=hidden]').value = btn.dataset.val;
  box.querySelector('.comboq').value = btn.textContent.trim();
  comboItems(box).forEach(i => i.classList.toggle('on', i === btn));
  box.querySelector('.combolist').hidden = true;
}

function comboClear(btn) {
  const box = comboBox(btn);
  box.querySelector('input[type=hidden]').value = '';
  const q = box.querySelector('.comboq');
  q.value = '';
  comboItems(box).forEach(i => { i.hidden = false; i.classList.remove('on'); });
  q.focus();
}

/* Up, down, Enter and Escape, because a field you have to reach for the mouse
   to finish is slower than the dropdown it replaced. */
function comboKey(e, el) {
  const box = comboBox(el);
  const list = box.querySelector('.combolist');
  const live = comboItems(box).filter(i => !i.hidden);
  const at = live.findIndex(i => i.classList.contains('here'));

  if (e.key === 'Escape') { list.hidden = true; return; }
  if (e.key === 'Enter') {
    if (!list.hidden && live.length) {
      e.preventDefault();
      comboPick(live[at >= 0 ? at : 0]);
    }
    return;
  }
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  e.preventDefault();
  list.hidden = false;
  if (!live.length) return;
  const next = e.key === 'ArrowDown'
    ? (at < 0 ? 0 : Math.min(at + 1, live.length - 1))
    : (at <= 0 ? 0 : at - 1);
  live.forEach(i => i.classList.remove('here'));
  live[next].classList.add('here');
  live[next].scrollIntoView({ block: 'nearest' });
}

/* A click anywhere else shuts any list that is open. */
document.addEventListener('click', (e) => {
  for (const box of document.querySelectorAll('.combo')) {
    if (!box.contains(e.target)) box.querySelector('.combolist').hidden = true;
  }
});

function form(title, fields, onSave, opts) {
  const o = opts || {};
  const row = f => {
    const v = f.value === undefined || f.value === null ? '' : f.value;
    if (f.type === 'select') {
      const hasOther = (f.options || []).some(x => (Array.isArray(x) ? x[0] : x) === OTHER);
      /* A long list is typed at, not scrolled through.
         -------------------------------------------------------------------
         Fifty-five people and twenty-two departments in a native dropdown
         means scrolling a window eight rows tall looking for a name you
         already know — and the browser's own type-ahead only matches the
         first letters, so "Rahman" finds nothing. Past a dozen options the
         field becomes a box you type into and a list that narrows on any
         part of the name. Short lists are left alone: a search box over four
         statuses is slower than the dropdown it replaced. */
      if ((f.options || []).length > 12) return combo(f, v);
      return `<label>${esc(f.label)}</label>
      <select name="${f.k}" ${hasOther ? 'onchange="categoryPicked(this)"' : ''}
        >${(f.options || []).map(x => {
        const [val, lab] = Array.isArray(x) ? x : [x, x];
        return `<option value="${esc(val)}" ${String(val) === String(v) ? 'selected' : ''}>${esc(lab)}</option>`;
      }).join('')}</select>`;
    }
    if (f.type === 'textarea') return `<label>${esc(f.label)}</label>
      <textarea name="${f.k}" rows="3">${esc(v)}</textarea>`;
    if (f.type === 'checkbox') return `<label class="chk">
      <input type="checkbox" name="${f.k}" ${v ? 'checked' : ''}> ${esc(f.label)}</label>`;
    /* A set of ticks that reads back as a list. A dropdown cannot say "this
       person is the administrator and also signs off for others", and a
       second dropdown for a second role is a worse lie than the first. */
    if (f.type === 'tickset') {
      const on = Array.isArray(v) ? v.map(String) : (v ? [String(v)] : []);
      return `<label>${esc(f.label)}</label>
        <div class="tickset" data-set="${f.k}">${(f.options || []).map(x => {
          const [val, lab, hint] = Array.isArray(x) ? x : [x, x, ''];
          return `<label class="chk"><input type="checkbox" data-of="${f.k}"
            value="${esc(val)}" ${on.includes(String(val)) ? 'checked' : ''}>
            <span>${esc(lab)}${hint ? `<em class="small">${esc(hint)}</em>` : ''}</span></label>`;
        }).join('')}</div>
        ${f.hint ? `<p class="small">${esc(f.hint)}</p>` : ''}`;
    }
    return `<label>${esc(f.label)}</label>
      <input name="${f.k}" type="${f.type || 'text'}" value="${esc(v)}"
             ${f.required ? 'required' : ''} ${f.step ? `step="${f.step}"` : ''}
             placeholder="${esc(f.hint || '')}">`;
  };
  const d = document.createElement('dialog');
  /* A form long enough to need scrolling on a laptop is given a second
     column instead. Fifteen fields in a 520px slot meant the person could
     not see the dates and the people at once; the CSS puts it back to one
     column below 700px. Prose fields span both. */
  const wide = o.wide !== undefined ? o.wide : fields.length >= 8;
  d.className = 'modal' + (wide ? ' wide' : '');
  d.innerHTML = `<form method="dialog">
    <h2>${esc(title)}</h2>
    ${o.note ? `<p class="small">${esc(o.note)}</p>` : ''}
    ${o.html || ''}
    <div class="fields">${fields.map(f =>
      `<div class="field${f.type === 'textarea' || f.full ? ' full' : ''}">${row(f)}</div>`).join('')}</div>
    <div class="err" id="formerr"></div>
    <div class="btns end">
      <button value="cancel" type="button" class="ghost">Cancel</button>
      <button value="ok" type="button" class="${o.danger ? 'danger' : 'primary'}"
        >${esc(o.ok || 'Save')}</button>
    </div></form>`;
  document.body.appendChild(d);

  /* The save runs before the dialog closes, not after.
     -----------------------------------------------------------------------
     `method="dialog"` shuts the dialog the moment the button is pressed, and
     the handler ran on `close` — by which time the form and everything typed
     into it were already gone. A refused save therefore cost the person the
     whole form: a duplicate task ID, a verifier who is also the owner, a
     date the server would not take, and twelve fields had to be typed again.

     So the button no longer closes anything. It saves; the dialog closes
     only once the server has agreed, and a refusal is shown inside the form
     with every field as it was left. */
  const err = d.querySelector('#formerr');
  const okBtn = d.querySelector('button[value="ok"]');
  const cancelBtn = d.querySelector('button[value="cancel"]');
  const formEl = d.querySelector('form');

  const read = () => {
    const out = {};
    fields.forEach(f => {
      if (f.type === 'tickset') {
        out[f.k] = [...d.querySelectorAll(`[data-of="${f.k}"]:checked`)].map(e => e.value);
        return;
      }
      const el = d.querySelector(`[name="${f.k}"]`);
      if (el) out[f.k] = f.type === 'checkbox' ? el.checked : el.value;
    });
    return out;
  };

  const shut = () => { d.close(); d.remove(); };

  cancelBtn.addEventListener('click', e => { e.preventDefault(); shut(); });

  okBtn.addEventListener('click', async (e) => {
    e.preventDefault();
    /* The browser's own required-field check, asked for rather than
       triggered by a submit — which is what used to block Cancel too. */
    if (!formEl.reportValidity()) return;
    err.textContent = '';
    okBtn.disabled = true;
    const was = okBtn.textContent;
    okBtn.textContent = 'Saving…';
    try {
      await onSave(read());
      shut();
    } catch (ex) {
      err.textContent = ex && ex.message ? ex.message : 'That could not be saved.';
      /* A refusal that names things worth clicking says so in its own
         markup — the links are the useful part, not the sentence. */
      if (ex && ex.detail && typeof o.explain === 'function') {
        const more = o.explain(ex.detail);
        if (more) err.innerHTML = esc(ex.message) + more;
      }
      err.scrollIntoView({ block: 'nearest' });
    } finally {
      okBtn.disabled = false;
      okBtn.textContent = was;
    }
  });

  /* Escape still closes, and takes nothing with it but the dialog. */
  d.addEventListener('cancel', () => { d.remove(); });
  d.showModal();
  const first = d.querySelector('.fields input, .fields select, .fields textarea');
  if (first) first.focus();
}

/* A dialog that shows something rather than asking for it.
   ---------------------------------------------------------------------------
   The Dashboard's figures were dead ends: a card said eighteen were delayed
   and gave no way to find out which eighteen. Every count on the page now
   opens its own list here, over the page rather than instead of it, so the
   Dashboard is not lost on the way. */
function panel(title, html, sub) {
  const d = document.createElement('dialog');
  d.className = 'modal wide panel';
  d.innerHTML = `<form method="dialog">
    <h2>${esc(title)}</h2>
    ${sub ? `<p class="small">${esc(sub)}</p>` : ''}
    <div class="fields">${html}</div>
    <div class="btns end"><button value="ok" type="button" class="primary">Close</button></div>
  </form>`;
  document.body.appendChild(d);
  const shut = () => { d.close(); d.remove(); };
  const ok = d.querySelector('button[value="ok"]');
  ok.addEventListener('click', e => { e.preventDefault(); shut(); });
  d.addEventListener('cancel', () => { d.remove(); });
  /* Following a task from the list should leave the dialog behind, not open
     the page underneath it. */
  d.addEventListener('click', e => {
    if (e.target.closest('a[href], tbody tr')) setTimeout(shut, 0);
  });
  d.showModal();
  ok.focus();
  /* The labels inside are a table like any other, and on a phone it stacks. */
  labelCells();
}

/** Everyone who could be given something to do. */
const peopleOptions = (blank) => [[blank === undefined ? '' : blank, '— nobody —']]
  .concat(DB.users.filter(u => u.active)
    .map(u => [u.id, u.name + (u.deptId ? ` · ${deptName(u.deptId)}` : '')]));
const deptOptions = () => [['', '— none —']].concat(DB.departments.map(d => [d.id, d.name]));
const PHASES = ['', 'Phase 1 – IAUP Readiness', 'Event – IAUP Meeting',
                'Phase 2 – Silver Jubilee', 'Closeout & Care'];
const ROUTES = ['', 'Recommended Intervention', 'Student-Led Creative Project',
                'Mixed', 'Management / Approval'];
const PRIORITIES = ['P0 – Critical', 'P1 – High', 'P2 – Medium'];
const STATUSES = ['Pending', 'In Progress', 'Under Review', 'Approved', 'Completed', 'On Hold'];
const APPROVALS = ['Not required', 'Pending', 'Submitted', 'Approved',
                   'Approved with conditions', 'Returned', 'Rejected'];

/* --------------------------------------------------------------- routing */
/* Every section has its own address, so the Back button works, a reload lands
   where it left off, and a colleague can be sent a link to one task instead of
   "open the site, then Tasks, then search for CL25-07".

   Anything that would otherwise be a 404 is rewritten to this page by
   next.config.mjs, which is what makes a refresh on /tasks/CL25-07 work. */
const PATHS = {
  home: '', dashboard: 'dashboard', tasks: 'tasks', gantt: 'timeline',
  matrix: 'matrix', queue: 'your-approvals', pending: 'pending-approvals',
  approvals: 'decisions', budget: 'budget', gates: 'gates',
  survey: 'zones', students: 'students', dept: 'departments',
  reference: 'chairman', activity: 'log', people: 'people', password: 'password',
  admin: 'admin',
};
const VIEW_OF = Object.fromEntries(Object.entries(PATHS).map(([k, v]) => [v, k]));

/* The decisions register answered to /approvals until the task approval
   queues arrived and the two names started meaning different things. Links
   already sent out still work. */
const OLD_PATHS = { approvals: 'approvals' };

/** Which views each filter belongs to — a filter only reaches the address
    bar of a page that actually uses it. */
const USES = {
  phase: ['tasks', 'dashboard', 'matrix', 'gantt'],
  dept:  ['tasks', 'dept'],
  q:     ['tasks'],
  mine:  ['tasks'],
  late:  ['tasks'],
  sort:  ['tasks'],
  group: ['tasks'],
  tlSpan: ['gantt'],
};

function hrefFor(view, taskId) {
  if (view === 'task') return `/tasks/${encodeURIComponent(taskId || S.taskId || '')}`;
  return `/${PATHS[view] ?? ''}`;
}

/** The address this state should be showing. */
function currentUrl() {
  const path = S.view === 'task' ? hrefFor('task') : hrefFor(S.view);
  const p = new URLSearchParams();
  if (S.view === 'task' && S.tab && S.tab !== 'overview') p.set('tab', S.tab);
  if (USES.q.includes(S.view) && S.q) p.set('q', S.q);
  if (USES.phase.includes(S.view) && S.phase !== 'All') p.set('phase', S.phase);
  if (USES.dept.includes(S.view) && S.dept !== 'All') p.set('dept', S.dept);
  if (USES.mine.includes(S.view) && S.mine) p.set('mine', '1');
  if (USES.late.includes(S.view) && S.late) p.set('late', '1');
  if (USES.sort.includes(S.view) && S.sort !== 'id') p.set('sort', S.sort);
  if (USES.group.includes(S.view) && S.group !== 'none') p.set('group', S.group);
  if (USES.tlSpan.includes(S.view) && S.tlSpan !== 'near') p.set('span', S.tlSpan);
  const qs = p.toString();
  return path + (qs ? `?${qs}` : '');
}

/** The state this address is asking for. The URL wins, not what was on screen. */
function readUrl() {
  const parts = location.pathname.replace(/^\/+|\/+$/g, '').split('/');
  const p = new URLSearchParams(location.search);
  if (parts[0] === 'tasks' && parts[1]) {
    S.view = 'task';
    S.taskId = decodeURIComponent(parts[1]);
    S.tab = ['overview', 'photos', 'budget', 'approvals', 'subs', 'history']
      .includes(p.get('tab')) ? p.get('tab') : 'overview';
  } else {
    S.view = VIEW_OF[parts[0] ?? ''] ?? OLD_PATHS[parts[0] ?? ''] ?? 'home';
    S.taskId = null;
  }
  S.q = p.get('q') || '';
  S.phase = p.get('phase') || 'All';
  S.dept = p.get('dept') || 'All';
  S.mine = p.get('mine') === '1';
  S.late = p.get('late') === '1';
  S.sort = SORTS[p.get('sort')] ? p.get('sort') : 'id';
  S.group = GROUPS[p.get('group')] ? p.get('group') : 'none';
  S.tlSpan = p.get('span') === 'full' ? 'full' : 'near';
}

const here = () => location.pathname + location.search;

function go(view, opts) {
  S.view = view;
  if (opts) Object.assign(S, opts);
  if (view !== 'task') S.taskId = null;
  saveBeforeLeaving();            /* anything half-typed goes now, not later */
  closeNav();                     /* the drawer slid over the page; put it back */
  const url = currentUrl();
  if (url !== here()) history.pushState(null, '', url);
  window.scrollTo(0, 0);
  render();
}

/* A filter change replaces the entry instead of adding one. Otherwise every
   letter typed into the search box would be its own step back. */
function setFilter(patch) {
  Object.assign(S, patch);
  history.replaceState(null, '', currentUrl());
  render();
}

/* A link with a real href can be opened in a new tab, copied, and read by a
   screen reader. A plain left click is still handled here, without a reload. */
function nav(e, view, opts) {
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button > 0) return true;
  e.preventDefault();
  go(view, opts);
  return false;
}

window.addEventListener('popstate', () => {
  if (!S.user) return;
  readUrl();
  closeNav();
  render();
});

/* Escape closes the drawer, the same key that closes every dialog. */
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && document.body.classList.contains('navopen')) closeNav();
});

/** Where "/" goes for this person. Home for the administrator, the
    Dashboard for everybody else — or the first section they can reach, if
    their role cannot open the Dashboard either. */
function landing() {
  if (DB.me && DB.me.role === 'ADMIN') return 'home';
  if (SEE('reports')) return 'dashboard';
  const first = navItems().find(x => x[0] !== 'home');
  return first ? first[0] : 'tasks';
}

function render() {
  const app = $('app'); if (!app) return;
  if (!S.user) { app.innerHTML = loginView(); return; }
  /* A password somebody else chose is a password somebody else knows. Until it
     is changed there is nothing else to look at. */
  if (DB.me.mustChange || S.view === 'password') { app.innerHTML = passwordView(); return; }
  if (S.locked) { app.innerHTML = lockedView(); return; }
  /* "/" means Home, and Home is the administrator's. Anybody else who asks
     for it — by signing in, by the logo, by a bookmark — gets the page they
     do have, and the address bar says so. */
  if (S.view === 'home' && DB.me.role !== 'ADMIN') {
    S.view = landing();
    if (S.view === 'home') S.view = 'tasks';
    history.replaceState(null, '', currentUrl());
  }
  const v = {
    home: homeView, dashboard: dashboardView, tasks: tasksView, task: taskView,
    budget: budgetView, approvals: approvalsView, gates: gatesView, people: peopleView,
    queue: queueView, pending: pendingView,
    activity: activityView, survey: surveyView, matrix: matrixView, gantt: ganttView,
    students: studentsView, dept: deptView, reference: referenceView,
    admin: adminView,
  }[S.view] || homeView;
  app.innerHTML = v();
  labelCells();
  /* The page's one main region, named, so a screen reader and the skip link
     have somewhere to go. Set here rather than in fifteen view functions. */
  const w = app.querySelector('.wrap');
  if (w) { w.id = 'main'; w.setAttribute('role', 'main'); w.setAttribute('tabindex', '-1'); }
}

/* Below 700px a wide table is stacked one row per block, and each cell has to
   say which column it came from — the header row is gone. The header row
   already knows the answer, so nothing has to be written into fourteen views.
   The register, the matrix and the timeline keep their shape: the first has a
   layout of its own, and the other two are pictures, not lists. */
const STACKED = 'table.grid:not(.tasks):not(.matrix):not(.gantt)';
function labelCells() {
  const narrow = window.matchMedia('(max-width: 700px)').matches;
  for (const t of document.querySelectorAll(STACKED)) {
    if (!narrow) { t.classList.remove('stack'); continue; }
    /* Some tables carry no header row — the decision list and the activity
       log read as sentences. Those stack too, just without the labels. */
    const heads = [...t.querySelectorAll('thead th')].map(th => th.textContent.trim());
    if (heads.length) {
      for (const tr of t.querySelectorAll('tbody tr')) {
        [...tr.children].forEach((td, i) => {
          if (heads[i]) td.setAttribute('data-label', heads[i]);
        });
      }
    }
    t.classList.add('stack');
  }
}

/* Turning the phone sideways, or dragging a window narrow, crosses the same
   line. Re-label rather than re-render: the page keeps its scroll and focus. */
let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(labelCells, 150);
});

/* ----------------------------------------------------------------- login */
function loginView() {
  return `<div class="auth">
    <div class="card authcard">
      <div class="brand"><span class="dot"></span> DIU Campus Legacy 25</div>
      <p class="small">Project DIU-CL25-2026 · Implementation and Monitoring</p>
      <form onsubmit="doLogin(event)">
        <label>Email</label>
        <input id="email" type="email" autocomplete="username" required placeholder="name@diu.edu.bd">
        <label>Password</label>
        <input id="pw" type="password" autocomplete="current-password" required>
        <div id="loginerr" class="err"></div>
        <button class="primary wide" type="submit">Sign in</button>
      </form>
    </div>
  </div>`;
}

async function doLogin(e) {
  e.preventDefault();
  const err = $('loginerr'); err.textContent = '';
  const ua = navigator.userAgent;
  const device = {
    deviceId: localStorage.getItem('cl25.device') || (() => {
      const d = Math.random().toString(36).slice(2) + Date.now().toString(36);
      localStorage.setItem('cl25.device', d); return d;
    })(),
    os: /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS'
      : /Windows/.test(ua) ? 'Windows' : /Mac/.test(ua) ? 'macOS' : 'Other',
    browser: /Edg/.test(ua) ? 'Edge' : /Chrome/.test(ua) ? 'Chrome'
      : /Safari/.test(ua) ? 'Safari' : /Firefox/.test(ua) ? 'Firefox' : 'Other',
    mobile: /Mobi|Android|iPhone/.test(ua),
  };
  try {
    const r = await fetch('/api/auth/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ email: $('email').value, password: $('pw').value, device }),
    });
    const j = await r.json();
    if (!r.ok) { err.textContent = j.error || 'Could not sign in.'; return; }
    S.sessionId = j.sessionId;
    /* Somebody who followed a link to a task and was asked to sign in should
       land on that task, not on Home. */
    if (await boot()) {
      readUrl(); render();
      /* Anything the expired session had been holding goes now. */
      flushAfterSignIn();
    }
    else err.textContent = S.bootError || 'Signed in, but the project could not be loaded.';
  } catch { err.textContent = 'The server could not be reached.'; }
}

async function doLogout() {
  /* Anything typed and not yet sent goes before the door is shut. */
  if (SAVE.pending.size || SAVE.failed.size) {
    clearTimeout(SAVE.timer);
    retrySaves();
    await new Promise(r => setTimeout(r, 400));
  }
  await fetch('/api/auth/logout', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    credentials: 'same-origin', body: JSON.stringify({ sessionId: S.sessionId }),
  }).catch(() => {});
  S.user = null; DB.me = null;
  history.replaceState(null, '', '/');   /* no task id left in the address bar */
  S.view = 'home'; S.taskId = null;
  closeNav(); render();
}

/* ------------------------------------------------------- change password */
function passwordView() {
  const forced = DB.me.mustChange;
  return `<div class="auth">
    <div class="card authcard">
      <div class="brand"><span class="dot"></span> ${forced ? 'Choose a password' : 'Change your password'}</div>
      ${forced ? `<p class="small">The one you signed in with was set for you, so somebody else
        knows it. Choose your own before you go any further.</p>`
      : `<p class="small">Changing it signs you out everywhere else you are signed in.</p>`}
      <form onsubmit="savePassword(event)">
        <label>Current password</label>
        <input id="pwNow" type="password" autocomplete="current-password" required>
        <label>New password</label>
        <input id="pwNew" type="password" autocomplete="new-password" required minlength="8"
               placeholder="at least eight characters">
        <label>New password again</label>
        <input id="pwNew2" type="password" autocomplete="new-password" required>
        <div id="pwerr" class="err"></div>
        <button class="primary wide" type="submit">Save</button>
        ${forced ? `<button type="button" class="ghost wide" onclick="doLogout()">Sign out instead</button>`
        : `<button type="button" class="ghost wide" onclick="go('home')">Cancel</button>`}
      </form>
    </div>
  </div>`;
}

async function savePassword(e) {
  e.preventDefault();
  const err = $('pwerr'); err.textContent = '';
  const next = $('pwNew').value;
  if (next !== $('pwNew2').value) { err.textContent = 'The two new passwords are not the same.'; return; }
  if (next.length < 8) { err.textContent = 'A password needs at least eight characters.'; return; }
  try {
    await api('/user', 'PUT', { current: $('pwNow').value, next });
    DB.me.mustChange = false;
    toast('Password changed');
    go('home');
  } catch (ex) { err.textContent = ex.message; }
}

function lockedView() {
  return `${topbar()}<div class="wrap"><div class="card alert big">
    <b>🔒</b>
    <div><b>The system is closed to changes.</b><p>${esc(S.lockMessage)}</p>
    <p class="small">This happens during the no-disruptive-work period before the IAUP meeting,
    and whenever the Project Office needs the record to stand still. Ask the Project Office.</p></div>
  </div></div>`;
}

/* ------------------------------------------------------------------ rail */
/* The fourteen sections in one flat row wrapped onto two lines on a laptop
   and grew to 563px tall on a phone. Grouped down the left they fit, and the
   grouping says what the sections are for: do the work, oversee it, record
   it. A badge appears only where this person has something waiting. */
function navItems() {
  const me = DB.me;
  const mineLate = DB.tasks.filter(t =>
    t.ownerId === me.id && t.effectiveStatus === 'Delayed').length;
  const toVerify = DB.tasks.filter(t =>
    t.verifierId === me.id && t.status === 'Completed' && !t.auditComplete).length;
  const waiting = DB.approvals.filter(a =>
    ['Pending', 'Submitted'].includes(a.decision) &&
    MAY('approvals')).length;
  const mineToDo = myQueue().length;
  const allToDo = KEEPER() ? pendingApprovals().length + pendingVerifications().length : 0;

  /*  key          label          visible              group        badge */
  /* Home is the administrator's page. Everybody else was being shown two
     overviews of the same project — Home's roll-up and the Dashboard's —
     and had to learn which one to trust. There is one now, and signing in
     lands on it. */
  return [
    ['home',      'Home',         me.role === 'ADMIN',  '',         mineLate + toVerify, 'bad'],
    ['dashboard', 'Dashboard',    SEE('reports'),      '',          0, ''],
    ['tasks',     'Tasks',        SEE('tasks'),        'Work',      0, ''],
    ['gantt',     'Timeline',     SEE('tasks'),        'Work',      0, ''],
    ['matrix',    'Matrix',       SEE('tasks'),        'Work',      0, ''],
    /* What is sitting with this person, and — for the project office —
       what is sitting with everybody. Approving or verifying needed the
       task to be opened first, so somebody who had been asked for a
       decision had no way of knowing which task it was on. */
    ['queue',     'Your approvals', SEE('tasks') && (mineToDo > 0 || !KEEPER()),
                                                        'Oversight', mineToDo, 'warn'],
    ['pending',   'All pending',    KEEPER() && SEE('tasks'), 'Oversight', allToDo, 'warn'],
    /* The decisions register — D01 to D18 — is a different thing from a
       task's approval status, and calling both of them Approvals meant
       nobody could say which one they had looked at. */
    ['approvals', 'Decisions',    SEE('approvals'),    'Oversight', waiting, 'warn'],
    ['budget',    'Budget',       SEE('budget'),       'Oversight', 0, ''],
    ['gates',     'Gates',        SEE('milestones'),   'Oversight', 0, ''],
    ['survey',    'Zones',        SEE('survey'),       'Field',     0, ''],
    ['students',  'Students',     SEE('students'),     'Field',     0, ''],
    ['dept',      'Departments',  SEE('reports'),      'Field',     0, ''],
    ['reference', 'Chairman',     SEE('reference'),    'Record',    0, ''],
    ['activity',  'Log',          SEE('activity'),     'Record',    0, ''],
    ['people',    'People',       SEE('users'),        'Record',    0, ''],
    ['admin',     'Administration', SEE('admin'),      'Record',    0, ''],
  ].filter(x => x[2]);
}

/** The label of the section on screen, for the phone's title bar. */
function viewTitle() {
  const hit = navItems().find(x => x[0] === S.view);
  return hit ? hit[1] : S.view === 'task' ? 'Task' : 'Campus Legacy 25';
}

function topbar() {
  const nav = navItems();
  let group = '';
  const links = nav.map(([k, l, , g, n, tone]) => {
    const head = g !== group ? (group = g, g ? `<div class="grp">${g}</div>` : '') : '';
    const tag = n > 0 ? `<span class="tag ${tone}">${n}</span>` : '';
    const on = S.view === k || (k === 'tasks' && S.view === 'task');
    return `${head}<a href="${hrefFor(k)}" class="${on ? 'on' : ''}"
      ${on ? 'aria-current="page"' : ''} onclick="return nav(event,'${k}')">${l}${tag}</a>`;
  }).join('');

  const lock = DB.siteLock && DB.siteLock.on
    ? `<div class="lockbar">Site closed to the field — you are a keyholder.</div>` : '';

  return `<aside class="side noprint">
      <a class="brand" href="${hrefFor(landing())}" onclick="return nav(event,landing())"><span class="dot"></span> DIU Campus<br>Legacy 25</a>
      <nav aria-label="Sections">${links}</nav>
      ${lock}
      <div class="foot">
        <a class="nm" onclick="go('password')" title="Change your password">${esc(DB.me.name)}</a>
        <span class="rl">${esc(DB.me.role)}</span>
        <button onclick="doLogout()">Sign out</button>
      </div>
    </aside>
    <div class="scrim noprint" onclick="closeNav()"></div>
    ${mobilebar()}`;
}

/* The phone's own bar. It sits inside .wrap so every view gets it without
   touching fourteen view functions. */
function mobilebar() {
  return `<div class="mtop noprint">
    <button class="burger" onclick="openNav()" aria-label="Open the menu" aria-expanded="false"><i></i></button>
    <span class="ttl">${esc(viewTitle())}</span>
    <a class="sp small" onclick="go('password')">${esc(DB.me.name.split(' ')[0])}</a>
  </div>`;
}

function openNav() {
  document.body.classList.add('navopen');
  const first = document.querySelector('.side nav a');
  if (first) first.focus();
}
function closeNav() { document.body.classList.remove('navopen'); }

/* ------------------------------------------------------------------ home */
/* What this person needs to do, not what tables exist. A responsible person
   opens the app and sees their own tasks; the Director sees the project. */
function homeView() {
  const me = DB.me;
  const mine = DB.tasks.filter(t => t.ownerId === me.id);
  const toVerify = DB.tasks.filter(t => t.verifierId === me.id && t.status === 'Completed' && !t.auditComplete);
  const toApprove = DB.approvals.filter(a =>
    ['Pending', 'Submitted'].includes(a.decision) &&
    MAY('approvals'));
  const boss = KEEPER();

  const late = DB.tasks.filter(t => t.effectiveStatus === 'Delayed');
  const soon = DB.tasks.filter(t => t.effectiveStatus === 'Due soon');
  const gaps = DB.tasks.filter(t => t.effectiveStatus === 'Completed – evidence gap');
  const parents = DB.tasks.filter(t => t.isTask);
  const dur = parents.reduce((a, t) => a + t.durationDays, 0);
  const weighted = dur ? parents.reduce((a, t) => a + t.durationDays * t.effectiveProgress, 0) / dur : 0;
  const nextGate = DB.milestones.filter(m => m.status === 'Pending')
    .sort((a, b) => (a.dueOn || '').localeCompare(b.dueOn || ''))[0];

  return `${topbar()}<div class="wrap">
    <h1>Good ${new Date().getHours() < 12 ? 'morning' : new Date().getHours() < 17 ? 'afternoon' : 'evening'}, ${esc(me.name.split(' ')[0])}</h1>
    <p class="meta">${TODAY()} · ${esc(me.designation || me.role)}</p>

    ${mine.length ? `<div class="card">
      <h2>Your tasks <span class="count">${mine.length}</span></h2>
      ${taskRows(mine.sort(sortByUrgency).slice(0, 12))}
      ${mine.length > 12 ? `<button class="ghost" onclick="go('tasks',{mine:true})">All ${mine.length} →</button>` : ''}
    </div>` : ''}

    ${toVerify.length ? `<div class="card">
      <h2>Waiting on your verification <span class="count warn">${toVerify.length}</span></h2>
      <p class="small">These are marked complete. Nobody verifies their own work, so they are yours to check.</p>
      ${taskRows(toVerify)}
    </div>` : ''}

    ${toApprove.length ? `<div class="card">
      <h2>Decisions <span class="count ${toApprove.some(a => a.overdue) ? 'bad' : ''}">${toApprove.length}</span></h2>
      ${approvalRows(toApprove.slice(0, 8))}
    </div>` : ''}

    ${boss ? `<div class="kpis">
      ${kpi('Tasks', parents.length, '')}
      ${kpi('Weighted progress', pct(weighted), '')}
      ${kpi('Delayed', late.length, late.length ? 'bad' : '')}
      ${kpi('Due soon', soon.length, soon.length ? 'warn' : '')}
      ${kpi('Evidence gaps', gaps.length, gaps.length ? 'warn' : '')}
      ${kpi('Open decisions', DB.approvals.filter(a => ['Pending', 'Submitted'].includes(a.decision)).length, '')}
    </div>

    ${nextGate ? `<div class="card gate ${nextGate.flag === 'Overdue' ? 'bad' : nextGate.flag === 'Within 7 days' ? 'warn' : ''}">
      <div><b>Next gate — ${esc(nextGate.id)}</b> ${esc(nextGate.title)}</div>
      <div class="right">${fmtDate(nextGate.dueOn)} · <b>${esc(nextGate.flag)}</b></div>
    </div>` : ''}

    ${late.length ? `<div class="card">
      <h2>Delayed <span class="count bad">${late.length}</span></h2>
      ${taskRows(late.sort((a, b) => b.delayDays - a.delayDays).slice(0, 10))}
    </div>` : ''}

    <div class="card">
      <h2>By department</h2>
      ${deptTable()}
    </div>` : ''}
  </div>`;
}

/* A figure with somewhere to go is a button, not a div: reachable by Tab,
   announced as a button, and obviously pressable. One without is left alone. */
const kpi = (label, value, cls, act) => act
  ? `<button type="button" class="kpi act ${cls || ''}" onclick="${act}">
       <span class="v">${esc(value)}</span><span class="l">${esc(label)} <span class="go">›</span></span>
     </button>`
  : `<div class="kpi ${cls || ''}"><div class="v">${esc(value)}</div><div class="l">${esc(label)}</div></div>`;

/* ------------------------------------------------------------- drill-down */
/* Every count on the Dashboard answers "which ones?". The phase picker at the
   top of the page narrows these exactly as it narrows the figure itself,
   otherwise a card reading 3 would open a list of twelve. */
const inPhase = t => S.phase === 'All' || t.phase === S.phase;

const DRILLS = {
  tasks:     ['Tasks',                     t => t.isTask],
  subs:      ['Sub-tasks',                 t => !t.isTask],
  completed: ['Completed',                 t => t.effectiveStatus === 'Completed'],
  progress:  ['In progress',               t => t.status === 'In Progress'],
  review:    ['Under review',              t => t.status === 'Under Review'],
  delayed:   ['Delayed',                   t => t.effectiveStatus === 'Delayed'],
  ongoing:   ['Ongoing — continuous work', t => t.effectiveStatus === 'Ongoing'],
  gaps:      ['Completed, evidence still missing',
                                           t => t.effectiveStatus === 'Completed – evidence gap'],
  nophoto:   ['Needs a before photograph',
              t => t.photosRequired && !DB.photos.some(p => p.taskId === t.id && p.kind === 'before')],
};

function drill(key) {
  const d = DRILLS[key];
  if (!d) return;
  showTasks(d[0], DB.tasks.filter(t => inPhase(t) && d[1](t)));
}

/** One status from the table on the Dashboard. */
function drillStatus(status) {
  showTasks(status, DB.tasks.filter(t => inPhase(t) && t.effectiveStatus === status));
}

function showTasks(title, list) {
  const where = S.phase === 'All' ? '' : `Phase filter: ${S.phase}.`;
  panel(`${title} — ${list.length}`,
    list.length
      ? taskRows(list.slice().sort(sortByUrgency), true)
      : '<div class="none"><b>Nothing here</b>No task in the register matches that just now.</div>',
    where || undefined);
}

/** The open decisions behind a figure. */
function drillApprovals(stageOnly) {
  const list = DB.approvals.filter(a => ['Pending', 'Submitted'].includes(a.decision)
    && (!stageOnly || String(a.stage || '').startsWith('3. Awaiting Chairman')));
  panel(`${stageOnly ? 'Awaiting the Chairman' : 'Open decisions'} — ${list.length}`,
    list.length ? approvalRows(list)
      : '<div class="none"><b>Nothing open</b>Every decision has been made.</div>');
}

function sortByUrgency(a, b) {
  const rank = s => ({ 'Delayed': 0, 'Due soon': 1, 'Completed – evidence gap': 2, 'In Progress': 3 }[s] ?? 4);
  const r = rank(a.effectiveStatus) - rank(b.effectiveStatus);
  return r || (a.deadline || '').localeCompare(b.deadline || '');
}

function deptTable() {
  const rows = DB.departments.map(d => {
    const ts = DB.tasks.filter(t => t.leadDeptId === d.id);
    const parents = ts.filter(t => t.isTask);
    const dur = parents.reduce((a, t) => a + t.durationDays, 0);
    return {
      d, n: ts.length,
      late: ts.filter(t => t.effectiveStatus === 'Delayed').length,
      done: ts.filter(t => t.effectiveStatus === 'Completed').length,
      prog: dur ? parents.reduce((a, t) => a + t.durationDays * t.effectiveProgress, 0) / dur : 0,
    };
  /* A department with no task yet was filtered out here, so one just added
     could be added, appear in every dropdown, and still be missing from the
     one list that offers Edit and Remove. Busiest first, then alphabetical,
     so the new and empty ones gather at the end instead of hiding. */
  }).sort((a, b) => b.n - a.n || a.d.name.localeCompare(b.d.name));
  return `<table class="grid"><thead><tr>
      <th class="nm">Department</th><th class="n">Items</th><th class="n">Done</th>
      <th class="n">Delayed</th><th class="pg">Progress</th>
      ${KEEPER() ? '<th class="btns"></th>' : ''}</tr></thead><tbody>
    ${rows.map(r => `<tr>
      <td class="nm">${esc(r.d.name)}</td><td class="n">${r.n}</td><td class="n">${r.done}</td>
      <td class="n ${r.late ? 'bad' : ''}">${r.late || '—'}</td>
      <td class="pg"><div class="bar"><i style="width:${Math.round(r.prog * 100)}%"></i></div>
        <span class="pgn">${Math.round(r.prog * 100)}%</span></td>
      ${KEEPER() ? `<td class="btns"><button onclick="editDept('${r.d.id}')">Edit</button>
        <button class="ghost" onclick="dropRow('departments','${r.d.id}','${esc(r.d.name)}')">Remove</button></td>` : ''}
    </tr>`).join('')}
  </tbody></table>`;
}

/* ------------------------------------------------------------- task list */
/* The filter and the list are separate so that typing can redraw the list on
   its own. Rebuilding the whole page on every letter cost up to 71ms on a
   cheap phone, and it moved the caret: the old code put focus back by hand
   and forced it to the end, so editing the middle of a search was impossible. */
/* Four ways to order the register. By id is the workbook's own order and
   keeps sub-tasks under their parents; the other three answer "what needs me
   first" and deliberately break that nesting. */
const SORTS = {
  id:       ['Task ID',    (a, b) => a.id.localeCompare(b.id, undefined, { numeric: true })],
  deadline: ['Deadline',   (a, b) => (a.deadline || '9999').localeCompare(b.deadline || '9999')],
  status:   ['Urgency',    sortByUrgency],
  progress: ['Least done', (a, b) => a.effectiveProgress - b.effectiveProgress
                                  || (a.deadline || '9999').localeCompare(b.deadline || '9999')],
};

const GROUPS = {
  none:   ['No grouping', null],
  phase:  ['Phase',       t => t.phase || 'No phase'],
  dept:   ['Department',  t => deptName(t.leadDeptId)],
  status: ['Status',      t => t.effectiveStatus],
  owner:  ['Responsible', t => userName(t.ownerId)],
};

function tasksFiltered() {
  let list = DB.tasks.slice();
  if (S.mine) list = list.filter(t => t.ownerId === DB.me.id);
  if (S.phase !== 'All') list = list.filter(t => t.phase === S.phase);
  if (S.dept !== 'All') list = list.filter(t => t.leadDeptId === S.dept);
  if (S.late) list = list.filter(t => ['Delayed', 'Due soon'].includes(t.effectiveStatus));
  if (S.q) {
    const q = S.q.toLowerCase();
    list = list.filter(t => (t.id + ' ' + t.title + ' ' + (t.site || '')).toLowerCase().includes(q));
  }
  return list.sort((SORTS[S.sort] || SORTS.id)[1]);
}

/** One table, or one table per group with a heading over each. */
/* Folding only makes sense where sub-tasks still sit under their parents:
   task-ID order, ungrouped. Every other arrangement is deliberately flat. */
const nesting = () => S.sort === 'id' && S.group === 'none';

function taskList(list) {
  if (!list.length) return noResults();
  const key = (GROUPS[S.group] || GROUPS.none)[1];
  if (!key) return taskRows(list, true, nesting());

  const bins = new Map();
  for (const t of list) {
    const k = key(t) || '—';
    if (!bins.has(k)) bins.set(k, []);
    bins.get(k).push(t);
  }
  /* Biggest group first, except when grouping by status, where the order
     that matters is how urgent the status is. */
  const order = S.group === 'status'
    ? [...bins.keys()].sort((a, b) =>
        sortByUrgency({ effectiveStatus: a, deadline: '' }, { effectiveStatus: b, deadline: '' })
        || a.localeCompare(b))
    : [...bins.keys()].sort((a, b) => bins.get(b).length - bins.get(a).length || a.localeCompare(b));

  return order.map(k => {
    const g = bins.get(k);
    /* Not beside a group that is already called Delayed. */
    const late = S.group === 'status' ? 0 : g.filter(t => t.effectiveStatus === 'Delayed').length;
    return `<section class="grp-sec">
      <h2 class="grp-h">${esc(k)} <span class="count${late ? ' bad' : ''}">${g.length}</span>
        ${late ? `<span class="small">${late} delayed</span>` : ''}</h2>
      ${taskRows(g, S.group !== 'dept')}
    </section>`;
  }).join('');
}

/* An empty list should say which filter emptied it and offer the way back,
   rather than leaving somebody staring at two words. */
function noResults() {
  const on = [];
  if (S.q) on.push(`“${esc(S.q)}”`);
  if (S.phase !== 'All') on.push(esc(S.phase));
  if (S.dept !== 'All') on.push(esc(deptName(S.dept)));
  if (S.mine) on.push('yours');
  if (S.late) on.push('late or due');
  return `<div class="none">
    <b>No task matches ${on.length ? on.join(' · ') : 'these filters'}</b>
    ${DB.tasks.length} tasks in the register.
    ${on.length ? '<div><button onclick="clearFilters()">Clear the filters</button></div>' : ''}
  </div>`;
}

function clearFilters() {
  setFilter({ q: '', phase: 'All', dept: 'All', mine: false, late: false,
              sort: 'id', group: 'none' });
}

/* ---------------------------------------------------------- saved views */
/* Every filter, sort and grouping is already in the address, so a saved view
   is a name and a URL and nothing more. They are kept in this browser: the
   settings table is the Project Director's and project-wide, and one person's
   shortcuts have no business there. Copy the address to send a view to
   somebody — it carries the same state. */
const VIEWS_KEY = 'cl25.views';

function savedViews() {
  try { return JSON.parse(localStorage.getItem(VIEWS_KEY) || '[]'); }
  catch { return []; }
}
function writeViews(v) {
  try { localStorage.setItem(VIEWS_KEY, JSON.stringify(v.slice(0, 12))); }
  catch { toast('This browser will not keep saved views.', true); }
}

function saveView() {
  form('Save this view', [
    { k: 'name', label: 'Call it', required: true, value: suggestViewName(),
      hint: 'Kept in this browser. Copy the address to send the same view to somebody else.' },
  ], async (v) => {
    const views = savedViews().filter(x => x.name !== v.name);
    views.unshift({ name: v.name.slice(0, 40), url: currentUrl() });
    writeViews(views);
    render();
  });
}

function dropView(name) {
  writeViews(savedViews().filter(x => x.name !== name));
  render();
}

function openView(url) {
  history.pushState(null, '', url);
  readUrl();
  window.scrollTo(0, 0);
  render();
}

/** A first guess at the name, built from whatever is actually filtered. */
function suggestViewName() {
  const bits = [];
  if (S.mine) bits.push('My');
  if (S.late) bits.push('late');
  if (S.phase !== 'All') bits.push(S.phase.split('–').pop().trim());
  if (S.dept !== 'All') bits.push(deptName(S.dept));
  if (S.q) bits.push(`“${S.q}”`);
  if (!bits.length) bits.push('All tasks');
  else bits.push(bits[0] === 'My' ? 'work' : 'tasks');
  return bits.join(' ').replace(/^my/i, 'My');
}

function viewChips() {
  const views = savedViews();
  const dirty = S.q || S.mine || S.late || S.phase !== 'All' || S.dept !== 'All'
                || S.sort !== 'id' || S.group !== 'none';
  const here_ = currentUrl();
  /* Nothing saved and nothing to save: draw nothing at all. An empty strip
     with a rule above it is a line of furniture explaining itself. */
  if (!views.length && !dirty) return '';
  return `<div class="chips">
    ${views.map(v => `<span class="chip${v.url === here_ ? ' on' : ''}">
        <a onclick="openView('${esc(v.url)}')">${esc(v.name)}</a>
        <button class="x" title="Remove this view" onclick="dropView('${esc(v.name)}')">×</button>
      </span>`).join('')}
    ${dirty ? `<button class="ghost addview" onclick="saveView()">+ Save this view</button>` : ''}
  </div>`;
}

/** Redraw only the result list and its count. The caret is never touched. */
function drawResults() {
  const box = $('results');
  if (!box) return render();
  const list = tasksFiltered();
  box.innerHTML = taskList(list);
  const n = $('resultcount');
  if (n) n.textContent = list.length;
  labelCells();
}

/* The query and the address bar move with the keystroke, so nothing can be
   lost; the list waits for a nineteenth of a second of quiet. Somebody typing
   "CL25-07" draws the list once instead of seven times, which is the
   difference between smooth and sticky on a cheap phone. */
let searchTimer;
function searchTasks(value) {
  S.q = value;
  history.replaceState(null, '', currentUrl());
  clearTimeout(searchTimer);
  searchTimer = setTimeout(drawResults, 90);
}

function tasksView() {
  const list = tasksFiltered();
  const phases = ['All', 'Phase 1 – IAUP Readiness', 'Event – IAUP Meeting',
                  'Phase 2 – Silver Jubilee', 'Closeout & Care'];
  return `${topbar()}<div class="wrap">
    <div class="rowhead">
      <h1>Tasks <span class="count" id="resultcount">${list.length}</span></h1>
      <div class="btns">
        <button onclick="exportBook()" id="xlbtn">⬇ Excel</button>
        ${KEEPER() ? `<button onclick="pasteTasks()">Paste from the tracker</button>
        <button class="primary" onclick="newTask()">+ New task</button>` : ''}
      </div>
    </div>
    ${DB.me && DB.me.scoped ? `<div class="alert"><b>i</b><div>
      <b>These are the tasks you are named on.</b> Your role does not open the register,
      so the rest of the project is not here — being written into one of the four chairs
      on a task is what lets you work on it. Ask the project office if you should see more.
    </div></div>` : ''}
    <div class="card filters">
      <input id="q" type="search" placeholder="Search by ID, title or zone…" value="${esc(S.q)}"
             oninput="searchTasks(this.value)">
      <select onchange="setFilter({phase:this.value})">
        ${phases.map(p => `<option ${S.phase === p ? 'selected' : ''}>${esc(p)}</option>`).join('')}
      </select>
      <select onchange="setFilter({dept:this.value})">
        <option value="All">All departments</option>
        ${DB.departments.map(d => `<option value="${esc(d.id)}" ${S.dept === d.id ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}
      </select>
      <label class="chk"><input type="checkbox" ${S.mine ? 'checked' : ''}
        onchange="setFilter({mine:this.checked})"> Mine</label>
      <label class="chk"><input type="checkbox" ${S.late ? 'checked' : ''}
        onchange="setFilter({late:this.checked})"> Late or due</label>
      <div class="arrange">
        <label class="inline">Sort
          <select onchange="setFilter({sort:this.value})">
            ${Object.entries(SORTS).map(([k, [l]]) =>
              `<option value="${k}" ${S.sort === k ? 'selected' : ''}>${l}</option>`).join('')}
          </select></label>
        <label class="inline">Group
          <select onchange="setFilter({group:this.value})">
            ${Object.entries(GROUPS).map(([k, [l]]) =>
              `<option value="${k}" ${S.group === k ? 'selected' : ''}>${l}</option>`).join('')}
          </select></label>
      </div>
      <!-- One row, not two: the .arrange class is pinned to the right of the
           filter line by a margin of auto, so using it twice left a hand's
           width of nothing down the left of the second. -->
      <div class="toolrow">
        ${colMenu()}
        <span class="small">A dot by the ID is the priority — red critical, amber high.</span>
        ${nesting() && list.some(t => t.subCount) ? `<span class="right">
          <span class="small">Sub-tasks are folded under their task.</span>
          <button class="ghost sm" onclick="foldAll(true)">Open all</button>
          <button class="ghost sm" onclick="foldAll(false)">Close all</button>
        </span>` : ''}
      </div>
      ${viewChips()}
    </div>
    <div class="card" id="results">${taskList(list)}</div>
  </div>`;
}


/* ================================================= the project as a book =
   The system replaced a Google Sheet and the Chairman's office still works in
   one, so the record goes back out in the shape it came from: a tab per
   subject, and on the Tasks tab the tracker's own column headings — which are
   the headings "Paste from the tracker" reads, so a file taken out of here can
   be pasted back in.

   The filters on screen travel with it. Somebody who has narrowed the register
   to one department's late work expects that, and not eighty rows. */
async function exportBook() {
  const btn = $('xlbtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Building…'; }
  try {
    const p = new URLSearchParams();
    if (S.q) p.set('q', S.q);
    if (S.phase !== 'All') p.set('phase', S.phase);
    if (S.dept !== 'All') p.set('dept', S.dept);
    if (S.mine) p.set('mine', '1');
    if (S.late) p.set('late', '1');

    const r = await fetch('/api/state/export?' + p.toString());
    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      throw new Error(e.error || 'The workbook could not be built.');
    }
    /* Handed over as a file rather than a link: the address carries no name,
       and a tab opening on a binary is nobody's idea of a download. */
    const blob = await r.blob();
    const name = (/filename="([^"]+)"/.exec(r.headers.get('content-disposition') || '')
                  || [])[1] || 'CL25.xlsx';
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
    toast('Downloaded ' + name);
  } catch (e) {
    toast(e.message, true);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '⬇ Excel'; }
  }
}

/* ======================================================= a row's parts =
   Three references the project office liked all do the same five things
   to a list, and four of them are structural rather than chromatic: one
   line a row, a face instead of a name, a chip instead of a repeated
   word, and a dot instead of "P0 – Critical". The palette does not
   change; what changes is how much vertical room a row is allowed. */

/* Initials, and a colour that is always the same for the same person.
   Not random: a face you half-recognise is the point. */
const AV_HUES = ['#3d6ba3', '#2f7d6b', '#8a5f9e', '#b06a3b', '#5a7a4f',
                 '#4b6ea9', '#9a5a6b', '#6b6f8a', '#a2763a', '#497b8c'];
function initials(name) {
  const w = String(name || '').replace(/\(.*?\)/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (!w.length) return '—';
  return ((w[0][0] || '') + (w.length > 1 ? (w[w.length - 1][0] || '') : '')).toUpperCase();
}
function avHue(name) {
  let h = 0;
  for (const c of String(name || '')) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return AV_HUES[h % AV_HUES.length];
}
/* "Md Salahuddin (Head MCT)" is read as a post, not a name — the post is
   already in the department column. The whole of it stays on hover. */
const shortName = n => String(n || '').replace(/\s*\(.*?\)\s*/g, ' ').trim() || String(n || '');

function face(userId) {
  if (!userId) return '<span class="face nobody"><i class="av grey">—</i><span>unassigned</span></span>';
  const full = userName(userId);
  return `<span class="face" title="${esc(full)}">
    <i class="av" style="background:${avHue(full)}">${esc(initials(full))}</i>
    <span>${esc(shortName(full))}</span></span>`;
}

/* Priority is one of three things and the word for it is eleven
   characters. A dot says the same, in a column the row does not need. */
const PRI_CLS = p => /P0/.test(p || '') ? 'p0' : /P1/.test(p || '') ? 'p1' : 'p2';
const PRI_WORD = p => /P0/.test(p || '') ? 'Critical' : /P1/.test(p || '') ? 'High' : 'Medium';
const priDot = p => `<i class="pdot ${PRI_CLS(p)}" title="${esc(p || 'P2 – Medium')}"></i>`;

/* ---- which columns the register shows ----
   The widest complaint about this table has always been that it does not
   fit. Rather than choosing for everybody, it can be chosen — and kept in
   this browser, because it is how one person likes to look at it. */
const COLS = [['dp', 'Lead department'], ['who', 'Responsible'], ['cat', 'Category'],
              ['dt', 'Deadline'], ['st', 'Status'], ['pg', 'Progress']];
const COLS_KEY = 'cl25.cols';
let HIDDEN = (() => {
  try { return new Set(JSON.parse(localStorage.getItem(COLS_KEY) || '["cat"]')); }
  catch { return new Set(['cat']); }
})();
const shows = k => !HIDDEN.has(k);

function toggleCol(k, on) {
  if (on) HIDDEN.delete(k); else HIDDEN.add(k);
  try { localStorage.setItem(COLS_KEY, JSON.stringify([...HIDDEN])); } catch {}
  render();
}

function colMenu() {
  return `<details class="colpick">
    <summary>Columns</summary>
    <div class="colbox">
      ${COLS.map(([k, l]) => `<label class="chk"><input type="checkbox" ${shows(k) ? 'checked' : ''}
        onchange="toggleCol('${k}',this.checked)"> ${esc(l)}</label>`).join('')}
    </div></details>`;
}

/* ---- which parents are open ----
   Kept in memory rather than in the address: it is where you are looking,
   not what you are looking at, and a link to "the register with CL25-23
   open" is not a thing anybody sends. */
const OPEN = new Set();

function toggleKids(id) {
  if (OPEN.has(id)) OPEN.delete(id); else OPEN.add(id);
  drawResults();
}

function foldAll(open) {
  OPEN.clear();
  if (open) for (const t of DB.tasks) if (t.subCount) OPEN.add(t.id);
  drawResults();
}

/**
 * The register.
 *
 * `nest` folds sub-tasks under their parent. Eleven sub-tasks of one task,
 * each with the same department, the same person and the same date, made
 * the list a wall of repeated text in which nothing stood out. Folded, the
 * register is forty-six lines again and opens where you ask it to.
 *
 * It only applies in task-ID order. The other sorts exist to answer "what
 * needs me first" and break the nesting on purpose — a delayed sub-task
 * belongs at the top of that list, not hidden under a parent that is fine.
 */
function taskRows(list, showDept, nest) {
  const here = new Set(list.map(t => t.id));
  const kids = new Map();
  if (nest) {
    for (const t of list) {
      if (!t.parentId || !here.has(t.parentId)) continue;
      if (!kids.has(t.parentId)) kids.set(t.parentId, []);
      kids.get(t.parentId).push(t);
    }
  }
  const tops = nest ? list.filter(t => !(t.parentId && here.has(t.parentId))) : list;

  const dept = showDept && shows('dp');
  const who = shows('who'), cat = shows('cat'), dt = shows('dt');
  const st = shows('st'), pg = shows('pg');

  /* Only what differs from the parent is worth printing again. */
  const same = (t, p, k) => !!p && !!p[k] && t[k] === p[k];
  const cell = (t, p, k, text) => same(t, p, k)
    ? `<span class="ditto" title="same as ${esc(p.id)}">↑</span>` : text;

  const row = (t, p, last) => {
    const kid = !!p;
    const mine = nest ? (kids.get(t.id) || []) : [];
    const open = OPEN.has(t.id);
    const late = Number(t.delayDays) > 0 && t.effectiveStatus === 'Delayed';
    return `<tr onclick="rowOpen(event,'${esc(t.id)}')"
      class="${t.parentId ? 'sub' : ''}${kid ? ' kid' : ''}${kid && last ? ' lastkid' : ''} row-${statusClass(t.effectiveStatus)}">
      <td class="id">${priDot(t.priority)}${t.parentId ? '<span class="ind">↳</span>' : ''}${taskLink(t.id)}</td>
      <td class="ti"><div class="tirow">
        <span class="line" title="${esc(t.title)}">${esc(t.title)}</span>
        ${t.openWarning ? `<span class="warnpill">${esc(t.openWarning)}</span>` : ''}
        ${mine.length
          ? `<button type="button" class="pill fold${open ? ' on' : ''}"
               aria-expanded="${open}" onclick="event.stopPropagation();toggleKids('${esc(t.id)}')"
               >${open ? '▾' : '▸'} ${mine.length} sub</button>`
          : (t.subCount && !nest ? `<span class="pill">${t.subCount} sub</span>` : '')}
      </div></td>
      ${dept ? `<td class="dp">${cell(t, p, 'leadDeptId',
        t.leadDeptId ? `<span class="tagc">${esc(deptName(t.leadDeptId))}</span>` : '—')}</td>` : ''}
      ${cat ? `<td class="cat">${t.category ? `<span class="tagc">${esc(t.category)}</span>` : '—'}</td>` : ''}
      ${who ? `<td class="who">${cell(t, p, 'ownerId', face(t.ownerId))}</td>` : ''}
      ${dt ? `<td class="dt">${cell(t, p, 'deadline',
        `${fmtDate(t.deadline)}${late ? ` <b class="od">${t.delayDays}d</b>` : ''}`)}</td>` : ''}
      ${st ? `<td class="stc"><span class="st ${statusClass(t.effectiveStatus)}">${esc(t.effectiveStatus)}</span></td>` : ''}
      ${pg ? `<td class="pg"><div class="bar sm"><i style="width:${Math.round(t.effectiveProgress * 100)}%"></i></div>
        <span class="pgn">${Math.round(t.effectiveProgress * 100)}%</span></td>` : ''}
    </tr>`;
  };

  const body = tops.map(t => {
    const mine = nest ? (kids.get(t.id) || []) : [];
    if (!mine.length || !OPEN.has(t.id)) return row(t, null, false);
    return row(t, null, false)
      + mine.map((k, i) => row(k, t, i === mine.length - 1)).join('');
  }).join('');

  return `<table class="grid tasks lean"><thead><tr>
      <th>Task</th><th>Task / Sub-task</th>${dept ? '<th class="dp">Lead department</th>' : ''}
      ${cat ? '<th class="cat">Category</th>' : ''}
      ${who ? '<th class="who">Responsible</th>' : ''}
      ${dt ? '<th class="dt">Deadline</th>' : ''}
      ${st ? '<th class="stc">Status</th>' : ''}${pg ? '<th class="pg">Progress</th>' : ''}
    </tr></thead><tbody>${body}</tbody></table>`;
}

function openTask(id) { go('task', { taskId: id, tab: 'overview' }); }

/* A row you can only reach with a mouse is a row some people cannot reach at
   all. The clickable row stays — it is a good target — but the task's own id
   is now a real link inside it: reachable by Tab, announced by a screen
   reader, and openable in a new tab. */
function taskLink(id, text) {
  return `<a class="ref" href="${hrefFor('task', id)}"
     onclick="return nav(event,'task',{taskId:'${esc(id)}',tab:'overview'})">${esc(text || id)}</a>`;
}

/** The row opens the task, unless the click was on something of its own. */
function rowOpen(e, id) {
  if (e.target.closest('a, button, input, select, textarea, label')) return;
  openTask(id);
}

/* ----------------------------------------------------------- task detail */
/* The shell is the one from the course file system: a header that says which
   thing you are looking at, then tabs across its facets. It works there and it
   works here, one level down — the mistake would have been putting the tabs at
   the top of the app, which is just the spreadsheet again. */
function taskView() {
  const t = task(S.taskId);
  if (!t) return `${topbar()}<div class="wrap"><div class="card">That task is not here. <a onclick="go('tasks')">Back to tasks</a></div></div>`;
  const part = myPart(t);
  const subs = DB.tasks.filter(x => x.parentId === t.id);
  const tabs = [
    ['overview', 'Overview'],
    ['photos', `Photos${DB.photos.filter(p => p.taskId === t.id).length ? ` (${DB.photos.filter(p => p.taskId === t.id).length})` : ''}`],
    ['budget', 'Budget'],
    ['approvals', 'Approvals'],
    ['subs', subs.length ? `Sub-tasks (${subs.length})` : 'Sub-tasks'],
    ['history', 'History'],
  ];
  const body = { overview: tabOverview, photos: tabPhotos, budget: tabBudget,
                 approvals: tabApprovals, subs: tabSubs, history: tabHistory }[S.tab](t);

  return `${topbar()}<div class="wrap">
    <div class="card head">
      <div>
        <nav class="crumbs" aria-label="Breadcrumb">
          <a href="/tasks" onclick="return nav(event,'tasks')">← Tasks</a>
          ${t.parentId ? `<span>/</span><a href="${hrefFor('task', t.parentId)}"
            onclick="return nav(event,'task',{taskId:'${esc(t.parentId)}',tab:'overview'})">${esc(t.parentId)}</a>` : ''}
          <span>/</span><b>${esc(t.id)}</b>
        </nav>
        <h1>${esc(t.title)}</h1>
        <div class="meta">
          <b>${esc(t.id)}</b>${KEEPER()
            ? ` <button class="ghost sm" onclick="renumber('${esc(t.id)}')"
                 title="Change this task's number">Renumber</button>` : ''}${t.parentId ? ` · sub-task of <a href="${hrefFor('task', t.parentId)}" onclick="return nav(event,'task',{taskId:'${esc(t.parentId)}',tab:'overview'})">${esc(t.parentId)}</a>` : ''}
          · ${esc(deptName(t.leadDeptId))} · ${esc(userName(t.ownerId))}
          · ${esc(t.phase || 'no phase')} · ${esc(t.priority)}
          ${t.category ? ` · ${esc(t.category)}` : ''}${t.site ? ` · ${esc(t.site)}` : ''}
          ${t.route ? ` · ${esc(t.route)}` : ''}
        </div>
      </div>
      <div class="right">
        <span class="st big ${statusClass(t.effectiveStatus)}">${esc(t.effectiveStatus)}</span>
        <div class="small">${t.deadline ? `due ${fmtDate(t.deadline)}` : 'no deadline'}
          ${t.daysToDeadline !== null && t.daysToDeadline !== undefined && t.status !== 'Completed'
            ? ` · ${t.daysToDeadline} days` : ''}
          ${t.delayDays > 0 ? ` · <b class="bad">${t.delayDays} late</b>` : ''}</div>
        ${canEdit(t) || KEEPER() ? `<div class="btns end">
          <button onclick="editTask('${t.id}')">Edit</button>
          ${KEEPER() && !t.parentId ? `
            <button onclick="newTask('${t.id}')">+ Sub-task</button>` : ''}
          ${KEEPER() ? `
            <button class="ghost" onclick="dropTask('${t.id}')">Remove</button>` : ''}
        </div>` : ''}
      </div>
    </div>

    ${part === 'none' ? `<div class="alert"><b>👁</b><div>You are not named on this task,
      so you can read it but not change it. Opening it is recorded.</div></div>` : ''}
    ${t.openWarning ? `<div class="alert warn"><b>!</b><div>${esc(t.openWarning)}</div></div>` : ''}
    ${t.effectiveStatus === 'Completed – evidence gap' ? `<div class="alert warn"><b>!</b>
      <div><b>Marked complete, but the file is not closed.</b> Still missing:
      ${t.auditGaps.map(g => `<b>${esc(g)}</b>`).join(', ')}.</div></div>` : ''}

    <nav class="tabs noprint">${tabs.map(([k, l]) =>
      `<a href="${hrefFor('task')}${k === 'overview' ? '' : `?tab=${k}`}"
         class="${S.tab === k ? 'on' : ''}" ${S.tab === k ? 'aria-current="page"' : ''}
         onclick="return nav(event,'task',{tab:'${k}'})">${l}</a>`).join('')}</nav>
    <div>${body}</div>
  </div>`;
}

function tabOverview(t) {
  const ed = canEdit(t), part = myPart(t);
  const STATUSES = ['Pending', 'In Progress', 'Under Review', 'Approved', 'Completed', 'On Hold'];
  return `<div class="card">
    <h2>Progress</h2>
    ${t.subCount ? `<p class="small">This task has ${t.subCount} sub-tasks, so its progress is
      the average of theirs — ${pct(t.effectiveProgress)}. Change a sub-task to move it.</p>
      <div class="bar"><i style="width:${Math.round(t.effectiveProgress * 100)}%"></i></div>`
    : `<div class="field">
        <label>Status</label>
        <select ${ed ? '' : 'disabled'} onchange="setField('${t.id}','status',this.value)">
          ${STATUSES.map(s => `<option ${t.status === s ? 'selected' : ''}>${s}</option>`).join('')}
        </select>
      </div>
      <div class="field">
        <label>Per cent complete — ${pct(t.progress)}</label>
        <input type="range" min="0" max="100" step="5" value="${Math.round(t.progress * 100)}"
          ${ed ? '' : 'disabled'} oninput="this.previousElementSibling.textContent='Per cent complete — '+this.value+'%'"
          onchange="setField('${t.id}','progress',this.value/100)">
      </div>`}
  </div>

  <div class="card">
    <h2>Dates</h2>
    <div class="cols">
      ${dateField(t, 'assignedOn', 'assigned_on', 'Assigned', ed)}
      ${dateField(t, 'startOn', 'start_on', 'Start', ed)}
      ${dateField(t, 'deadline', 'deadline', 'Deadline', ed && !t.continuous)}
      ${dateField(t, 'completedOn', 'completed_on', 'Completed on', ed)}
    </div>
    <!-- Some of this project's work has no finishing date: the site watch,
         housekeeping on the route, the photograph log. The register was
         calling all of it Delayed every morning. -->
    <label class="chk sw"><input type="checkbox" ${t.continuous ? 'checked' : ''} ${ed ? '' : 'disabled'}
      onchange="setContinuous('${t.id}',this.checked)">
      <b>Continuous process</b> — runs until the project ends</label>
    <p class="small">${t.continuous
      ? 'This task is never Delayed or Due soon, and reports <b>Ongoing</b>. Its deadline is held but not measured.'
      : 'Turn this on for work with no finishing date. It stops being measured against a deadline.'}</p>
  </div>

  <div class="card">
    <div class="rowhead"><h2>Responsibility</h2>
      ${KEEPER() ? `<button onclick="reassign('${t.id}')">Change who is on this task</button>` : ''}</div>
    <table class="kv">
      <tr><td>Lead department</td><td>${esc(deptName(t.leadDeptId))}</td></tr>
      <tr><td>Responsible person</td><td>${esc(userName(t.ownerId))}</td></tr>
      <tr><td>Also working on this</td><td>${helperCell(t)}</td></tr>
      <tr><td>Supporting departments</td><td>${supportCell(t)}</td></tr>
      ${t.supportText ? `<tr><td>Supporting, as the tracker wrote it</td>
        <td class="small">${esc(t.supportText)}</td></tr>` : ''}
      <tr><td>Verification by</td><td>${t.verifierId ? esc(userName(t.verifierId)) : '<i class="dim">not named</i>'}</td></tr>
      <tr><td>Approval by</td><td>${t.approverId ? esc(userName(t.approverId)) : '<i class="dim">not named</i>'}</td></tr>
      ${t.verifiedBy ? `<tr><td>Verified</td><td>${esc(userName(t.verifiedBy))} on ${fmtDate(t.verifiedOn)}</td></tr>` : ''}
      <tr><td>Category</td><td>${esc(t.category || '—')}</td></tr>
      <tr><td>Site / location</td><td>${esc(t.site || '—')}</td></tr>
      <tr><td>Implementation route</td><td>${esc(t.route || '—')}</td></tr>
      <tr><td>Budget / spent</td><td>${money(t.budget)} / ${money(t.spent)} BDT</td></tr>
      <tr><td>Last updated</td><td>${fmtWhen(t.updatedAt)}${t.updatedBy ? ` · ${esc(userName(t.updatedBy))}` : ''}</td></tr>
      ${t.dependsOn.length ? `<tr><td>Waits for</td><td>${t.dependsOn.map(d =>
        `${taskLink(d)}`).join(', ')}</td></tr>` : ''}
    </table>
  </div>

  ${handUpBox(t)}

  <!-- The sign-off used to be offered only to the named verifier, which meant
       a task whose verifier has no account could never be closed — and the
       project office, which the server does allow to sign for somebody else,
       had no button to do it with. Approval worked that way already; this is
       the other half of the same rule. -->
  ${canVerify(t) ? `<div class="card act">
    <h2>${t.verifierId === DB.me.id ? 'Your verification' : 'Verification'}</h2>
    <p class="small">${t.verifierId === DB.me.id
      ? `Signing this off records your name and today's date against ${esc(t.id)}.`
      : `${t.verifierId ? `${esc(userName(t.verifierId))} is named as the verifier.` : 'No verifier is named.'}
         You may record who checked the work — never the responsible person, whoever asks.`}</p>
    <button class="primary" onclick="verifyTask('${t.id}')">${t.verifierId === DB.me.id
      ? 'Verify this work' : 'Record the verification'}</button>
  </div>` : ''}

  ${part === 'approver' || KEEPER() ? `<div class="card act">
    <h2>Approval</h2>
    <div class="field"><label>Approval status</label>
      <select onchange="setField('${t.id}','approval_status',this.value)">
        ${['Not required', 'Pending', 'Submitted', 'Approved', 'Approved with conditions', 'Returned', 'Rejected']
          .map(s => `<option ${t.approvalStatus === s ? 'selected' : ''}>${s}</option>`).join('')}
      </select></div>
  </div>` : ''}

  ${superBox(t)}

  <div class="card">
    <h2>Evidence and notes</h2>
    ${textField(t, 'evidenceRef', 'evidence_ref', 'Evidence / document reference', ed)}
    ${textField(t, 'evidenceUrl', 'evidence_url', 'Evidence link', ed)}
    ${textField(t, 'remarks', 'remarks', 'Remarks', ed, true)}
    <p class="small">Both are optional — a task closes without them.</p>
    ${t.acceptance ? `<div class="field"><label>Acceptance criteria (Chairman)</label>
      <p class="quote">${esc(t.acceptance)}</p></div>` : ''}
    <label class="chk"><input type="checkbox" ${t.photosRequired ? 'checked' : ''} ${ed ? '' : 'disabled'}
      onchange="setField('${t.id}','photos_required',this.checked)"> Photographs required to close this</label>
  </div>

  <div class="card">
    <h2>Audit</h2>
    ${t.status === 'Completed'
      ? (t.auditComplete
        ? `<p class="ok">✓ Complete. Everything an auditor needs is attached.</p>`
        : `<p class="bad">Still missing: ${t.auditGaps.map(g => `<b>${esc(g)}</b>`).join(', ')}.</p>`)
      : `<p class="small">Checked once the status is Completed. It will want a completion date,
         a verifier's name and date, approval${t.photosRequired ? ', and an after photograph' : ''}.
         The evidence reference and remarks are optional.</p>`}
  </div>`;
}

/* ------------------------------------------- supporting departments */
/* task_roles has been read since the first day and written only by the seed.
   The matrix counts these rows, so a department that joined a task
   afterwards was invisible to it. The letter set here is S; the lead comes
   from the task itself and V and A are read from people's own departments,
   so none of those is this list's to hand out. */
const supportDepts = id => DB.taskRoles
  .filter(r => r.taskId === id && r.role === 'S')
  .map(r => by(DB.departments, r.deptId)).filter(Boolean)
  .sort((a, b) => a.name.localeCompare(b.name));

const maySupport = t => KEEPER() || !!(DB.me && t && t.ownerId === DB.me.id);

/* ----------------------------------------- the others on a piece of work -
   One person is responsible and that does not change: ask who is accountable
   for CL25-19 and there is one name. But a task done by three people had two
   of them locked out — the task was not in their list and the server refused
   their writes, so the work was done by three and recorded by one.

   These people get what the responsible person has over the work itself, and
   the same bar on signing it off: nobody verifies or approves what they had a
   hand in. */
const helperCell = (t) => {
  const list = t.helpers || [];
  const may = maySupport(t);
  return `${list.length
    ? list.map(id => `<span class="chip sm">${esc(userName(id))}${may
        ? `<button class="x" title="Take them off"
            onclick="setHelper('${esc(t.id)}','${esc(id)}','remove')">×</button>` : ''}</span>`)
        .join(' ')
    : '<i class="dim">nobody else</i>'}
    ${may ? ` <button class="ghost sm" onclick="addHelper('${esc(t.id)}')">+ Add somebody</button>`
          : ''}`;
};

function addHelper(id) {
  const t = task(id);
  if (!t) return;
  /* Everybody the task does not already have a chair for. Offering the
     verifier here only to refuse them on save is a worse way to say it. */
  const taken = new Set([t.ownerId, t.verifierId, t.approverId, ...(t.helpers || [])]);
  const people = DB.users.filter(u => u.active && !taken.has(u.id))
    .map(u => [u.id, u.name + (u.deptId ? ` · ${deptName(u.deptId)}` : '')]);
  if (!people.length) return toast('Everybody is already on this task.', true);

  form(`Who else is working on ${id}?`, [
    { k: 'userId', label: 'Person', type: 'select', options: people, required: true, full: true },
  ], v => setHelper(id, v.userId, 'add'), {
    ok: 'Add them',
    note: 'They can move this task along exactly as the responsible person can, and it appears '
        + 'in their own list. The responsible person does not change — one name still answers '
        + 'for the work. Whoever is on this list cannot verify or approve it.',
  });
}

async function setHelper(id, userId, act) {
  try {
    await api('/helpers', 'POST', { taskId: id, userId, act });
    if (await boot()) { toast(act === 'remove' ? 'Taken off' : 'Added'); render(); }
  } catch (e) { toast(e.message, true); }
}

function supportCell(t) {
  const list = supportDepts(t.id);
  const may = maySupport(t);
  return `<div class="tags">
    ${list.map(d => `<span class="tag2">${esc(d.name)}${may
      ? `<button class="x" aria-label="Remove ${esc(d.name)}" title="Remove ${esc(d.name)}"
           onclick="dropSupport('${esc(t.id)}','${esc(d.id)}')">×</button>` : ''}</span>`).join('')}
    ${list.length ? '' : '<i class="dim">none named</i>'}
    ${may ? `<button class="ghost sm" onclick="addSupport('${esc(t.id)}')">+ Add a department</button>` : ''}
  </div>`;
}

function addSupport(id) {
  const t = task(id);
  const taken = new Set(supportDepts(id).map(d => d.id));
  const choices = DB.departments.filter(d => !taken.has(d.id) && d.id !== t.leadDeptId);
  if (!choices.length) return toast('Every department is already on this task.', true);
  form(`A supporting department for ${id}`, [
    { k: 'deptId', label: 'Department', type: 'select',
      options: choices.map(d => [d.id, d.name]), value: choices[0].id },
  ], async (v) => {
    await api('/taskrole', 'POST', { taskId: id, deptId: v.deptId });
    DB.taskRoles.push({ taskId: id, deptId: v.deptId, role: 'S' });
    toast('Added'); render();
  }, { ok: 'Add', note: 'It appears in the responsibility matrix straight away.' });
}

async function dropSupport(id, deptId) {
  try {
    await api('/taskrole', 'DELETE', { taskId: id, deptId });
    DB.taskRoles = DB.taskRoles.filter(r =>
      !(r.taskId === id && r.deptId === deptId && r.role === 'S'));
    toast('Removed'); render();
  } catch (e) { toast(e.message, true); }
}

/** A square on the matrix: empty becomes S, S becomes empty. */
async function toggleSupport(taskId, deptId) {
  const t = task(taskId);
  if (!t || !maySupport(t)) return;
  if (t.leadDeptId === deptId) return toast('That department already leads this task.', true);
  const has = DB.taskRoles.some(r =>
    r.taskId === taskId && r.deptId === deptId && r.role === 'S');
  if (has) return dropSupport(taskId, deptId);
  try {
    await api('/taskrole', 'POST', { taskId, deptId });
    DB.taskRoles.push({ taskId, deptId, role: 'S' });
    render();
  } catch (e) { toast(e.message, true); }
}

/** The continuous-process switch. Saved at once, like every other toggle. */
function setContinuous(id, on) {
  /* The switch changes what the rest of the card says — the deadline stops
     being measured — so the page should catch up at once. A redraw is held
     back while a field has focus, which a tickbox does, so it lets go. */
  const a = document.activeElement;
  if (a && a.blur) a.blur();
  queueSave('task', id, 'continuous', !!on, true);
}

const dateField = (t, k, col, label, ed) => `<div class="field">
  <label>${label}</label>
  <input type="date" value="${t[k] ? String(t[k]).slice(0, 10) : ''}" ${ed ? '' : 'disabled'}
    onchange="setField('${t.id}','${col}',this.value)"></div>`;

/* Typed text saves itself as it is written. The old version only saved when
   the box was left, so a closed tab took the paragraph with it. */
const textField = (t, k, col, label, ed, area) => `<div class="field">
  <label>${label}</label>
  ${area
    ? `<textarea rows="3" ${ed ? '' : 'disabled'} oninput="setField('${t.id}','${col}',this.value,1)"
       >${esc(t[k] || '')}</textarea>`
    : `<input value="${esc(t[k] || '')}" ${ed ? '' : 'disabled'} oninput="setField('${t.id}','${col}',this.value,1)">`}
  </div>`;

/* ================================================================ autosave =
   One queue for every editable field in the application.

   What it has to get right, and how:

     nothing is dropped      the old code refused a second change while the
                             first was in the air and said nothing — the edit
                             simply vanished. Here a change is always accepted;
                             it waits its turn.
     newest wins             a field keeps only its latest value, and a reply
                             that comes back after a newer edit was queued is
                             thrown away rather than written over it. Aborting
                             the request is not enough: an aborted request can
                             still reach the server.
     in order                one flush at a time, so the server never sees two
                             writes to the same row out of sequence.
     honest                  "Saved" appears only when the server has said so.
     nothing lost            a pending or failed change blocks the tab closing,
                             and an offline change waits for the connection
                             instead of failing.
     quiet                   typing does not redraw the page; the view catches
                             up when the field is left. */
const SAVE = {
  pending: new Map(),      /* key -> job, latest value only */
  failed: new Map(),       /* key -> job, waiting for Retry */
  state: 'idle',           /* idle | saving | saved | offline | failed */
  at: null,
  note: '',
  flushing: false,
  timer: null,
  stale: false,            /* a redraw is owed once the field is left */
};

const saveKey = j => `${j.kind}:${j.id}:${j.field}`;

/** Accept a change. Called by every field on the page. */
function queueSave(kind, id, field, value, now) {
  const job = { kind, id, field, value };
  const key = saveKey(job);
  SAVE.pending.set(key, job);
  SAVE.failed.delete(key);          /* a new value supersedes the failed one */
  setSaveState('saving');
  clearTimeout(SAVE.timer);
  /* A dropdown, a date or a tick is a finished decision — send it. Typing
     waits for a pause, so a sentence is one request and not forty. */
  SAVE.timer = setTimeout(flushSaves, now ? 0 : 700);
}

function sendOne(j) {
  if (j.kind === 'task')   return api('/task', 'PATCH', { id: j.id, changes: { [j.field]: j.value } });
  if (j.kind === 'budget') return api('/budget', 'PATCH', { id: j.id, changes: { [j.field]: j.value } });
  return Promise.reject(new Error('Nothing knows how to save that.'));
}

function applySaved(j, r) {
  if (j.kind === 'task' && r.task) putTask(r.task);
  if (j.kind === 'budget' && r.line) putBudget(r.line);
}

async function flushSaves() {
  if (SAVE.flushing || !SAVE.pending.size) return;
  if (!navigator.onLine) { setSaveState('offline'); return; }

  SAVE.flushing = true;
  setSaveState('saving');
  const batch = [...SAVE.pending.entries()];
  SAVE.pending.clear();

  let last = null;
  for (let i = 0; i < batch.length; i++) {
    const [key, job] = batch[i];
    try {
      const r = await sendOne(job);
      /* Somebody typed again while this was in the air. That value is newer
         than this reply, so this reply is of no further interest. */
      if (!SAVE.pending.has(key)) applySaved(job, r);
    } catch (e) {
      if (e && e.message === 'signed out') {
        /* The session had run out.
           ---------------------------------------------------------------
           This used to stop here and return, which threw away this change
           AND every change still in the batch behind it — silently, with
           the bar still reading "Saving…". An hour away from the desk and
           an evening's work went with it, and nothing on screen said so.

           Everything unsent goes back in the queue instead. It survives the
           sign-in, because the queue is not part of the page, and the first
           thing that happens after signing in is that it goes out. */
        for (let k = i; k < batch.length; k++)
          if (!SAVE.pending.has(batch[k][0])) SAVE.failed.set(batch[k][0], batch[k][1]);
        SAVE.flushing = false;
        setSaveState('signedout');
        return;
      }
      if (!navigator.onLine) { SAVE.pending.set(key, job); setSaveState('offline'); }
      else { SAVE.failed.set(key, job); last = e; }
    }
  }
  SAVE.flushing = false;

  if (SAVE.failed.size) setSaveState('failed', last ? last.message : '');
  else if (SAVE.pending.size) { setSaveState('offline'); }
  else { SAVE.at = new Date(); setSaveState('saved'); redrawAfterSave(); }

  if (SAVE.pending.size && navigator.onLine) flushSaves();
}

function retrySaves() {
  for (const [k, j] of SAVE.failed) SAVE.pending.set(k, j);
  SAVE.failed.clear();
  flushSaves();
}

/** A redraw would move the caret, so it waits until the field is left. */
function redrawAfterSave() {
  const a = document.activeElement;
  if (a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) { SAVE.stale = true; return; }
  SAVE.stale = false;
  render();
}
document.addEventListener('focusout', () => {
  if (!SAVE.stale) return;
  /* let the focus settle before deciding, in case it moved to another field */
  setTimeout(() => {
    const a = document.activeElement;
    if (a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) return;
    if (SAVE.stale) { SAVE.stale = false; render(); }
  }, 60);
});

/* ---- what the person sees ---- */
function setSaveState(state, note) {
  SAVE.state = state;
  SAVE.note = note || '';
  drawSaveBar();
}

function drawSaveBar() {
  const el = $('savebar');
  if (!el) return;
  const hhmm = SAVE.at
    ? SAVE.at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '';
  const view = {
    idle:    '',
    saving:  '<span class="spin"></span>Saving…',
    saved:   `<b>✓</b>Saved${hhmm ? ` ${hhmm}` : ''}`,
    offline: `<b>●</b>Offline — ${SAVE.pending.size} change${SAVE.pending.size === 1 ? '' : 's'} waiting`,
    failed:  `<b>!</b>${esc(SAVE.note || 'Could not save')}
              <button class="ghost" onclick="retrySaves()">Retry</button>`,
    /* Not an error the person can retry from here — they have to sign in
       again, and the work is held until they do. Said plainly, and the bar
       does not fade away like "Saved" does. */
    signedout: `<b>!</b>${SAVE.failed.size} change${SAVE.failed.size === 1 ? '' : 's'}
                not saved — your sign-in ran out. Sign in again and they will go.`,
  }[SAVE.state] || '';
  el.className = `savebar ${SAVE.state}${view ? ' on' : ''} noprint`;
  el.innerHTML = view;

  clearTimeout(drawSaveBar.hide);
  if (SAVE.state === 'saved')
    drawSaveBar.hide = setTimeout(() => { if (SAVE.state === 'saved') setSaveState('idle'); }, 4000);
}

/* ---- the connection ---- */
window.addEventListener('offline', () => {
  if (SAVE.pending.size || SAVE.failed.size) setSaveState('offline');
});
window.addEventListener('online', () => {
  if (SAVE.failed.size) retrySaves();
  else if (SAVE.pending.size) flushSaves();
});

/* ---- nothing leaves with work still in hand ---- */
window.addEventListener('beforeunload', e => {
  if (!unsavedCount()) return;
  e.preventDefault();
  e.returnValue = '';            /* the browser writes its own wording */
});
const unsavedCount = () => SAVE.pending.size + SAVE.failed.size + (SAVE.flushing ? 1 : 0);

/* Back from the sign-in page: whatever was held goes now, without anybody
   having to remember it was held. */
function flushAfterSignIn() {
  if (SAVE.failed.size || SAVE.pending.size) {
    setSaveState('saving');
    retrySaves();
  }
}

/* A tab being hidden is the last moment anything is certain to run — on a
   phone the page can be discarded afterwards without beforeunload ever
   firing. Anything still waiting on the half-second typing pause goes now. */
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && SAVE.pending.size) {
    clearTimeout(SAVE.timer);
    flushSaves();
  }
});

/* Moving between sections is not a page load, so the browser cannot warn.
   Anything waiting is sent now and the move happens either way — the queue
   survives the redraw, so nothing is lost if it is still in the air. */
function saveBeforeLeaving() {
  if (SAVE.pending.size) { clearTimeout(SAVE.timer); flushSaves(); }
}

/** Every change is one field, named, with the trail written beside it. */
function setField(id, field, value, typed) {
  queueSave('task', id, field, value, !typed);
}

/* Who may put a name in the verified-by box.
   The named verifier, or the project office on somebody's behalf — and
   neither of them if they are the person who did the work. That last part
   is also a check constraint in the table, so this is a courtesy. */
const canVerify = t => !!t && !!DB.me
  && t.status === 'Completed' && !t.auditComplete
  && t.ownerId !== DB.me.id
  && (t.verifierId === DB.me.id || KEEPER());

function verifyTask(id) {
  const t = task(id);
  if (!t) return;

  /* The named verifier signs as themselves, today. One button, no form to
     fill in — and the last confirm() in the application goes with it. */
  if (t.verifierId === DB.me.id) {
    form(`Verify ${id}`, [], () => signOff(id, DB.me.id, TODAY()), {
      ok: 'Verify this work',
      note: `Your name and today's date go on the record against ${id}. `
          + `This is what closes the file, so it is worth having looked.`,
    });
    return;
  }

  /* The project office recording a verification that happened elsewhere —
     on paper, in a meeting, by somebody without an account. Who actually
     checked it is asked for rather than assumed, because writing the
     Director's name on work the Registrar checked is a false record. */
  const people = DB.users.filter(u => u.active && u.id !== t.ownerId)
    .map(u => [u.id, u.name + (u.deptId ? ` · ${deptName(u.deptId)}` : '')]);
  form(`Verification of ${id}`, [
    { k: 'who', label: 'Who checked the work', type: 'select', options: people,
      value: t.verifierId || DB.me.id },
    { k: 'on', label: 'On what date', type: 'date', value: TODAY(), required: true },
  ], v => signOff(id, v.who, v.on), {
    ok: 'Record the verification',
    note: t.verifierId
      ? `${userName(t.verifierId)} is named as the verifier on this task. If somebody else checked it, say so here.`
      : 'Nobody is named as the verifier on this task.',
  });
}

/* ============================================= raising a hand for a signature =
   Being named as the approval authority on forty tasks should not mean forty
   emails the day the register is written — after which nobody reads any of
   them, including the one that matters. So the authorities hear nothing when
   a task is created: the person doing the work decides when it is actually
   ready, and presses this.

   The button reaches whoever is genuinely next. Verification first, because
   that is the order the project checks things in; once it is verified the
   same button reaches the approval authority instead. */
function handUpBox(t) {
  if (!DB.me) return '';
  const mine = t.ownerId === DB.me.id
    || (t.leadDeptId && t.leadDeptId === DB.me.deptId) || KEEPER();
  if (!mine) return '';

  const stage = t.verifiedBy ? 'approval' : 'verification';
  const toId = stage === 'verification' ? t.verifierId : t.approverId;
  if (!toId || toId === DB.me.id) return '';
  if (t.approvalStatus === 'Approved') return '';

  return `<div class="card act">
    <h2>Ready for ${stage === 'verification' ? 'verification' : 'approval'}?</h2>
    <p class="small">${esc(userName(toId))} is named as the
      ${stage === 'verification' ? 'verifier' : 'approval authority'} on this task, and has
      not been told about it — nobody is, until the work is ready. Pressing this emails them
      what the task is, where it stands, and a link to open it.</p>
    <button class="primary" onclick="handUp('${esc(t.id)}')">✈ Send for ${
      stage === 'verification' ? 'verification' : 'approval'}</button>
  </div>`;
}

async function handUp(id, reason) {
  try {
    const d = await api('/notify', 'POST', { act: 'approval', id, reason: reason || '' });
    /* Asked before. The second message needs a line saying why this one is
       different from the last — an identical copy of yesterday's reminder
       teaches the reader to ignore the next one. */
    if (d.needReason) return askAgain(id, d);
    if (d.task) putTask(d.task);
    toast(`Sent for ${d.stage}`);
    render();
  } catch (e) { toast(e.message, true); }
}

function askAgain(id, d) {
  form(`Remind ${d.to}?`, [
    { k: 'reason', label: 'Why does it need chasing', required: true, full: true,
      hint: 'the IAUP meeting is on the 15th and this is holding up CL25-21' },
  ], v => handUp(id, v.reason), {
    ok: 'Send the reminder',
    note: `${d.to} was already sent this on ${dhaka(d.lastSent)}. Your note goes at the top of `
        + `the message, so they can see in one line why this one is different from the last. `
        + `It is kept on the record too.`,
  });
}

/* Sending it back is the other half: it only means something if the person
   who has to fix it is told what to fix. */
function sendBack(id) {
  form(`Return ${id}`, [
    { k: 'why', label: 'What needs fixing', required: true, full: true,
      hint: 'the south wall is not in the after photo' },
  ], async (v) => {
    await api('/notify', 'POST', { act: 'returned', id, why: v.why });
    toast('Returned, and they have been told');
  }, { ok: 'Return it' });
}

/* ---- somebody's own work, by email ---- */
async function sendList(id) {
  const u = by(DB.users, id);
  if (!u) return;
  form(`Email ${u.name} their task list?`, [], async () => {
    const d = await api('/notify', 'POST', { act: 'tasklist', id });
    toast(d.sent.length ? `Sent to ${u.name}`
      : (d.skipped.length ? `${u.name} has nothing open` : 'Not sent'), !d.sent.length);
  }, { ok: 'Send it',
       note: `${u.name} gets their own open tasks — what is late, what is due, and anything `
           + `waiting on their verification or approval. Nobody else's work is in it. Nothing `
           + `is sent if they have nothing open.` });
}

function sendListAll() {
  form('Email everyone their own task list?', [], async () => {
    const d = await api('/notify', 'POST', { act: 'tasklist-all' });
    toast(`Sent to ${d.sent.length}${d.skipped.length
      ? `, skipped ${d.skipped.length} with nothing open` : ''}`
      + (d.failed.length ? `, ${d.failed.length} failed` : ''), !!d.failed.length);
  }, { ok: 'Send them',
       note: 'Each person gets only their own open work. Anybody with nothing open is skipped '
           + 'rather than sent an empty list. Useful before a meeting or at the start of a month.' });
}

/* ================================================= signing off for others =
   The Super approve role, as a card on the task. It is drawn only for a
   person whose role carries the flag, and only where there is actually
   something waiting — an unverified task with a verifier named, an approval
   that has not been given. The server checks the role again on every write;
   this decides what is worth showing, not what is allowed. */
const SUPER = () => !!(DB.me && DB.me.superApprove);

function superBox(t) {
  if (!SUPER()) return '';
  const canV = t.status === 'Completed' && !t.verifiedBy && !!t.verifierId;
  const canA = !!t.approverId && t.approvalStatus !== 'Approved' && t.approvalStatus !== 'Not required';
  if (!canV && !canA) return '';
  return `<div class="card act super">
    <h2>Sign off for somebody else</h2>
    <p class="small">For when the person this is waiting on is away, or is a post
    on the tracker that nobody holds yet. The record will still name
    <b>them</b> as the one who signed off — your name and your reason go in the
    trail beside it.</p>
    <div class="btns">
      ${canV ? `<button onclick="overrideVerify('${esc(t.id)}')">Record ${esc(
        shortName(userName(t.verifierId)))}'s verification</button>` : ''}
      ${canA ? `<button onclick="overrideApprove('${esc(t.id)}')">Record ${esc(
        shortName(userName(t.approverId)))}'s decision</button>` : ''}
    </div>
  </div>`;
}

function overrideVerify(id) {
  const t = task(id);
  if (!t) return;
  form(`Verification of ${id}`, [
    { k: 'on', label: 'On what date was it checked', type: 'date', value: TODAY(), required: true },
    { k: 'why', label: 'Why are you recording it for them', required: true, full: true,
      hint: 'checked at the site walk on 9 Oct; he has no account yet' },
  ], v => sendOverride(id, { what: 'verify', on: v.on, why: v.why }), {
    ok: 'Record it',
    note: `${userName(t.verifierId)} will be shown as the verifier of ${id}, because that is `
        + `who checked it. The trail will say you recorded it on their behalf, and why.`,
  });
}

function overrideApprove(id) {
  const t = task(id);
  if (!t) return;
  form(`Decision on ${id}`, [
    { k: 'decision', label: 'The decision', type: 'select', options: ['Approved', 'Rejected'] },
    { k: 'why', label: 'Why are you recording it for them', required: true, full: true,
      hint: 'approved in the 8 Oct meeting; minutes attached to the task' },
  ], v => sendOverride(id, { what: 'approve', decision: v.decision, why: v.why }), {
    ok: 'Record it',
    note: `${userName(t.approverId)} is the approval authority on ${id}. Their decision is what `
        + `goes on the record; the trail will say you recorded it for them, and why.`,
  });
}

async function sendOverride(id, body) {
  const r = await api('/override', 'POST', { id, ...body });
  putTask(r.task); toast('Recorded'); render();
}

async function signOff(id, who, on) {
  const r = await api('/task', 'PATCH', { id, changes: { verified_by: who, verified_on: on } });
  putTask(r.task); toast('Verified'); render();
}

/** Everything about a task that is somebody's to set, in one form. */
function editTask(id) {
  const t = task(id);
  form(`Edit ${t.id}`, [
    { k: 'title', label: 'Task / sub-task', value: t.title, required: true },
    { k: 'category', label: 'Category', type: 'select',
      options: categoryOptions(t.category), value: t.category },
    { k: 'priority', label: 'Priority', type: 'select', options: PRIORITIES, value: t.priority },
    { k: 'site', label: 'Site / location', value: t.site, hint: 'Z02, Z01–Z10, Campus-wide' },
    { k: 'phase', label: 'Phase', type: 'select', options: PHASES, value: t.phase },
    { k: 'route', label: 'Implementation route', type: 'select', options: ROUTES, value: t.route },
    { k: 'support_text', label: 'Supporting department / person', type: 'textarea', value: t.supportText },
    { k: 'acceptance', label: 'Acceptance criteria (Chairman)', type: 'textarea', value: t.acceptance },
  ], async (v) => {
    const changes = {};
    Object.keys(v).forEach(k => { if (String(v[k]) !== String(t[camel(k)] ?? '')) changes[k] = v[k]; });
    if (!Object.keys(changes).length) return;
    const r = await api('/task', 'PATCH', { id, changes });
    putTask(r.task); toast('Saved'); render();
  });
}
const camel = k => k.replace(/_(\w)/g, (m, c) => c.toUpperCase());

/* ------------------------------------------------- changing a task's number
   A task ID is what the Chairman's tracker calls that piece of work, and a
   tracker gets renumbered. Everything that points at the old number moves
   with it — the budget lines, the photographs, the decisions, the trail — and
   so do the sub-tasks, which are named after their parent and would otherwise
   be left claiming to belong to a task that no longer exists. */
function renumber(id) {
  const t = task(id);
  if (!t) return;
  const kids = DB.tasks.filter(x => x.parentId === id);
  form(`Renumber ${id}`, [
    { k: 'to', label: 'New task ID', value: id, required: true, full: true },
  ], async (v) => {
    const to = String(v.to || '').trim();
    const d = await api('/renumber', 'POST', { from: id, to });
    if (await boot()) {
      toast(`Now ${d.to}`);
      go('task', { taskId: d.to });
    }
  }, {
    ok: 'Renumber it',
    note: kids.length
      ? `Its ${kids.length} sub-task${kids.length === 1 ? '' : 's'} are renumbered to match — `
        + `${esc(kids[0].id)} becomes the new number with .1 on the end, and so on. Everything `
        + `that points at ${id} moves too: budget lines, photographs, decisions, "waits for", `
        + `and the trail. The old address stops working, so a link to ${id} sent by email `
        + `earlier will not find it.`
      : `Everything that points at ${id} moves with it — budget lines, photographs, decisions, `
        + `"waits for", and the trail. The old address stops working, so a link to ${id} sent `
        + `by email earlier will not find it.`,
  });
}

/** Who is on it. Only the Director, and the table refuses one person twice. */
function reassign(id) {
  const t = task(id);
  form(`Who is on ${t.id}`, [
    { k: 'lead_dept_id', label: 'Lead department', type: 'select', options: deptOptions(), value: t.leadDeptId },
    { k: 'owner_id', label: 'Responsible person', type: 'select', options: peopleOptions(), value: t.ownerId },
    { k: 'verifier_id', label: 'Verification by', type: 'select', options: peopleOptions(), value: t.verifierId },
    { k: 'approver_id', label: 'Approval by', type: 'select', options: peopleOptions(), value: t.approverId },
  ], async (v) => {
    const r = await api('/task', 'PATCH', { id, changes: v });
    putTask(r.task); toast('Reassigned'); render();
  }, { note: 'Nobody verifies or approves their own work — the database will not allow it.' });
}

function newTask(parentId) {
  /* The next number in whatever series the register is already using.
     The old version read one character out of the middle of the id, so with
     forty-six tasks it still offered CL25-10 — a task that already existed.
     This reads the trailing number of each id, keeps the prefix that most of
     them share, and counts on from the highest. An id that follows no
     pattern is simply left for the person to type. */
  const next = () => {
    const tops = DB.tasks.filter(x => !x.parentId);
    const parts = tops.map(t => /^(.*?)(\d+)$/.exec(t.id)).filter(Boolean);
    if (!parts.length) return '';
    const tally = {};
    for (const m of parts) tally[m[1]] = (tally[m[1]] || 0) + 1;
    const prefix = Object.keys(tally).sort((a, b) => tally[b] - tally[a])[0];
    const mine = parts.filter(m => m[1] === prefix);
    const top = Math.max(...mine.map(m => Number(m[2])));
    const width = Math.max(...mine.map(m => m[2].length));
    return prefix + String(top + 1).padStart(width, '0');
  };

  /* A sub-task carries its parent's name and the next free number under it,
     so the two stay recognisable as a pair. */
  const nextSub = () => {
    const used = DB.tasks.filter(x => x.parentId === parentId)
      .map(x => Number(String(x.id).slice(parentId.length + 1))).filter(n => !isNaN(n));
    return `${parentId}.${(used.length ? Math.max(...used) : 0) + 1}`;
  };

  /* A sub-task starts as a copy of its parent.
     -----------------------------------------------------------------------
     Six of the fifteen fields were carried over and the rest were left
     blank, so adding four sub-tasks to one task meant choosing the same
     department, the same three people and the same two dates four times —
     and whatever was skipped in a hurry showed up later as "Assign
     responsible person" on the Dashboard. All of it is carried now. Every
     one is still a starting value: change any of them before pressing
     Create, or afterwards on the sub-task itself. */
  const p = parentId ? task(parentId) : null;
  const of = (k, blank) => p ? (p[k] ?? blank) : blank;
  const date = k => p && p[k] ? String(p[k]).slice(0, 10) : '';

  form(parentId ? `New sub-task under ${parentId}` : 'New task', [
    { k: 'id', label: parentId ? 'Sub-task ID' : 'Task ID', required: true,
      value: parentId ? nextSub() : next(),
      hint: parentId ? '' : 'anything you like — CL25-47, Lab-7, AB4-Wall' },
    { k: 'title', label: 'What is it?', required: true },
    { k: 'category', label: 'Category', type: 'select', options: categoryOptions(of('category', '')),
      value: of('category', '') },
    { k: 'leadDeptId', label: 'Lead department', type: 'select', options: deptOptions(),
      value: of('leadDeptId', '') },
    { k: 'ownerId', label: 'Responsible person', type: 'select', options: peopleOptions(),
      value: of('ownerId', '') },
    { k: 'verifierId', label: 'Verification by', type: 'select', options: peopleOptions(),
      value: of('verifierId', '') },
    { k: 'approverId', label: 'Approval by', type: 'select', options: peopleOptions(),
      value: of('approverId', '') },
    { k: 'priority', label: 'Priority', type: 'select', options: PRIORITIES,
      value: of('priority', 'P2 – Medium') },
    { k: 'phase', label: 'Phase', type: 'select', options: PHASES, value: of('phase', '') },
    { k: 'route', label: 'Implementation route', type: 'select', options: ROUTES, value: of('route', '') },
    /* `full` keeps a field on its own line in the two-column dialog, so
       Start and Deadline end up beside each other rather than apart. */
    { k: 'site', label: 'Site / location', value: of('site', ''), full: true },
    { k: 'startOn', label: 'Start', type: 'date', value: date('startOn') },
    { k: 'deadline', label: 'Deadline', type: 'date', value: date('deadline') },
    { k: 'photosRequired', label: 'Photographs required to close this', type: 'checkbox',
      value: !!of('photosRequired', false), full: true },
    { k: 'continuous', label: 'Continuous process — runs until the project ends',
      type: 'checkbox', value: !!of('continuous', false), full: true },
    { k: 'acceptance', label: 'Acceptance criteria', type: 'textarea', value: of('acceptance', '') },
  ], async (v) => {
    const r = await api('/task', 'POST', { ...v, parentId: parentId || null, assignedOn: TODAY() });
    putTask(r.task); toast('Added'); openTask(r.task.id);
  }, { ok: 'Create',
       note: p ? `Everything below is copied from ${p.id}. Change whatever is different.` : '' });
}

/* ======================================================= paste a tracker =
   The register still lives in a spreadsheet beside this one, and getting a
   row out of there and into here meant reading fifteen cells across and
   typing them back in. Copy the rows with their header line, paste them
   here, and the columns are matched by name — so a reordered or trimmed
   sheet works as well as the full one.

   Three rules this has to keep:

     nothing invented   a department or a person who cannot be matched is
                        left blank and reported. Guessing which "Rahman" was
                        meant would put the wrong name on somebody's work.
     nothing derived    the sheet carries columns this system works out for
                        itself — Days to Deadline, Effective Status, the
                        roll-ups, the _helper columns. Importing them would
                        leave two answers to the same question.
     nothing blind      more than one row is shown as a preview first, with
                        every warning, before anything is written.
*/
const PASTE_COLS = [
  /* header in the sheet          field          column        how to read it */
  ['task id',                     'id',          'id',          'text'],
  ['parent task id',              'parentId',    null,          'text'],
  ['task / sub-task',             'title',       'title',       'text'],
  ['task/sub-task',               'title',       'title',       'text'],
  ['category',                    'category',    'category',    'text'],
  ['lead department',             'leadDeptId',  'lead_dept_id', 'dept'],
  ['responsible person',          'ownerId',     'owner_id',    'user'],
  ['supporting department / person', 'supportText', 'support_text', 'text'],
  ['assigned date',               'assignedOn',  'assigned_on', 'date'],
  ['start date',                  'startOn',     'start_on',    'date'],
  ['deadline',                    'deadline',    'deadline',    'date'],
  ['priority',                    'priority',    'priority',    'pick'],
  ['status',                      'status',      'status',      'pick'],
  ['% progress',                  'progress',    'progress',    'pct'],
  ['verification by',             'verifierId',  'verifier_id', 'user'],
  ['approval by',                 'approverId',  'approver_id', 'user'],
  ['approval status',             'approvalStatus', 'approval_status', 'pick'],
  ['completion date',             'completedOn', 'completed_on', 'date'],
  ['evidence / document reference', 'evidenceRef', 'evidence_ref', 'text'],
  ['remarks',                     'remarks',     'remarks',     'text'],
  ['site / location',             'site',        'site',        'text'],
  ['photos required',             'photosRequired', 'photos_required', 'bool'],
  ['evidence / document link',    'evidenceUrl', 'evidence_url', 'text'],
  ['verification date',           'verifiedOn',  'verified_on', 'date'],
  ['verified by',                 'verifiedBy',  'verified_by', 'user'],
  ['phase',                       'phase',       'phase',       'pick'],
  ['implementation route',        'route',       'route',       'pick'],
  ['depends on',                  'dependsOn',   'depends_on',  'list'],
  ['acceptance criteria (chairman)', 'acceptance', 'acceptance', 'text'],
  ['budget (bdt)',                '_budget',     null,          'num'],
  ['actual cost (bdt)',           '_paid',       null,          'num'],
];

/* Columns the sheet carries that this system works out for itself, or that
   belong somewhere other than the task row. Named rather than ignored
   silently, so the preview can say so. */
const PASTE_SKIP = [
  'level', 'sub-tasks', 'sub-task roll-up %', 'days to deadline', 'delay (days)',
  /* The workbook this system writes out carries it; the sheet computed it. */
  'duration (days)',
  'effective status', 'audit check', 'last updated', 'updated by',
  '_dept', '_filter', '_eff%', '_dur', '_alert',
  'before photo link', 'progress photo link', 'after photo link',
];

/* The allowed values for the four columns the database checks. A pasted
   "P0 - Critical" with a plain hyphen would be refused by the table, so the
   match ignores which dash was typed and what case it was in. */
const PICKS = {
  priority: PRIORITIES, status: STATUSES, phase: PHASES.filter(Boolean),
  route: ROUTES.filter(Boolean), approvalStatus: APPROVALS,
};
const flat = s => String(s).toLowerCase().replace(/[‐-―]/g, '-')
  .replace(/\s+/g, ' ').trim();

/** A date as the tracker writes it: 03-Oct-26, 3 Oct 2026, 2026-10-03. */
function pasteDate(v) {
  const s = String(v || '').trim();
  if (!s || s === '-' || s === '—') return '';
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = /^(\d{1,2})[-\/\s]([A-Za-z]{3,})[-\/\s](\d{2,4})$/.exec(s);
  if (m) {
    const months = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
    const mi = months.indexOf(m[2].slice(0, 3).toLowerCase());
    if (mi < 0) return null;
    const yr = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    return `${yr}-${String(mi + 1).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  const d = new Date(s);
  return isNaN(+d) ? null : d.toISOString().slice(0, 10);
}

/** A name from the sheet against the accounts here. Never a guess. */
function matchOne(list, raw) {
  const s = flat(raw);
  if (!s || s === '-' || s === '—') return { id: '' };
  const exact = list.filter(x => flat(x.name) === s);
  if (exact.length === 1) return { id: exact[0].id };
  if (exact.length > 1) return { id: '', why: `more than one is called "${raw}"` };
  const loose = list.filter(x => flat(x.name).includes(s) || s.includes(flat(x.name)));
  if (loose.length === 1) return { id: loose[0].id, near: loose[0].name };
  return { id: '', why: loose.length ? `"${raw}" could be any of ${loose.length}` : `no match for "${raw}"` };
}

/**
 * Pasted text to rows, with everything that could not be read reported.
 *
 * `under` is a parent task when the paste came from that task's Sub-tasks
 * tab. The parent is then known, so the sheet need not carry a Parent Task
 * ID column at all, and a row with no ID of its own is numbered in the
 * series — CL25-27.3, .4, .5 — rather than refused. A sub-task has to be
 * named after its parent (the server insists, and that is what keeps the
 * two recognisable as a pair), so an ID that is not is renumbered and the
 * preview says so before anything is written.
 */
function parsePaste(text, under) {
  const lines = String(text || '').replace(/\r/g, '').split('\n').filter(l => l.trim());
  if (lines.length < 2) throw new Error('Paste the header line and at least one row of data.');

  const head = lines[0].split('\t').map(flat);
  const map = head.map(h => PASTE_COLS.find(c => c[0] === h) || null);
  /* Under a parent the ID column is optional — the numbering is this
     screen's job. Anywhere else there is nothing to key a row on without
     it. Either way the first line has to be a header and not data. */
  if (!map.some(Boolean))
    throw new Error('The first line has to be the header row — the one with the column names in it.');
  if (!under && !head.includes('task id'))
    throw new Error('The header row needs a "Task ID" column, so each row knows which task it is.');

  const unknown = head.filter((h, i) => !map[i] && h && !PASTE_SKIP.includes(h));
  const skipped = head.filter((h, i) => !map[i] && PASTE_SKIP.includes(h));

  const rows = [];
  for (const line of lines.slice(1)) {
    const cells = line.split('\t');
    /* `warn` is something that may be wrong; `said` is something this
       screen decided for you and you should see. They are not the same
       thing, and colouring a routine numbering red would train people to
       ignore the column. */
    const r = { values: {}, warn: [], said: [], budget: null, paid: null };
    map.forEach((col, i) => {
      if (!col) return;
      const [, field, , kind] = col;
      const raw = (cells[i] ?? '').trim();
      if (!raw || raw === '-' || raw === '—') return;

      if (kind === 'user' || kind === 'dept') {
        const hit = matchOne(kind === 'user' ? DB.users : DB.departments, raw);
        if (hit.id) {
          r.values[field] = hit.id;
          if (hit.near) r.warn.push(`read "${raw}" as ${hit.near}`);
        } else r.warn.push(hit.why);
        return;
      }
      if (kind === 'date') {
        const d = pasteDate(raw);
        if (d === null) r.warn.push(`could not read the date "${raw}"`);
        else if (d) r.values[field] = d;
        return;
      }
      if (kind === 'pct') {
        const n = Number(String(raw).replace('%', '').trim());
        if (!Number.isFinite(n)) { r.warn.push(`"${raw}" is not a percentage`); return; }
        r.values[field] = Math.max(0, Math.min(1, n > 1 ? n / 100 : n));
        return;
      }
      if (kind === 'bool') { r.values[field] = /^(y|yes|true|1)$/i.test(raw); return; }
      if (kind === 'list') { r.values[field] = raw.split(/[,;]\s*/).filter(Boolean); return; }
      if (kind === 'num') {
        const n = Number(String(raw).replace(/[,\s]/g, ''));
        if (Number.isFinite(n) && n > 0) r[field === '_budget' ? 'budget' : 'paid'] = n;
        return;
      }
      if (kind === 'pick') {
        const allowed = PICKS[field] || [];
        const hit = allowed.find(a => flat(a) === flat(raw));
        if (hit) r.values[field] = hit;
        else r.warn.push(`"${raw}" is not one of the ${field} values this system knows`);
        return;
      }
      r.values[field] = raw;
    });

    if (under) {
      /* The parent is not up for debate here: it is the task the paste was
         started from, whatever a Parent Task ID column may say. */
      r.values.parentId = under;
      const fits = new RegExp(`^${under.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.\\d+$`);
      if (!r.values.id) {
        r.values.id = nextUnder(under, rows);
        r.said.push(`numbered ${r.values.id}`);
      } else if (!fits.test(r.values.id)) {
        const was = r.values.id;
        r.values.id = nextUnder(under, rows);
        r.warn.push(`"${was}" is not a sub-task name of ${under} — numbered ${r.values.id}`);
      }
    } else if (!r.values.id) {
      r.warn.push('no Task ID — the row is skipped');
      r.skip = true;
    }
    r.id = r.values.id || '(none)';
    r.exists = !!task(r.id);
    rows.push(r);
  }
  return { rows, unknown, skipped, under };
}

/** The next free number under a parent, counting the rows already in hand. */
function nextUnder(parent, sofar) {
  const taken = DB.tasks.filter(x => x.parentId === parent)
    .concat(sofar.map(r => ({ id: r.values.id })))
    .map(x => Number(String(x.id || '').slice(parent.length + 1)))
    .filter(n => !isNaN(n));
  return `${parent}.${(taken.length ? Math.max(...taken) : 0) + 1}`;
}

/** The button — on the register, and on a task's Sub-tasks tab. */
function pasteTasks(under) {
  form(under ? `Paste sub-tasks of ${under}` : 'Paste from the tracker', [
    { k: 'text', label: 'Copy the rows from the sheet — with the header line — and paste here',
      type: 'textarea', full: true },
  ], async (v) => {
    const out = parsePaste(v.text, under || null);
    if (!out.rows.length) throw new Error('No rows of data were found under the header.');
    setTimeout(() => previewPaste(out), 0);
  }, { ok: 'Read it', wide: true,
       note: under
         ? `Every row becomes a sub-task of ${under}. There is no need for a Parent Task ID `
           + `column, and a row with no Task ID is numbered in the series. `
           + `Nothing is written yet — the next screen shows exactly what would change.`
         : 'Nothing is written yet. The next screen shows exactly what would change.' });
}

function previewPaste(out) {
  const live = out.rows.filter(r => !r.skip);
  const warned = out.rows.filter(r => r.warn.length).length;
  const made = live.filter(r => !r.exists).length;
  const upd = live.length - made;

  PASTE = out;
  panel(`${live.length} row${live.length === 1 ? '' : 's'} read`
        + (out.under ? ` — under ${out.under}` : ''), `
    <div class="kpis">
      <div class="kpi"><div class="v">${made}</div><div class="l">to be created</div></div>
      <div class="kpi"><div class="v">${upd}</div><div class="l">to be updated</div></div>
      <div class="kpi ${warned ? 'warn' : ''}"><div class="v">${warned}</div><div class="l">with a warning</div></div>
    </div>
    ${out.unknown.length ? `<div class="alert warn"><b>!</b><div>
      <b>Columns this system does not know, and will ignore:</b>
      ${out.unknown.map(h => esc(h)).join(', ')}.</div></div>` : ''}
    ${out.skipped.length ? `<p class="small">Worked out here rather than imported:
      ${out.skipped.map(h => esc(h)).join(', ')}. Photograph links are not imported —
      attach photographs on the task's Photos tab.</p>` : ''}
    <table class="grid"><thead><tr>
      <th>Task</th><th>Task / Sub-task</th><th>What happens</th><th>Notes</th>
    </tr></thead><tbody>
    ${out.rows.map(r => `<tr>
      <td class="id">${esc(r.id)}</td>
      <td class="ti">${esc(r.values.title || (r.exists ? task(r.id).title : '—'))}</td>
      <td>${r.skip ? '<span class="st st-late">skipped</span>'
        : r.exists ? '<span class="st st-prog">update</span>'
        : '<span class="st st-done">create</span>'}
        ${r.budget ? `<div class="small">+ a budget line of ${money(r.budget)}</div>` : ''}</td>
      <td class="ti">${r.warn.length
        ? `<div class="small bad">${r.warn.map(w => esc(w)).join('; ')}</div>` : ''}
        ${r.said.length
        ? `<div class="small">${r.said.map(w => esc(w)).join('; ')}</div>` : ''}
        ${!r.warn.length && !r.said.length ? '<span class="small">—</span>' : ''}</td>
    </tr>`).join('')}
    </tbody></table>
    <div class="btns end" style="margin-top:14px">
      <button class="primary" onclick="runPaste()">Write ${live.length} row${live.length === 1 ? '' : 's'}</button>
    </div>`,
    'Anything that could not be matched is left blank rather than guessed. Nothing is written until you press the button.');
}

let PASTE = null;

async function runPaste() {
  if (!PASTE) return;
  const rows = PASTE.rows.filter(r => !r.skip);
  PASTE = null;
  document.querySelectorAll('dialog.panel').forEach(d => { d.close(); d.remove(); });

  /* Fields the create endpoint does not take; they go in a second write. */
  const AFTER = ['progress', 'completedOn', 'verifiedBy', 'verifiedOn',
                 'evidenceRef', 'evidenceUrl', 'dependsOn'];
  const SNAKE = Object.fromEntries(PASTE_COLS.filter(c => c[2]).map(c => [c[1], c[2]]));

  const done = [], failed = [];
  for (const r of rows) {
    const v = { ...r.values };
    const id = v.id;
    try {
      if (r.exists) {
        const changes = {};
        const t = task(id);
        for (const k of Object.keys(v)) {
          if (k === 'id' || k === 'parentId' || !SNAKE[k]) continue;
          const now = Array.isArray(v[k]) ? v[k].join(',') : String(v[k]);
          const had = Array.isArray(t[k]) ? t[k].join(',') : String(t[k] ?? '');
          if (now !== had) changes[SNAKE[k]] = v[k];
        }
        if (Object.keys(changes).length) {
          const res = await api('/task', 'PATCH', { id, changes });
          putTask(res.task);
        }
      } else {
        const first = { ...v };
        AFTER.forEach(k => delete first[k]);
        const res = await api('/task', 'POST',
          { ...first, parentId: v.parentId || null, assignedOn: v.assignedOn || TODAY() });
        putTask(res.task);
        const rest = {};
        AFTER.forEach(k => { if (v[k] !== undefined && SNAKE[k]) rest[SNAKE[k]] = v[k]; });
        if (Object.keys(rest).length) {
          const res2 = await api('/task', 'PATCH', { id, changes: rest });
          putTask(res2.task);
        }
      }
      /* Money is a line of its own, and only when the task has none yet —
         running the same paste twice should not double the budget. */
      if (r.budget && !DB.budget.some(b => b.taskId === id)) {
        await api('/budget', 'POST', {
          taskId: id, item: (v.title || id).slice(0, 80), approved: r.budget,
          note: 'from the tracker',
        }).catch(() => {});
      }
      done.push(id);
    } catch (e) {
      failed.push(`${id}: ${e.message}`);
    }
  }

  if (await boot()) render();
  panel(`${done.length} written, ${failed.length} refused`,
    `${done.length ? `<p class="ok">✓ ${done.map(d => esc(d)).join(', ')}</p>` : ''}
     ${failed.length ? `<div class="alert warn"><b>!</b><div><b>The server refused these:</b>
       <ul>${failed.map(f => `<li>${esc(f)}</li>`).join('')}</ul>
       Nothing else was affected — each row is written on its own.</div></div>` : ''}`);
}

/** To the recycle bin, with the reason kept. */
function dropTask(id) {
  const t = task(id);
  const kids = DB.tasks.filter(x => x.parentId === id).length;
  if (kids) { toast(`${id} still has ${kids} sub-task(s). Remove those first.`, true); return; }
  form(`Remove ${id}?`, [
    { k: 'reason', label: 'Why', required: true, hint: 'kept on the record' },
  ], async (v) => {
    await api('/task', 'DELETE', { id, reason: v.reason });
    DB.tasks = DB.tasks.filter(x => x.id !== id);
    toast('Removed'); go('tasks');
  }, { ok: 'Remove', note: `"${t.title}" goes to the recycle bin. The trail keeps it either way.` });
}

/* ----------------------------------------------------- the approval chain */
const stepsFor = (kind, id) => DB.steps
  .filter(s => (kind === 'task' ? s.taskId : s.approvalId) === id)
  .sort((a, b) => a.stepNo - b.stepNo);

function chainBox(kind, id) {
  const steps = stepsFor(kind, id);
  const boss = KEEPER();
  const firstOpen = steps.find(s => s.status === 'Pending');
  return `<div class="card">
    <div class="rowhead"><h2>Approval chain</h2>
      ${boss ? `<button onclick="setChain('${kind}','${esc(id)}')">${steps.length ? 'Change' : 'Set up'}</button>` : ''}
    </div>
    ${steps.length ? `<ol class="chain">${steps.map(s => {
      const mine = s.approverId === DB.me.id;
      const turn = firstOpen && firstOpen.id === s.id;
      return `<li class="${s.status.toLowerCase()} ${turn ? 'turn' : ''}">
        <div><b>${esc(s.approverId ? userName(s.approverId) : s.post)}</b>
          ${s.approverId ? '' : '<span class="pill">post</span>'}
          <span class="st ${s.status === 'Approved' ? 'st-done' : s.status === 'Pending'
            ? (turn ? 'st-soon' : 'st-pend') : 'st-late'}">${esc(s.status)}</span></div>
        ${s.decidedOn ? `<div class="small">${fmtDate(s.decidedOn)} · ${esc(userName(s.decidedBy))}${s.note ? ` — ${esc(s.note)}` : ''}</div>` : ''}
        ${turn && (mine || (!s.approverId && boss)) ? `<div class="btns">
          <button class="primary" onclick="decideStep('${s.id}','Approved')">Approve</button>
          <button onclick="decideStep('${s.id}','Returned')">Return</button>
          <button class="ghost" onclick="decideStep('${s.id}','Rejected')">Reject</button>
          ${boss ? `<button class="ghost" onclick="decideStep('${s.id}','Skipped')">Skip</button>` : ''}
        </div>` : ''}
      </li>`;
    }).join('')}</ol>`
    : `<p class="small">No chain set. ${boss ? 'Set one up and each step waits for the one before it.'
        : 'The Project Director sets who approves this, and in what order.'}</p>`}
  </div>`;
}

/** Up to six steps, each a person or a post. Blank rows are dropped. */
function setChain(kind, id) {
  const cur = stepsFor(kind, id);
  const fields = [];
  for (let i = 0; i < 6; i++) {
    const s = cur[i] || {};
    fields.push({ k: `p${i}`, label: `Step ${i + 1} — person`, type: 'select',
                  options: peopleOptions(), value: s.approverId || '' });
    fields.push({ k: `t${i}`, label: `Step ${i + 1} — or a post`, value: s.post || '',
                  hint: 'Honorable Chairman, Authorized selection panel…' });
  }
  form('Approval chain', fields, async (v) => {
    const steps = [];
    for (let i = 0; i < 6; i++)
      if (v[`p${i}`] || v[`t${i}`].trim())
        steps.push({ approverId: v[`p${i}`] || null, post: v[`t${i}`].trim() });
    const body = kind === 'task' ? { taskId: id, steps } : { approvalId: id, steps };
    const r = await api('/step', 'PUT', body);
    DB.steps = DB.steps.filter(s => (kind === 'task' ? s.taskId : s.approvalId) !== id)
      .concat(r.steps.map(mapStep));
    toast('Chain set'); render();
  }, { note: 'Each step waits for the one before it. A step with only a post is recorded by the Director.' });
}

const mapStep = s => ({
  id: s.id, taskId: s.task_id ?? s.taskId, approvalId: s.approval_id ?? s.approvalId,
  stepNo: s.step_no ?? s.stepNo, approverId: s.approver_id ?? s.approverId, post: s.post,
  status: s.status, decidedOn: s.decided_on ?? s.decidedOn,
  decidedBy: s.decided_by ?? s.decidedBy, note: s.note,
});

function decideStep(id, status) {
  const ask = status === 'Approved' ? null : 'Why';
  const go2 = async (note) => {
    const r = await api('/step', 'PATCH', { id, status, note: note || '' });
    const step = DB.steps.find(s => s.id === id);
    const key = step.taskId ? 'taskId' : 'approvalId';
    const owner = step[key];
    DB.steps = DB.steps.filter(s => s[key] !== owner).concat(r.steps.map(mapStep));
    if (await boot()) { toast(status); render(); }
  };
  if (!ask) go2('');
  else form(`${status} — step`, [{ k: 'note', label: ask, required: true }],
            v => go2(v.note), { ok: status });
}

/* -------------------------------------------------------------- sub-tasks */
function tabSubs(t) {
  const subs = DB.tasks.filter(x => x.parentId === t.id)
    .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
  /* Adding a sub-task from this tab used to call newTask() with no parent,
     which quietly made a task of its own at the top of the register. */
  const add = KEEPER() ? `<div class="btns">
    <button onclick="pasteTasks('${esc(t.id)}')">Paste from the tracker</button>
    <button class="primary" onclick="newTask('${esc(t.id)}')">+ Sub-task</button>
  </div>` : '';
  return `<div class="card">
    <div class="rowhead"><h2>Sub-tasks <span class="count">${subs.length}</span></h2>${add}</div>
    ${subs.length
      ? `<p class="small">This task's progress is the average of these: <b>${pct(t.effectiveProgress)}</b>.</p>
         ${taskRows(subs)}`
      : `<p class="small">No sub-tasks yet.${KEEPER()
          ? ' One goes at the end, and nothing already here moves. Pasting several rows from the'
            + ' tracker numbers them for you.' : ''}</p>`}
  </div>`;
}

/* ---------------------------------------------------------------- photos */
/* A phone writes the place and the moment into the picture's own EXIF, which
   for an audit record is worth more than the picture alone. Resizing destroys
   it, so it is read out first and travels as plain fields. */
function tabPhotos(t) {
  const mine = DB.photos.filter(p => p.taskId === t.id);
  const ed = canEdit(t);
  const group = kind => {
    /* Oldest first, the same order the arrows step in. The list arrived
       newest-first from the server, so the third tile in a box opened as
       the first photograph in the viewer and the arrows appeared to run
       backwards. One order, everywhere. */
    const list = mine.filter(p => p.kind === kind).sort(photoOrder);
    /* The box itself takes a drop. Whichever box the pictures land in is the
       stage they belong to, so there is nothing to choose afterwards. */
    const drop = ed ? ` ondragover="dragOver(event)" ondragleave="dragOff(event)"
       ondrop="dropPhotos(event,'${t.id}','${kind}')"` : '';
    return `<div class="card droppable"${drop}>
      <div class="rowhead">
        <h2>${kind[0].toUpperCase() + kind.slice(1)} <span class="count">${list.length}</span></h2>
        ${ed ? `<div class="btns">
          <button class="primary" onclick="pickPhoto('${t.id}','${kind}','camera')">📷 Take</button>
          <button onclick="pickPhoto('${t.id}','${kind}','upload')">⬆ Upload</button>
        </div>` : ''}
      </div>
      ${list.length ? `<div class="shots">${list.map(p => shot(p, kind)).join('')}</div>`
      : `<p class="small">None yet.${ed ? ' Drag pictures here, or use the buttons above.' : ''}</p>`}
      ${ed ? `<div class="dropnote"><span>Drop here &rarr; <b>${
        esc(kind[0].toUpperCase() + kind.slice(1))}</b></span></div>` : ''}
    </div>`;
  };

  /* ---- the whole story, in the order it happened ----
     Three boxes say what stage a photograph belongs to. They do not say
     what happened in what order, which is the question anybody actually
     asks of a wall that was surveyed in September, scraped in October and
     painted in November. The same photographs, once more, oldest first. */
  const story = mine.slice().sort(photoOrder);

  return `
    ${t.photosRequired ? `<div class="alert"><b>📷</b><div>This task cannot be closed without an
      <b>after</b> photograph.</div></div>` : ''}
    <div id="upbar"></div>
    ${group('before')}${group('progress')}${group('after')}

    ${story.length > 1 ? `<div class="card">
      <div class="rowhead"><h2>How it went <span class="count">${story.length}</span></h2>
        <span class="small">oldest first · ${fmtDate(photoWhen(story[0]))} to ${fmtDate(photoWhen(story[story.length - 1]))}</span>
      </div>
      <div class="shots gallery">${story.map(p => shot(p, 'all', true)).join('')}</div>
    </div>` : ''}

    <p class="small">Pictures are stored on Cloudflare R2, resized to 1080 on the long edge.
    The place and time are read from the photograph before resizing and kept on the record.
    The order above is the date each was taken, falling back to when it was added.</p>`;
}

/** When a photograph happened: when it was taken, or failing that, added. */
const photoWhen = p => p.takenAt || p.uploadedAt;
const photoOrder = (a, b) =>
  String(photoWhen(a) || '').localeCompare(String(photoWhen(b) || ''));

/**
 * One tile. `within` names the set its arrows step through — one of the
 * three stages, or 'all' for the run of the work. A name rather than the
 * list itself, because the list is already in hand and writing twenty
 * identifiers into each of twenty tiles is four hundred of them.
 */
function shot(p, within, showKind) {
  const mayEdit = p.uploadedBy === DB.me.id || KEEPER();
  return `<figure>
    <button type="button" class="shotlink" aria-label="Open this photograph"
      onclick="lightbox('${esc(p.id)}','${esc(within)}')">
      <img src="${esc(p.thumbUrl || p.url)}" alt="${esc(p.caption || p.kind)}" loading="lazy">
      ${showKind ? `<span class="kindpill">${esc(p.kind)}</span>` : ''}
    </button>
    <figcaption>
      ${p.caption ? `<b>${esc(p.caption)}</b><br>` : ''}
      ${fmtDate(photoWhen(p))}${p.takenAt ? '' : ' <span class="small">(added)</span>'}
      ${p.source === 'upload' ? ' · <i>uploaded</i>' : ''}
      ${p.lat ? ` · <a href="https://maps.google.com/?q=${p.lat},${p.lng}" target="_blank" rel="noopener">map</a>` : ''}
      <br><span class="small">${esc(userName(p.uploadedBy))}</span>
      ${mayEdit ? ` · <a onclick="setCaption('${esc(p.id)}')">${p.caption ? 'caption' : '+ caption'}</a>
        · <a class="del" onclick="dropPhoto('${esc(p.id)}')">remove</a>` : ''}
    </figcaption>
  </figure>`;
}

/** Say what this one shows. Not asked at upload — a site photograph is one tap. */
function setCaption(id) {
  const p = by(DB.photos, id);
  if (!p) return;
  form('What does this show?', [
    { k: 'caption', label: 'Caption', value: p.caption || '',
      hint: 'first coat · after scraping · the cracked section' },
  ], async (v) => {
    const r = await api('/photo', 'PATCH', { id, caption: v.caption });
    p.caption = r.photo.caption;
    toast('Saved'); render();
  }, { ok: 'Save', note: 'It shows under the picture, and in the Chairman\'s view.' });
}

/* ---- one photograph, large ----
   The tile used to open the file in a new tab, which left the project
   behind and gave no way to step through the rest. */
function lightbox(id, within) {
  const here = by(DB.photos, id);
  if (!here) return;
  const order = DB.photos
    .filter(p => p.taskId === here.taskId && (within === 'all' || p.kind === within))
    .sort(photoOrder);
  let at = Math.max(0, order.findIndex(p => p.id === id));

  const d = document.createElement('dialog');
  d.className = 'modal shotbox';
  document.body.appendChild(d);

  const draw = () => {
    const p = order[at];
    d.innerHTML = `<div class="shotwrap">
      <img src="${esc(p.url)}" alt="${esc(p.caption || p.kind)}">
      <div class="shotbar">
        <div>
          <b>${esc(p.caption || (p.kind[0].toUpperCase() + p.kind.slice(1)))}</b>
          <div class="small">${esc(p.kind)} · ${fmtDate(photoWhen(p))}${p.takenAt ? '' : ' (added)'}
            · ${esc(userName(p.uploadedBy))}
            ${order.length > 1 ? ` · ${at + 1} of ${order.length}` : ''}</div>
        </div>
        <div class="btns">
          ${order.length > 1 ? `<button type="button" class="ghost" data-go="-1" aria-label="Previous">‹</button>
            <button type="button" class="ghost" data-go="1" aria-label="Next">›</button>` : ''}
          <a class="btn ghost" href="${esc(p.url)}" target="_blank" rel="noopener">Full size</a>
          <button type="button" class="primary" data-shut="1">Close</button>
        </div>
      </div>
    </div>`;
  };

  const step = n => { at = (at + n + order.length) % order.length; draw(); };
  const shut = () => { document.removeEventListener('keydown', keys); d.close(); d.remove(); };
  const keys = e => {
    if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
  };

  d.addEventListener('click', e => {
    const go = e.target.closest('[data-go]');
    if (go) return step(Number(go.dataset.go));
    if (e.target.closest('[data-shut]')) return shut();
    /* the dark surround, clicked */
    if (e.target === d) shut();
  });
  d.addEventListener('cancel', () => { document.removeEventListener('keydown', keys); d.remove(); });
  document.addEventListener('keydown', keys);

  draw();
  d.showModal();
}

function pickPhoto(taskId, kind, source) {
  const i = document.createElement('input');
  i.type = 'file';
  i.accept = 'image/*';
  if (source === 'camera') i.capture = 'environment';
  i.multiple = source === 'upload';
  i.onchange = () => sendPhotos([...i.files], taskId, kind, source);
  i.click();
}

/* ---------------------------------------------------- dragged in from a folder
   The browser's own answer to a dropped picture is to leave the page and show
   that one file, losing whatever was half-typed. So every drop is caught: on a
   box it is an upload, anywhere else it is quietly ignored. */
function dragOver(e) {
  if (!hasFiles(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
  e.currentTarget.classList.add('dropping');
}
function dragOff(e) {
  /* Moving over a tile inside the box fires leave on the box itself. Only a
     pointer that has actually left turns the highlight off. */
  if (e.relatedTarget && e.currentTarget.contains(e.relatedTarget)) return;
  e.currentTarget.classList.remove('dropping');
}
function dropPhotos(e, taskId, kind) {
  if (!hasFiles(e)) return;
  e.preventDefault();
  e.currentTarget.classList.remove('dropping');
  const files = [...(e.dataTransfer.files || [])].filter(f => f.type.startsWith('image/'));
  const skipped = (e.dataTransfer.files || []).length - files.length;
  if (!files.length) return toast('Pictures only — that was not an image.', true);
  if (skipped) toast(`${skipped} file${skipped > 1 ? 's were' : ' was'} not a picture and ${skipped > 1 ? 'were' : 'was'} left out`);
  sendPhotos(files, taskId, kind, 'upload');
}
const hasFiles = e => [...((e.dataTransfer || {}).types || [])].includes('Files');

/* A picture dropped beside a box, or on any other page, would otherwise
   replace the application with that one file. */
addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
addEventListener('drop', e => { if (hasFiles(e)) e.preventDefault(); });

async function sendPhotos(files, taskId, kind, source) {
  if (!files.length) return;
  const bar = $('upbar');
  let done = 0;
  const show = (msg, bad) => { if (bar) bar.innerHTML = `<div class="card alert ${bad ? 'warn' : ''}"><b>⬆</b><div>${esc(msg)}</div></div>`; };
  for (const f of files) {
    try {
      show(`Preparing ${f.name} (${done + 1} of ${files.length})…`);
      const meta = await readExif(f).catch(() => ({}));
      const full = await shrink(f, 1080);
      const thumb = await shrink(f, 400);

      show(`Uploading ${f.name} (${done + 1} of ${files.length})…`);
      const slot = await api('/photo', 'POST', { taskId, kind });
      await Promise.all([
        fetch(slot.put, { method: 'PUT', headers: { 'content-type': 'image/jpeg' }, body: full.blob }),
        fetch(slot.putThumb, { method: 'PUT', headers: { 'content-type': 'image/jpeg' }, body: thumb.blob }),
      ]).then(rs => { if (rs.some(r => !r.ok)) throw new Error('The upload was refused by the store.'); });

      const r = await api('/photo', 'PUT', {
        id: slot.id, taskId, kind, url: slot.url, thumbUrl: slot.thumbUrl, source,
        takenAt: meta.takenAt || null, lat: meta.lat ?? null, lng: meta.lng ?? null,
        bytes: full.blob.size, width: full.w, height: full.h,
      });
      DB.photos.unshift({
        id: r.photo.id, taskId, kind, url: slot.url, thumbUrl: slot.thumbUrl,
        caption: '', source, takenAt: meta.takenAt || null,
        lat: meta.lat ?? null, lng: meta.lng ?? null, bytes: full.blob.size,
        width: full.w, height: full.h, uploadedBy: DB.me.id, uploadedAt: new Date().toISOString(),
      });
      done++;
      render();
    } catch (e) {
      show(e.message, true);
      toast(e.message, true);
      return;
    }
  }
  if (bar) bar.innerHTML = '';
  toast(`${done} photograph${done > 1 ? 's' : ''} added`);
  render();
}

/* The gate dialog was called the last prompt() in the application. It was
   not — this one was still here, and it is the one people meet most. */
function dropPhoto(id) {
  const p = by(DB.photos, id);
  form('Take this photograph off the record', [
    { k: 'reason', label: 'Why', required: true, hint: 'kept on the record' },
  ], async (v) => {
    await api('/photo', 'DELETE', { id, reason: v.reason });
    DB.photos = DB.photos.filter(x => x.id !== id);
    toast('Removed'); render();
  }, { ok: 'Remove',
       note: `${p && p.caption ? `"${p.caption}" ` : 'It '}comes off the task. The file stays in `
           + `storage, because it was part of the record — the project office can clear those `
           + `from Administration.` });
}

/** Long edge to `max`, JPEG. A four-megabyte photograph comes out near 250 KB. */
function shrink(file, max) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      c.toBlob(b => b ? resolve({ blob: b, w, h }) : reject(new Error('Could not read that image.')),
        'image/jpeg', 0.85);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That file is not an image.')); };
    img.src = url;
  });
}

/**
 * Just enough EXIF: when it was taken and where.
 *
 * Only the first 128 KB is read, which is far more than the header needs, and
 * anything unexpected simply yields nothing — a photograph without EXIF is
 * still a photograph, and the upload must not fail over a missing tag.
 */
function readExif(file) {
  return new Promise(resolve => {
    const r = new FileReader();
    r.onload = () => {
      try { resolve(parseExif(new DataView(r.result))); } catch { resolve({}); }
    };
    r.onerror = () => resolve({});
    r.readAsArrayBuffer(file.slice(0, 131072));
  });
}

function parseExif(v) {
  if (v.getUint16(0) !== 0xFFD8) return {};              // not a JPEG
  let off = 2;
  while (off < v.byteLength - 4) {
    if (v.getUint16(off) !== 0xFFE1) {
      if ((v.getUint16(off) & 0xFF00) !== 0xFF00) return {};
      off += 2 + v.getUint16(off + 2);
      continue;
    }
    const start = off + 4;
    if (v.getUint32(start) !== 0x45786966) return {};     // 'Exif'
    const tiff = start + 6;
    const le = v.getUint16(tiff) === 0x4949;
    const u16 = p => v.getUint16(p, le), u32 = p => v.getUint32(p, le);
    if (u16(tiff + 2) !== 0x002A) return {};

    const out = {};
    const readDir = (dir, want) => {
      const n = u16(dir);
      for (let i = 0; i < n; i++) {
        const e = dir + 2 + i * 12;
        const tag = u16(e), type = u16(e + 2), count = u32(e + 4);
        const size = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 }[type] || 1;
        const total = size * count;
        const at = total > 4 ? tiff + u32(e + 8) : e + 8;
        want(tag, type, count, at);
      }
      return u32(dir + 2 + n * 12);
    };
    const str = (at, count) => {
      let s = '';
      for (let i = 0; i < count - 1; i++) s += String.fromCharCode(v.getUint8(at + i));
      return s;
    };
    const rat = at => u32(at) / (u32(at + 4) || 1);
    const dms = at => rat(at) + rat(at + 8) / 60 + rat(at + 16) / 3600;

    let exifIfd = 0, gpsIfd = 0;
    readDir(tiff + u32(tiff + 4), (tag, type, count, at) => {
      if (tag === 0x8769) exifIfd = tiff + u32(at);
      if (tag === 0x8825) gpsIfd = tiff + u32(at);
      if (tag === 0x0132 && !out.takenAt) out.takenAt = exifDate(str(at, count));
    });
    if (exifIfd) readDir(exifIfd, (tag, type, count, at) => {
      if (tag === 0x9003 || tag === 0x9004) {
        const d = exifDate(str(at, count));
        if (d) out.takenAt = d;
      }
    });
    if (gpsIfd) {
      let latRef = 'N', lngRef = 'E', lat = null, lng = null;
      readDir(gpsIfd, (tag, type, count, at) => {
        if (tag === 1) latRef = String.fromCharCode(v.getUint8(at));
        if (tag === 2) lat = dms(at);
        if (tag === 3) lngRef = String.fromCharCode(v.getUint8(at));
        if (tag === 4) lng = dms(at);
      });
      if (lat !== null && lng !== null && isFinite(lat) && isFinite(lng)) {
        out.lat = +(latRef === 'S' ? -lat : lat).toFixed(6);
        out.lng = +(lngRef === 'W' ? -lng : lng).toFixed(6);
      }
    }
    return out;
  }
  return {};
}

/** EXIF writes '2026:10:08 09:14:22'. */
function exifDate(s) {
  const m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(String(s || '').trim());
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`;
}

/* ---------------------------------------------------------------- budget */
function tabBudget(t) {
  const lines = DB.budget.filter(b => b.taskId === t.id);
  const may = MAY('budget');
  return `<div class="card">
    <div class="rowhead"><h2>Budget lines <span class="count">${lines.length}</span></h2>
      ${may ? `<button class="primary" onclick="newBudgetLine('${esc(t.id)}')">+ Add a budget line</button>` : ''}</div>
    ${lines.length ? budgetTable(lines)
      : `<p class="small">No budget line is tied to ${esc(t.id)}${may
          ? ' yet. Add one and it reaches the Budget page, the department summary and the Dashboard.' : '.'}</p>`}
  </div>`;
}

function budgetView() {
  const total = (k) => DB.budget.reduce((a, b) => a + (Number(b[k]) || 0), 0);
  const may = MAY('budget');
  return `${topbar()}<div class="wrap">
    <div class="rowhead"><h1>Budget <span class="count">${DB.budget.length}</span></h1>
      ${may ? `<button class="primary" onclick="newBudgetLine()">+ New line</button>` : ''}</div>
    <div class="kpis">
      ${kpi('Estimated', money(DB.budget.reduce((a, b) => a + b.baseCost + b.otherCosts, 0)), '')}
      ${kpi('Approved', money(total('approved')), '')}
      ${kpi('Committed', money(total('committed')), '')}
      ${kpi('Paid', money(total('paid')), '')}
      ${kpi('Utilisation', total('approved') ? pct(total('paid') / total('approved')) : '—', '')}
    </div>
    <div class="card">${DB.budget.length ? budgetTable(DB.budget, true)
      : '<div class="none"><b>No budget lines yet</b>A line belongs to a task — that is how money reaches the register.</div>'}</div>
    <p class="small">Quantities and rates are anyone's with the budget module; the approved and
    paid figures are the Project Director's, because that is what an audit asks about.
    A removed line goes to the recycle bin, not away.</p>
  </div>`;
}

/** A line belongs to a task, so the task is asked for and never guessed. */
function newBudgetLine(taskId) {
  const tasks = DB.tasks.slice()
    .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
  if (!tasks.length) return toast('There is no task to put a budget line against.', true);
  form(taskId ? `A budget line for ${taskId}` : 'A new budget line', [
    ...(taskId ? [] : [{ k: 'taskId', label: 'Against which task', type: 'select', required: true,
      options: tasks.map(t => [t.id, `${t.id} · ${t.title.slice(0, 48)}`]) }]),
    { k: 'item', label: 'What is it for', required: true, hint: 'paint, scaffolding hire, printing' },
    { k: 'unit', label: 'Unit', hint: 'm², lot, unit, student-day' },
    { k: 'qty', label: 'Quantity', type: 'number', step: 'any' },
    { k: 'rate', label: 'Unit rate (BDT)', type: 'number', step: 'any' },
    { k: 'otherCosts', label: 'Other costs (BDT)', type: 'number', step: 'any',
      hint: 'tax, carriage — anything beside quantity × rate' },
    { k: 'zone', label: 'Zone', hint: 'Z02, Campus-wide' },
    ...(KEEPER() ? [{ k: 'approved', label: 'Approved budget (BDT)', type: 'number', step: 'any' }] : []),
    { k: 'evidenceUrl', label: 'Quotation or approval link' },
    { k: 'note', label: 'Note', type: 'textarea' },
  ], async (v) => {
    const r = await api('/budget', 'POST', { ...v, taskId: taskId || v.taskId });
    if (await boot()) { toast(`${r.id} added`); render(); }
  }, { ok: 'Add the line',
       note: KEEPER() ? '' : 'The approved and paid figures are the Project Director\'s to record.' });
}

function dropBudget(id) {
  const b = by(DB.budget, id);
  form(`Remove ${id}?`, [
    { k: 'reason', label: 'Why', required: true, hint: 'kept on the record' },
  ], async (v) => {
    await api('/budget', 'DELETE', { id, reason: v.reason });
    DB.budget = DB.budget.filter(x => x.id !== id);
    toast('Removed'); render();
  }, { ok: 'Remove',
       note: `"${b ? b.item : id}" goes to the recycle bin and can be put back from Administration.` });
}

function budgetTable(lines, showTask) {
  const boss = KEEPER();
  const may = MAY('budget');
  const cell = (b, f, val) => may
    ? `<input class="num" value="${val ?? ''}" ${(['approved', 'committed', 'paid'].includes(f) && !boss) ? 'disabled' : ''}
         oninput="setBudget('${b.id}','${f}',this.value,1)">`
    : (val === null || val === undefined ? '—' : money(val));
  return `<table class="grid money"><thead><tr>
      <th>Line</th>${showTask ? '<th>Task</th>' : ''}<th>Item</th><th>Unit</th>
      <th class="n">Qty</th><th class="n">Rate</th><th class="n">Estimated</th>
      <th class="n">Approved</th><th class="n">Paid</th><th>Flag</th>
      ${may ? '<th class="btns"></th>' : ''}
    </tr></thead><tbody>
    ${lines.map(b => {
      const est = b.baseCost + b.otherCosts;
      const flag = !b.approved && !b.paid ? 'Not yet budgeted'
        : !b.approved && b.paid ? 'Paid without approval'
        : b.paid > b.approved ? 'Over budget'
        : b.paid >= 0.9 * b.approved ? 'Near limit' : 'Within budget';
      return `<tr>
        <td class="id">${esc(b.id)}</td>
        ${showTask ? `<td>${taskLink(b.taskId)}</td>` : ''}
        <td class="ti">${esc(b.item)}</td><td>${esc(b.unit)}</td>
        <td class="n">${cell(b, 'qty', b.qty)}</td>
        <td class="n">${cell(b, 'rate', b.rate)}</td>
        <td class="n">${est ? money(est) : '—'}</td>
        <td class="n">${cell(b, 'approved', b.approved)}</td>
        <td class="n">${cell(b, 'paid', b.paid)}</td>
        <td><span class="st ${flag === 'Within budget' ? 'st-done'
          : flag === 'Not yet budgeted' ? 'st-pend' : 'st-late'}">${flag}</span></td>
        ${may ? `<td class="btns"><button class="ghost"
          onclick="dropBudget('${esc(b.id)}')">Remove</button></td>` : ''}
      </tr>`;
    }).join('')}
  </tbody></table>`;
}

function setBudget(id, field, value, typed) {
  queueSave('budget', id, field, value, !typed);
}

function putBudget(b) {
  {
    const i = DB.budget.findIndex(x => x.id === b.id);
    if (i >= 0) DB.budget[i] = {
      ...DB.budget[i],
      qty: b.qty === null ? null : Number(b.qty), rate: b.rate === null ? null : Number(b.rate),
      approved: b.approved === null ? null : Number(b.approved),
      committed: b.committed === null ? null : Number(b.committed),
      paid: Number(b.paid), otherCosts: Number(b.other_costs),
      baseCost: (Number(b.qty) || 0) * (Number(b.rate) || 0),
      note: b.note, evidenceUrl: b.evidence_url,
    };
  }
}

/* ------------------------------------------------------------- approvals */
function tabApprovals(t) {
  const list = DB.approvals.filter(a => a.taskId === t.id);
  return chainBox('task', t.id) +
    (list.length ? `<div class="card"><h2>Decisions from the tracker</h2>${approvalRows(list)}</div>`
                 : `<div class="card"><p class="small">No tracker decision is tied to ${esc(t.id)}.</p></div>`);
}

function approvalsView() {
  const open = DB.approvals.filter(a => ['Pending', 'Submitted'].includes(a.decision));
  const done = DB.approvals.filter(a => !['Pending', 'Submitted'].includes(a.decision));
  return `${topbar()}<div class="wrap">
    <h1>Approvals</h1>
    <div class="card">
      <div class="rowhead">
        <h2>Open <span class="count ${open.some(a => a.overdue) ? 'bad' : ''}">${open.length}</span></h2>
        ${MAY('approvals') ? `<button class="primary" onclick="newDecision()">+ New decision</button>` : ''}
      </div>
      ${open.length ? approvalRows(open.sort((a, b) =>
        (b.overdue - a.overdue) || (a.dueOn || '').localeCompare(b.dueOn || ''))) : '<p class="small">Nothing open.</p>'}
    </div>
    ${done.length ? `<div class="card"><h2>Decided</h2>${approvalRows(done)}</div>` : ''}
  </div>`;
}

function approvalRows(list) {
  const boss = KEEPER();
  return `<table class="grid"><thead><tr>
      <th class="id">Ref</th><th>Decision</th><th class="dt">Due</th>
      <th>Stage</th><th class="btns">Action</th>
    </tr></thead><tbody>${list.map(a => {
    const t = task(a.taskId);
    const canVerify = a.verifierId === DB.me.id || boss;
    const canDecide = boss || MAY('approvals');
    return `<tr>
      <td class="id">${esc(a.id)}</td>
      <td class="ti">${esc(a.item)}
        <div class="small">${esc(a.finalAuthority)}${a.chairmanNeeded ? ' · <b>Chairman</b>' : ''}
          ${t ? ` · ${taskLink(a.taskId)}` : ''}</div></td>
      <td class="dt">${fmtDate(a.dueOn)}${a.overdue ? '<br><b class="bad">overdue</b>' : ''}</td>
      <td><span class="st ${a.stage.startsWith('Approved') ? 'st-done'
        : a.stage.startsWith('Return') || a.stage.startsWith('Reject') ? 'st-late'
        : a.stage.startsWith('3. Awaiting Chairman') ? 'st-soon' : 'st-prog'}">${esc(a.stage)}</span></td>
      <td class="btns">
        ${!a.submittedOn && (a.originatorId === DB.me.id || boss)
          ? `<button onclick="approvalAct('${a.id}','submit')">Submit</button>` : ''}
        ${a.submittedOn && a.verification !== 'Verified' && canVerify
          ? `<button onclick="approvalAct('${a.id}','verify')">Verify</button>` : ''}
        ${a.verification === 'Verified' && ['Pending', 'Submitted'].includes(a.decision) && canDecide
          ? `<button class="primary" onclick="decide('${a.id}')">Decide</button>` : ''}
        ${boss ? `<button class="ghost" onclick="dropDecision('${a.id}')">Remove</button>` : ''}
      </td>
    </tr>`;
  }).join('')}</tbody></table>`;
}

async function approvalAct(id, act, extra, inForm) {
  try {
    const r = await api('/approval', 'PATCH', { id, act, ...(extra || {}) });
    putApproval(r.approval);
    toast('Saved'); render();
  } catch (e) {
    /* Inside a dialog the message belongs in the dialog, beside what was
       typed; a toast over a form the person is still filling in is lost. */
    if (inForm) throw e;
    toast(e.message, true);
  }
}

/* Recording a decision asked for a letter — A, C, R or X — typed into a
   grey browser box, and then asked again for the reason in a second one.
   Two prompts and a key to remember, for the single act this register
   exists to record. */
function decide(id) {
  const a = by(DB.approvals, id);
  form(`Decision on ${id}`, [
    { k: 'decision', label: 'The decision', type: 'select', required: true,
      options: ['Approved', 'Approved with conditions', 'Returned', 'Rejected'] },
    { k: 'conditions', label: 'Conditions, or the reason', type: 'textarea',
      hint: 'required for anything but a plain approval' },
  ], async (v) => {
    if (v.decision !== 'Approved' && !String(v.conditions || '').trim())
      throw new Error('Say why. A returned or conditional decision without a reason is no use to whoever has to act on it.');
    await approvalAct(id, 'decide', { decision: v.decision, conditions: v.conditions || '' }, true);
  }, { ok: 'Record it',
       note: a ? `${a.item}${a.finalAuthority ? ` · ${a.finalAuthority}` : ''}` : '' });
}

function putApproval(a) {
  const i = DB.approvals.findIndex(x => x.id === a.id);
  const m = {
    id: a.id, taskId: a.task_id ?? a.taskId, item: a.item,
    originatorId: a.originator_id ?? a.originatorId, verifierId: a.verifier_id ?? a.verifierId,
    verification: a.verification, verifiedOn: a.verified_on ?? a.verifiedOn,
    finalAuthority: a.final_authority ?? a.finalAuthority,
    chairmanNeeded: a.chairman_needed ?? a.chairmanNeeded,
    submittedOn: a.submitted_on ?? a.submittedOn, dueOn: a.due_on ?? a.dueOn,
    decision: a.decision, decidedOn: a.decided_on ?? a.decidedOn,
    decidedBy: a.decided_by ?? a.decidedBy, conditions: a.conditions, impact: a.impact,
    evidenceUrl: a.evidence_url ?? a.evidenceUrl, source: a.source,
    stage: a.stage, daysOpen: a.days_open ?? a.daysOpen, overdue: a.overdue,
  };
  if (i >= 0) DB.approvals[i] = m; else DB.approvals.push(m);
}

/* ======================================================== waiting on you =
   A task's approval and its verification both used to live inside the task
   and nowhere else: somebody told "the Chairman has to approve CL25-19" had
   to be told the task number too, then find it, then scroll. Neither queue
   was anywhere a person could look.

   Two pages. One is what is waiting for you; the other, for the project
   office, is what is waiting for anybody — because a decision nobody is
   chasing is the thing that quietly holds up a project. Both act in place:
   the dropdown and the button here are the same writes the task page makes,
   checked by the same server rules. */
const OPEN_APPROVAL = ['Pending', 'Submitted'];

const myApprovals = () => DB.tasks.filter(t =>
  DB.me && t.approverId === DB.me.id && OPEN_APPROVAL.includes(t.approvalStatus)
  && t.ownerId !== DB.me.id);

const myVerifications = () => DB.tasks.filter(t =>
  DB.me && t.verifierId === DB.me.id && t.status === 'Completed'
  && !t.auditComplete && !t.verifiedBy && t.ownerId !== DB.me.id);

const myQueue = () => myApprovals().concat(myVerifications());

/* Everything open, whoever it is with — including the tasks with nobody
   named, which are the ones that never move. */
const pendingApprovals = () => DB.tasks.filter(t => OPEN_APPROVAL.includes(t.approvalStatus));
const pendingVerifications = () => DB.tasks.filter(t =>
  t.status === 'Completed' && !t.auditComplete && !t.verifiedBy);

function queueView() {
  const appr = myApprovals().sort(sortByUrgency);
  const ver = myVerifications().sort(sortByUrgency);
  return `${topbar()}<div class="wrap">
    <h1>Waiting on you <span class="count ${appr.length + ver.length ? 'warn' : ''}">${appr.length + ver.length}</span></h1>
    <p class="meta">Decide from here — there is no need to open the task.</p>

    <div class="card">
      <h2>For your approval <span class="count">${appr.length}</span></h2>
      ${appr.length ? queueTable(appr, 'approve')
        : '<div class="none"><b>Nothing waiting</b>No task names you as its approval authority with a decision outstanding.</div>'}
    </div>

    <div class="card">
      <h2>For your verification <span class="count">${ver.length}</span></h2>
      ${ver.length ? `<p class="small">These are marked complete. Nobody verifies their own work,
          so they are yours to check.</p>${queueTable(ver, 'verify')}`
        : '<div class="none"><b>Nothing waiting</b>No completed task names you as its verifier.</div>'}
    </div>
  </div>`;
}

function pendingView() {
  const appr = pendingApprovals().sort(sortByUrgency);
  const ver = pendingVerifications().sort(sortByUrgency);
  const nobody = appr.filter(t => !t.approverId).length;
  return `${topbar()}<div class="wrap">
    <h1>All pending <span class="count ${appr.length + ver.length ? 'warn' : ''}">${appr.length + ver.length}</span></h1>
    <p class="meta">Everything across the project that is waiting for a decision or a check.</p>
    ${nobody ? `<div class="alert warn"><b>!</b><div>
      <b>${nobody} ${nobody === 1 ? 'task has' : 'tasks have'} no approval authority named.</b>
      Nobody has been asked, so nobody will answer. Name one on the task, or decide here.
    </div></div>` : ''}

    <div class="card">
      <h2>Awaiting approval <span class="count">${appr.length}</span></h2>
      ${appr.length ? queueTable(appr, 'approve', true)
        : '<div class="none"><b>Nothing outstanding</b>Every task has had its decision.</div>'}
    </div>

    <div class="card">
      <h2>Awaiting verification <span class="count">${ver.length}</span></h2>
      ${ver.length ? `<p class="small">Marked complete and not yet checked. You may record who
          checked the work; never the person who did it.</p>${queueTable(ver, 'verify', true)}`
        : '<div class="none"><b>Nothing outstanding</b>Every completed task has been verified.</div>'}
    </div>
  </div>`;
}

/** One queue, with the decision in the last column. */
function queueTable(list, kind, showWho) {
  return `<table class="grid"><thead><tr>
      <th>Task</th><th>Task / Sub-task</th><th class="dp">Lead department</th>
      <th class="who">Responsible</th>
      ${showWho ? `<th class="who">${kind === 'approve' ? 'Approval by' : 'Verification by'}</th>` : ''}
      <th class="dt">Deadline</th><th>Status</th>
      <th class="btns">${kind === 'approve' ? 'Decision' : 'Verification'}</th>
    </tr></thead><tbody>
    ${list.map(t => {
      const named = kind === 'approve' ? t.approverId : t.verifierId;
      return `<tr>
      <td class="id">${taskLink(t.id)}</td>
      <td class="ti">${esc(t.title)}</td>
      <td class="dp">${esc(deptName(t.leadDeptId))}</td>
      <td class="who">${t.ownerId ? esc(userName(t.ownerId)) : '<i class="dim">unassigned</i>'}</td>
      ${showWho ? `<td class="who">${named ? esc(userName(named)) : '<i class="dim">nobody named</i>'}</td>` : ''}
      <td class="dt">${fmtDate(t.deadline)}</td>
      <td><span class="st ${statusClass(t.effectiveStatus)}">${esc(t.effectiveStatus)}</span></td>
      <td class="btns">${kind === 'approve'
        ? `<select aria-label="Approval of ${esc(t.id)}"
             onchange="setField('${esc(t.id)}','approval_status',this.value)">
            ${APPROVALS.map(s => `<option ${t.approvalStatus === s ? 'selected' : ''}>${s}</option>`).join('')}
           </select>`
        : `<button class="primary" onclick="verifyTask('${esc(t.id)}')">${
            t.verifierId === DB.me.id ? 'Verify' : 'Record it'}</button>`}</td>
    </tr>`; }).join('')}
  </tbody></table>`;
}

/* ----------------------------------------------------------------- gates */
function gatesView() {
  const boss = KEEPER();
  return `${topbar()}<div class="wrap">
    <h1>Gates and milestones</h1>
    <div class="card"><table class="grid"><thead><tr>
      <th>Gate</th><th>Milestone</th><th>Date</th><th class="n">Days</th><th>Flag</th>
      ${boss ? '<th></th>' : ''}</tr></thead><tbody>
      ${DB.milestones.map(m => `<tr>
        <td class="id">${esc(m.id)}</td>
        <td class="ti">${esc(m.title)}<div class="small">${esc(m.releaseEvidence || '')}</div></td>
        <td class="dt">${fmtDate(m.dueOn)}</td>
        <td class="n">${m.daysLeft === null ? '—' : m.daysLeft}</td>
        <td><span class="st ${m.flag.startsWith('Achieved') ? (m.flag.includes('add') ? 'st-gap' : 'st-done')
          : m.flag === 'Overdue' || m.flag === 'Missed' ? 'st-late'
          : m.flag === 'Within 7 days' ? 'st-soon' : 'st-pend'}">${esc(m.flag)}</span></td>
        ${boss ? `<td class="btns">${m.status === 'Pending'
          ? `<button onclick="markGate('${m.id}','Achieved')">Achieved</button>
             <button class="ghost" onclick="markGate('${m.id}','Missed')">Missed</button>`
          : `<button class="ghost" onclick="markGate('${m.id}','Pending')">Reopen</button>`}</td>` : ''}
      </tr>`).join('')}
    </tbody></table></div>
    <p class="small">A gate is not reached because its tasks are ticked — somebody with the authority
    says so, and names the evidence. An achieved gate with nothing attached shows as incomplete.</p>
  </div>`;
}

/* Marking a gate asked for its evidence through the browser's own prompt() —
   the last one left in the application. It looked nothing like the rest, it
   could not be styled or validated, and on a phone it covered the page with
   a grey slab. It is the same dialog as everywhere else now. */
function markGate(id, status) {
  const m = DB.milestones.find(x => x.id === id) || {};
  if (status !== 'Achieved') return sendGate(id, status, '');
  form(`${esc(id)} — achieved`, [
    { k: 'evidenceUrl', label: 'Link to the evidence that releases this gate',
      value: m.evidenceUrl || '', hint: 'a minute, a photograph, a signed note — you can add it later' },
  ], v => sendGate(id, status, v.evidenceUrl, true),
     { ok: 'Record it', note: m.releaseEvidence
       ? `What releases this gate: ${m.releaseEvidence}`
       : 'An achieved gate with nothing attached shows as incomplete.' });
}

async function sendGate(id, status, evidenceUrl, inForm) {
  try {
    const r = await api('/milestone', 'PATCH', { id, status, evidenceUrl });
    const i = DB.milestones.findIndex(m => m.id === id);
    const m = r.milestone;
    if (i >= 0) DB.milestones[i] = {
      ...DB.milestones[i], status: m.status, achievedOn: m.achieved_on ?? m.achievedOn,
      evidenceUrl: m.evidence_url ?? m.evidenceUrl, flag: m.flag,
      daysLeft: m.days_left ?? m.daysLeft,
    };
    toast('Recorded'); render();
  } catch (e) {
    /* Inside the dialog the message belongs in the dialog, where the person
       is looking and where what they typed is still waiting. */
    if (inForm) throw e;
    toast(e.message, true);
  }
}


/* ------------------------------------------------------------- dashboard */
/* The workbook's Dashboard tab. The phase picker is the same one the sheet
   had: it narrows everything on the page and nothing anywhere else. */
function dashboardView() {
  /* inPhase is the same test the drill-downs use, so a card and the list it
     opens can never disagree about what the phase picker means. */
  const all = DB.tasks.filter(inPhase);
  const parents = all.filter(t => t.isTask);
  const dur = parents.reduce((a, t) => a + t.durationDays, 0);
  const weighted = dur ? parents.reduce((a, t) => a + t.durationDays * t.effectiveProgress, 0) / dur : 0;
  const n = f => all.filter(f).length;
  const gate = id => DB.milestones.find(m => m.id === id);
  const bud = k => DB.budget.reduce((a, b) => a + (Number(b[k]) || 0), 0);
  const needPhoto = DB.tasks.filter(t => t.photosRequired);
  const havePhoto = needPhoto.filter(t => DB.photos.some(p => p.taskId === t.id && p.kind === 'before'));
  const openAppr = DB.approvals.filter(a => ['Pending', 'Submitted'].includes(a.decision));

  const STATS = ['Pending', 'In Progress', 'Under Review', 'Approved', 'Ongoing', 'Due soon',
                 'Delayed', 'On Hold', 'Completed – evidence gap', 'Completed'];
  const attention = all.filter(t => ['Delayed', 'Due soon', 'Completed – evidence gap']
    .includes(t.effectiveStatus)).sort(sortByUrgency).slice(0, 10);
  const gates = DB.milestones.filter(m => m.status === 'Pending')
    .sort((a, b) => (a.dueOn || '').localeCompare(b.dueOn || '')).slice(0, 6);

  return `${topbar()}<div class="wrap">
    <div class="rowhead">
      <h1>Dashboard</h1>
      <select onchange="setFilter({phase:this.value})">
        ${['All'].concat(PHASES.filter(Boolean)).map(x =>
          `<option ${S.phase === x ? 'selected' : ''}>${esc(x)}</option>`).join('')}
      </select>
    </div>
    <p class="meta">Project DIU-CL25-2026 · as at ${TODAY()}</p>

    <!-- Every count opens the list behind it; the two that are percentages
         and the two that are countdowns have no list to open. -->
    <div class="kpis">
      ${kpi('Tasks', parents.length, '', "drill('tasks')")}
      ${kpi('Sub-tasks', all.length - parents.length, '', "drill('subs')")}
      ${kpi('Completed', n(t => t.effectiveStatus === 'Completed'), '', "drill('completed')")}
      ${kpi('In progress', n(t => t.status === 'In Progress'), '', "drill('progress')")}
      ${kpi('Under review', n(t => t.status === 'Under Review'), '', "drill('review')")}
      ${kpi('Delayed', n(t => t.effectiveStatus === 'Delayed'),
            n(t => t.effectiveStatus === 'Delayed') ? 'bad' : '', "drill('delayed')")}
      ${kpi('Weighted progress', pct(weighted), '')}
      ${kpi('Evidence gaps', n(t => t.effectiveStatus === 'Completed – evidence gap'),
            n(t => t.effectiveStatus === 'Completed – evidence gap') ? 'warn' : '', "drill('gaps')")}
    </div>
    <div class="kpis">
      ${kpi('Pending approvals', openAppr.length, '', 'drillApprovals(false)')}
      ${kpi('Awaiting Chairman', openAppr.filter(a => a.stage.startsWith('3. Awaiting Chairman')).length,
            '', 'drillApprovals(true)')}
      ${kpi('Approved budget', money(bud('approved')), '')}
      ${kpi('Paid to date', money(bud('paid')), '')}
      ${kpi('Budget used', bud('approved') ? pct(bud('paid') / bud('approved')) : '—', '')}
      ${kpi('Before-photo cover', needPhoto.length ? pct(havePhoto.length / needPhoto.length) : '—',
            '', "drill('nophoto')")}
      ${kpi('Days to IAUP (G8)', gate('G8') ? gate('G8').daysLeft : '—', '')}
      ${kpi('Days to Jubilee (E3)', gate('E3') ? gate('E3').daysLeft : '—', '')}
    </div>

    <div class="two">
      <div class="card">
        <h2>Status at a glance</h2>
        <table class="grid pick"><thead><tr><th>Status</th><th class="n">Count</th><th></th></tr></thead><tbody>
        ${STATS.map(st => { const c = n(t => t.effectiveStatus === st);
          return `<tr${c ? ` class="go" onclick="drillStatus('${esc(st)}')"` : ''}>
            <td><span class="st ${statusClass(st)}">${esc(st)}</span></td>
            <!-- the row opens the list for a mouse, the number for a keyboard;
                 the number stops the click there so the row does not open a
                 second copy of the same list behind it -->
            <td class="n">${c ? `<button type="button" class="linky"
                onclick="event.stopPropagation();drillStatus('${esc(st)}')">${c}</button>` : c}</td>
            <td><div class="bar"><i style="width:${all.length ? Math.round(c / all.length * 100) : 0}%"></i></div></td></tr>`;
        }).join('')}</tbody></table>
      </div>
      <div class="card">
        <h2>Budget summary (BDT)</h2>
        <!-- a label and a figure, not a grid of records: no header row to give it -->
        <table class="kv money"><tbody>
          <tr><td>Estimated</td><td class="n">${money(DB.budget.reduce((a, b) => a + b.baseCost + b.otherCosts, 0))}</td></tr>
          <tr><td>Approved</td><td class="n">${money(bud('approved'))}</td></tr>
          <tr><td>Committed</td><td class="n">${money(bud('committed'))}</td></tr>
          <tr><td>Paid</td><td class="n">${money(bud('paid'))}</td></tr>
          <tr><td>Forecast final</td><td class="n">${money(bud('paid') + bud('forecastRest'))}</td></tr>
        </tbody></table>
      </div>
    </div>

    <div class="two">
      <div class="card">
        <h2>Progress by phase</h2>
        <table class="grid"><thead><tr><th>Phase</th><th class="n">Tasks</th>
          <th class="n">Done</th><th>Progress</th></tr></thead><tbody>
        ${PHASES.filter(Boolean).map(ph => {
          const ts = DB.tasks.filter(t => t.phase === ph && t.isTask);
          const d = ts.reduce((a, t) => a + t.durationDays, 0);
          const w = d ? ts.reduce((a, t) => a + t.durationDays * t.effectiveProgress, 0) / d : 0;
          return `<tr><td>${esc(ph)}</td><td class="n">${ts.length}</td>
            <td class="n">${ts.filter(t => t.effectiveStatus === 'Completed').length}</td>
            <td><div class="bar"><i style="width:${Math.round(w * 100)}%"></i></div></td></tr>`;
        }).join('')}</tbody></table>
      </div>
      <div class="card">
        <h2>By implementation route</h2>
        <table class="grid"><thead><tr><th>Route</th><th class="n">Items</th>
          <th class="n">Done</th><th class="n">Delayed</th></tr></thead><tbody>
        ${ROUTES.filter(Boolean).map(rt => {
          const ts = all.filter(t => t.route === rt);
          const late = ts.filter(t => t.effectiveStatus === 'Delayed').length;
          return `<tr><td>${esc(rt)}</td><td class="n">${ts.length}</td>
            <td class="n">${ts.filter(t => t.effectiveStatus === 'Completed').length}</td>
            <td class="n ${late ? 'bad' : ''}">${late || '—'}</td></tr>`;
        }).join('')}</tbody></table>
      </div>
    </div>

    <div class="card">
      <h2>Needs attention <span class="count ${attention.length ? 'warn' : ''}">${attention.length}</span></h2>
      ${attention.length ? taskRows(attention, true) : '<p class="small">Nothing late, due or missing evidence.</p>'}
    </div>

    <div class="two">
      <div class="card">
        <h2>Next milestones</h2>
        <table class="grid"><thead><tr><th>Gate</th><th>Milestone</th>
          <th class="n">Days</th><th>Flag</th></tr></thead><tbody>
        ${gates.map(m => `<tr><td class="id">${esc(m.id)}</td><td class="ti">${esc(m.title)}</td>
          <td class="n">${m.daysLeft}</td>
          <td><span class="st ${m.flag === 'Overdue' ? 'st-late' : m.flag === 'Within 7 days' ? 'st-soon' : 'st-pend'}">${esc(m.flag)}</span></td></tr>`).join('')}
        </tbody></table>
      </div>
      <div class="card">
        <h2>Pending approvals</h2>
        ${openAppr.length ? approvalRows(openAppr.slice(0, 8)) : '<p class="small">None open.</p>'}
      </div>
    </div>

    <div class="card"><h2>Department workload</h2>${deptTable()}</div>
  </div>`;
}

/* ---------------------------------------------------- responsibility matrix */
/* The workbook read these letters out of the text with SEARCH(), which counted
   Housekeeping as Facilities Engineering and found "HR" inside a person's
   name. Here each letter is a row in task_roles and cannot mean anything else. */
/* The matrix promises four letters and the workbook only ever filled in two:
   every task has a lead and most have supporting departments, but there is
   not one V or A row in the table. Verification and approval are recorded
   against people instead — 78 tasks name a verifier, 75 an approver — and a
   person's department is the missing link. Read it from there, so the two
   empty columns fill themselves the moment people are given departments, and
   say plainly meanwhile that they have not been. */
function matrixView() {
  const deptOf = id => (by(DB.users, id) || {}).deptId || '';
  const derived = t => ({
    A: t.approverId ? deptOf(t.approverId) : '',
    V: t.verifierId ? deptOf(t.verifierId) : '',
  });
  const role = (taskId, deptId) => {
    const t = task(taskId);
    /* The lead is on the task itself. The matrix used to read it only from
       task_roles, so reassigning a task left the old letter standing. */
    if (t && t.leadDeptId === deptId) return 'L';
    const rs = DB.taskRoles.filter(r => r.taskId === taskId && r.deptId === deptId);
    if (rs.some(r => r.role === 'L')) return 'L';
    const d = t ? derived(t) : {};
    if (d.A && d.A === deptId) return 'A';
    if (d.V && d.V === deptId) return 'V';
    if (rs.some(r => r.role === 'S')) return 'S';
    return '';
  };
  const depts = DB.departments.filter(d =>
    DB.taskRoles.some(r => r.deptId === d.id) ||
    DB.tasks.some(t => t.leadDeptId === d.id) ||
    DB.tasks.some(t => { const x = derived(t); return x.A === d.id || x.V === d.id; }));

  const named = DB.users.filter(u => u.deptId).length;
  const notice = named ? '' : `<div class="alert warn"><b>!</b><div>
    <b>The V and A columns are empty because nobody has a department yet.</b>
    ${DB.tasks.filter(t => t.verifierId).length} tasks name a verifier and
    ${DB.tasks.filter(t => t.approverId).length} name an approval authority, but none of
    the ${DB.users.length} people are attached to a department, so there is nothing to put
    in a column. Set each person's department on
    <a href="/people" onclick="return nav(event,'people')">People</a> and this fills itself in.
  </div></div>`;
  const list = DB.tasks.filter(t => S.phase === 'All' || t.phase === S.phase)
    .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
  return `${topbar()}<div class="wrap">
    <div class="rowhead"><h1>Responsibility matrix</h1>
      <select onchange="setFilter({phase:this.value})">
        ${['All'].concat(PHASES.filter(Boolean)).map(x =>
          `<option ${S.phase === x ? 'selected' : ''}>${esc(x)}</option>`).join('')}
      </select></div>
    <p class="meta">L lead · S supporting · V verification · A final approval</p>
    ${KEEPER() ? `<p class="small">Click an empty square, or an <b>S</b>, to add or remove a
      supporting department. <b>L</b> comes from the task's lead department and
      <b>V</b> and <b>A</b> from the verifier's and the approval authority's own departments,
      so those three are changed on the task itself.</p>` : ''}
    ${notice}
    <div class="card scroll">
      <table class="grid matrix"><thead><tr>
        <th>Task</th>${depts.map(d => `<th class="rot"><span>${esc(d.name)}</span></th>`).join('')}
      </tr></thead><tbody>
      ${list.map(t => `<tr>
        <td class="ti" onclick="rowOpen(event,'${t.id}')">${taskLink(t.id)} ${esc(t.title)}</td>
        ${depts.map(d => { const r = role(t.id, d.id);
          const open = (r === '' || r === 'S') && maySupport(t);
          return `<td class="rl ${r ? 'r-' + r : ''}${open ? ' pickable' : ''}"
            ${open ? `tabindex="0" role="button"
              aria-label="${esc(d.name)} on ${esc(t.id)} — ${r === 'S' ? 'supporting, press to remove'
                : 'press to add as supporting'}"
              onclick="toggleSupport('${esc(t.id)}','${esc(d.id)}')"
              onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();toggleSupport('${esc(t.id)}','${esc(d.id)}')}"`
            : ''}>${r}</td>`; }).join('')}
      </tr>`).join('')}
      <tr class="tot"><td>Lead items</td>
        ${depts.map(d => `<td class="n">${list.filter(t => role(t.id, d.id) === 'L').length}</td>`).join('')}
      </tr></tbody></table>
    </div>
  </div>`;
}

/* ---------------------------------------------------------------- gantt */
/* Weeks across, tasks down, the same shape the workbook drew with conditional
   formatting. It is a table, not a chart library: the dates are already here
   and a coloured <td> is the whole of what a bar is. */
function ganttView() {
  const day = d => Math.floor(Date.parse(d) / 864e5);
  const today = Math.floor(Date.now() / 864e5);
  const all = DB.tasks.filter(t => (S.phase === 'All' || t.phase === S.phase) && t.startOn && t.deadline);
  if (!all.length) return `${topbar()}<div class="wrap">${tlHead(0, 0)}
    <div class="card"><div class="none"><b>Nothing to draw</b>
      No task in this phase has both a start date and a deadline.</div></div></div>`;

  /* The window.
     Everything the project has runs to twenty-nine weeks, and a single bar
     covers about two of them — so drawn end to end, nine tenths of every row
     was empty and the first screen showed almost nothing. The default is the
     fortnight behind and ten weeks ahead, which is the span somebody opening
     this actually needs; the full run is one click away. */
  const near = S.tlSpan !== 'full';
  const lo = near ? today - 14 : Math.min(...all.map(t => day(t.startOn)));
  const hi = near ? today + 70 : Math.max(...all.map(t => day(t.deadline)));
  const span = Math.max(hi - lo, 1);
  const pos = d => ((d - lo) / span) * 100;

  /* Ticks: weeks when the window is short enough to read them, months when
     it is not. */
  const ticks = [];
  if (near) {
    for (let w = lo - ((new Date(lo * 864e5).getUTCDay() || 7) - 1); w <= hi; w += 7)
      if (w >= lo) ticks.push([w, new Date(w * 864e5).toLocaleDateString('en-GB',
        { day: 'numeric', month: 'short' })]);
  } else {
    const d = new Date(lo * 864e5); d.setUTCDate(1);
    while (day(d.toISOString()) <= hi) {
      const x = day(d.toISOString());
      if (x >= lo) ticks.push([x, d.toLocaleDateString('en-GB', { month: 'short', year: '2-digit' })]);
      d.setUTCMonth(d.getUTCMonth() + 1);
    }
  }

  const phaseCls = p => ({ 'Phase 1 – IAUP Readiness': 'g1', 'Event – IAUP Meeting': 'g2',
                           'Phase 2 – Silver Jubilee': 'g3', 'Closeout & Care': 'g4' }[p] || 'g1');

  /* Grouped by phase, so a project of seventy-eight rows arrives as four
     headings you can fold away. */
  const bins = new Map();
  for (const t of all.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }))) {
    const k = t.phase || 'No phase';
    if (!bins.has(k)) bins.set(k, []);
    bins.get(k).push(t);
  }
  const order = PHASES.filter(Boolean).filter(x => bins.has(x))
    .concat([...bins.keys()].filter(k => !PHASES.includes(k)));

  let shown = 0, outside = 0;
  const section = (name) => {
    const rows = bins.get(name);
    const folded = S.tlShut.includes(name);
    const inWindow = rows.filter(t => day(t.deadline) >= lo && day(t.startOn) <= hi);
    outside += rows.length - inWindow.length;
    shown += inWindow.length;
    const late = rows.filter(t => t.effectiveStatus === 'Delayed').length;

    return `<section class="tl-sec">
      <button class="tl-fold" aria-expanded="${folded ? 'false' : 'true'}"
        onclick="toggleBand('${esc(name)}')">
        <span class="caret">${folded ? '▸' : '▾'}</span>${esc(name)}
        <span class="count${late ? ' bad' : ''}">${rows.length}</span>
        ${late ? `<span class="small">${late} delayed</span>` : ''}
      </button>
      ${folded ? '' : rows.map(t => {
        const a = day(t.startOn), b = day(t.deadline);
        if (b < lo || a > hi) return `<div class="tl-row off">
          <div class="tl-name">${t.parentId ? '<span class="ind">↳</span>' : ''}${taskLink(t.id)}
            ${esc(t.title)}</div>
          <div class="tl-track"><span class="tl-away">${b < lo ? 'ended ' + fmtDate(t.deadline)
            : 'starts ' + fmtDate(t.startOn)}</span></div></div>`;

        const from = Math.max(a, lo), to = Math.min(b, hi);
        const left = pos(from);
        const width = Math.max(pos(to) - left, 1.2);
        const done = t.effectiveProgress > 0
          ? Math.min(width * t.effectiveProgress, width) : 0;
        const cls = t.effectiveStatus === 'Delayed' ? 'late' : phaseCls(t.phase);
        const oneDay = a === b;
        return `<div class="tl-row">
          <div class="tl-name">${t.parentId ? '<span class="ind">↳</span>' : ''}${taskLink(t.id)}
            ${esc(t.title)}</div>
          <div class="tl-track" onclick="openTask('${t.id}')">
            ${oneDay
              ? `<i class="tl-bar dot bar-${cls}" style="left:${left}%"
                   title="${esc(t.title)} — ${fmtDate(t.deadline)}">◆</i>`
              : `<i class="tl-bar bar-${cls}" style="left:${left}%;width:${width}%"
                   title="${esc(t.title)} — ${fmtDate(t.startOn)} to ${fmtDate(t.deadline)}">
                   ${done ? `<b style="width:${(done / width) * 100}%"></b>` : ''}</i>`}
            <span class="tl-when${b > hi ? ' hide' : ''}"
              style="left:${Math.min(left + width, 97)}%">${fmtDate(t.deadline)}</span>
            ${a < lo ? '<span class="tl-edge l">‹</span>' : ''}
            ${b > hi ? '<span class="tl-edge r">›</span>' : ''}
          </div></div>`;
      }).join('')}
    </section>`;
  };
  const body = order.map(section).join('');

  return `${topbar()}<div class="wrap">
    ${tlHead(shown, outside)}
    <div class="card tl">
      <div class="tl-scale">
        <div class="tl-name"></div>
        <div class="tl-track">
          ${ticks.map(([d, l]) => `<span class="tl-tick" style="left:${pos(d)}%">${l}</span>`).join('')}
          ${today >= lo && today <= hi
            ? `<span class="tl-now" style="left:${pos(today)}%"><b>today</b></span>` : ''}
        </div>
      </div>
      ${body}
    </div>
  </div>`;
}

function tlHead(shown, outside) {
  const near = S.tlSpan !== 'full';
  return `<div class="rowhead">
      <h1>Timeline <span class="count">${shown}</span></h1>
      <div class="btns">
        <select onchange="setFilter({phase:this.value})">
          ${['All'].concat(PHASES.filter(Boolean)).map(x =>
            `<option ${S.phase === x ? 'selected' : ''}>${esc(x)}</option>`).join('')}
        </select>
        <button class="${near ? 'primary' : ''}" onclick="setFilter({tlSpan:'near'})">Next 12 weeks</button>
        <button class="${near ? '' : 'primary'}" onclick="setFilter({tlSpan:'full'})">Whole project</button>
      </div>
    </div>
    <p class="meta">The darker part of each bar is the share already done · red is delayed${
      outside ? ` · ${outside} outside this window` : ''}</p>`;
}

function toggleBand(name) {
  S.tlShut = S.tlShut.includes(name)
    ? S.tlShut.filter(x => x !== name) : S.tlShut.concat(name);
  render();
}

/* ------------------------------------------------------ student engagement */
function studentsView() {
  const may = MAY('students');
  const totalDays = DB.studentDays.reduce((a, d) => a + d.students * d.days, 0);
  return `${topbar()}<div class="wrap">
    <h1>Student engagement</h1>
    <p class="meta">Teams of seven or eight, each with a student leader and a named faculty supervisor.
      Hazardous work stays with qualified contractors.</p>

    <div class="card">
      <div class="rowhead"><h2>Teams <span class="count">${DB.teams.length}</span></h2>
        ${may ? `<button class="primary" onclick="newTeam()">+ New team</button>` : ''}</div>
      <table class="grid"><thead><tr><th>Team</th><th>Leader</th><th>Supervisor</th>
        <th class="n">Members</th><th>Tasks</th><th>Induction</th><th class="n">Hours</th>
        ${may ? '<th></th>' : ''}</tr></thead><tbody>
      ${DB.teams.map(t => `<tr>
        <td class="id">${esc(t.id)}</td>
        <td>${esc(t.leaderName || '—')}${t.leaderSid ? `<div class="small">${esc(t.leaderSid)}</div>` : ''}</td>
        <td>${t.supervisorId ? esc(userName(t.supervisorId)) : '<i>not named</i>'}</td>
        <td class="n ${t.members && (t.members < 7 || t.members > 8) ? 'bad' : ''}">${t.members || '—'}</td>
        <td class="small">${(t.taskIds || []).map(x => `${taskLink(x)}`).join(', ') || '—'}</td>
        <td class="dt ${!t.inductionOn ? 'bad' : ''}">${t.inductionOn ? fmtDate(t.inductionOn) : 'not done'}</td>
        <td class="n">${t.hoursVerified ?? t.hoursPlanned ?? '—'}</td>
        ${may ? `<td class="btns"><button onclick="editTeam('${t.id}')">Edit</button>
          ${KEEPER() ? `<button class="ghost" onclick="dropRow('student_teams','${t.id}','${esc(t.id)}')">Remove</button>` : ''}</td>` : ''}
      </tr>`).join('')}
      </tbody></table>
      <p class="small">Nobody works on site before the safety induction date is filled in.</p>
    </div>

    <div class="card">
      <div class="rowhead"><h2>Student-days <span class="count">${totalDays}</span></h2>
        ${may ? `<button class="primary" onclick="newDays()">+ New activity</button>` : ''}</div>
      <p class="small">Budget lines B23 and B24 multiply this total by their rate.</p>
      <table class="grid"><thead><tr><th>Line</th><th>Activity</th><th>Task</th>
        <th class="n">Students</th><th class="n">Days</th><th class="n">Student-days</th>
        ${may ? '<th></th>' : ''}</tr></thead><tbody>
      ${DB.studentDays.map(d => `<tr>
        <td class="id">${esc(d.id)}</td><td class="ti">${esc(d.activity)}</td>
        <td>${d.taskId ? `${taskLink(d.taskId)}` : '—'}</td>
        <td class="n">${d.students || '—'}</td><td class="n">${d.days || '—'}</td>
        <td class="n"><b>${d.students * d.days || '—'}</b></td>
        ${may ? `<td class="btns"><button onclick="editDays('${d.id}')">Edit</button>
          ${KEEPER() ? `<button class="ghost" onclick="dropRow('student_days','${d.id}','${esc(d.id)}')">Remove</button>` : ''}</td>` : ''}
      </tr>`).join('')}
      </tbody></table>
    </div>
  </div>`;
}

function editTeam(id) {
  const t = DB.teams.find(x => x.id === id);
  form(`Team ${id}`, [
    { k: 'leader_name', label: 'Student leader', value: t.leaderName },
    { k: 'leader_sid', label: 'Student ID', value: t.leaderSid },
    { k: 'supervisor_id', label: 'Faculty supervisor', type: 'select', options: peopleOptions(), value: t.supervisorId },
    { k: 'members', label: 'Members (7–8)', type: 'number', value: t.members },
    { k: 'course_map', label: 'Course / credit mapping', value: t.courseMap },
    { k: 'hours_planned', label: 'Approved hours', type: 'number', value: t.hoursPlanned },
    { k: 'hours_verified', label: 'Verified hours', type: 'number', value: t.hoursVerified },
    { k: 'induction_on', label: 'Safety induction', type: 'date', value: t.inductionOn },
    { k: 'viva_on', label: 'Viva / review', type: 'date', value: t.vivaOn },
    { k: 'roster_url', label: 'Role roster link', value: t.rosterUrl },
    { k: 'evidence_url', label: 'Evidence link', value: t.evidenceUrl },
    { k: 'remarks', label: 'Remarks', type: 'textarea', value: t.remarks },
  ], async (v) => {
    await api('/row', 'PATCH', { table: 'student_teams', id, changes: v });
    if (await boot()) { toast('Saved'); render(); }
  });
}

function editDays(id) {
  const d = DB.studentDays.find(x => x.id === id);
  form(`Line ${id}`, [
    { k: 'activity', label: 'Activity', value: d.activity },
    { k: 'students', label: 'Number of students', type: 'number', value: d.students },
    { k: 'days', label: 'Number of days', type: 'number', value: d.days },
    { k: 'note', label: 'Note', value: d.note },
  ], async (v) => {
    await api('/row', 'PATCH', { table: 'student_days', id, changes: v });
    if (await boot()) { toast('Saved'); render(); }
  });
}

/* ------------------------------------------------- department action plan */
function deptView() {
  const d = S.dept !== 'All' ? by(DB.departments, S.dept) : null;
  const mine = d ? DB.tasks.filter(t => t.leadDeptId === d.id)
    .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true })) : [];
  return `${topbar()}<div class="wrap">
    <div class="rowhead"><h1>Department action plan</h1>
      ${KEEPER() ? `<button class="primary" onclick="newDept()">+ New department</button>` : ''}
      <select onchange="setFilter({dept:this.value})">
        <option value="All">Pick a department…</option>
        ${DB.departments.map(x => `<option value="${esc(x.id)}" ${S.dept === x.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}
      </select></div>
    ${d ? `
      <div class="card">
        <h2>${esc(d.name)}</h2>
        ${d.responsibilities ? `<p class="small">${esc(d.responsibilities)}</p>` : ''}
        ${d.focalName ? `<p class="small">Focal person — <b>${esc(d.focalName)}</b></p>` : ''}
      </div>
      <div class="kpis">
        ${kpi('Items', mine.length, '')}
        ${kpi('Completed', mine.filter(t => t.effectiveStatus === 'Completed').length, '')}
        ${kpi('Delayed', mine.filter(t => t.effectiveStatus === 'Delayed').length,
              mine.filter(t => t.effectiveStatus === 'Delayed').length ? 'bad' : '')}
        ${kpi('Approved budget', money(DB.budget.filter(b => {
          const t = task(b.taskId); return t && t.leadDeptId === d.id;
        }).reduce((a, b) => a + (b.approved || 0), 0)), '')}
      </div>
      <div class="card">${mine.length ? taskRows(mine) : '<p class="small">Nothing led by this department.</p>'}</div>`
    : `<div class="card"><h2>All departments</h2>${deptTable()}</div>`}
  </div>`;
}

/* ------------------------------------------------------ chairman reference */
function referenceView() {
  return `${topbar()}<div class="wrap">
    <h1>Chairman's Execution Tracker v1.0</h1>
    <p class="meta">As issued. Nothing here can be changed — when the register and the original
      disagree, this is what the original said.</p>
    ${DB.reference.length ? `<div class="card scroll">
      <table class="grid"><thead><tr><th>Task</th><th>Workstream</th><th>Deliverable</th>
        <th>Priority</th><th>Owner (proposed)</th><th>Due</th><th>Status</th></tr></thead><tbody>
      ${DB.reference.map(r => {
        const live = task(r.taskId);
        const moved = live && live.deadline && r.dueOn &&
          String(live.deadline).slice(0, 10) !== String(r.dueOn).slice(0, 10);
        return `<tr>
          <td class="id">${live ? `${taskLink(r.taskId)}` : esc(r.taskId)}</td>
          <td>${esc(r.workstream)}</td><td class="ti">${esc(r.deliverable)}</td>
          <td>${esc(r.priority)}</td><td>${esc(r.owner)}</td>
          <td class="dt">${fmtDate(r.dueOn)}${moved ? `<div class="small bad">now ${fmtDate(live.deadline)}</div>` : ''}</td>
          <td>${esc(r.status)}</td></tr>`;
      }).join('')}
      </tbody></table></div>`
    : `<div class="card"><p class="small">Not loaded. Run the update SQL in Neon to bring it in.</p></div>`}
  </div>`;
}

/* ----------------------------------------------------------------- zones */
function surveyView() {
  return `${topbar()}<div class="wrap">
    <div class="rowhead"><h1>Survey zones <span class="count">${DB.survey.length}</span></h1>
      ${MAY('survey') ? `<button class="primary" onclick="newZone()">+ New zone</button>` : ''}</div>
    <div class="card"><table class="grid"><thead><tr>
      <th>ID</th><th>Zone</th><th>Location</th><th>Observation</th>
      <th>Route</th><th>Task</th><th>Condition</th>
      ${MAY('survey') ? '<th></th>' : ''}</tr></thead><tbody>
      ${DB.survey.map(s => `<tr>
        <td class="id">${esc(s.id)}</td><td>${esc(s.zone || '—')}</td>
        <td class="ti">${esc(s.location)}</td><td class="small">${esc(s.observation)}</td>
        <td>${esc(s.route)}</td>
        <td>${s.taskId ? `${taskLink(s.taskId)}` : '—'}</td>
        <td><span class="st ${s.condition === 'Unsafe' ? 'st-late'
          : s.condition === 'Not surveyed' ? 'st-pend' : 'st-done'}">${esc(s.condition)}</span>
          ${s.hazard ? ' <span class="warnpill">hazard</span>' : ''}
          ${s.confirmed ? '' : ' <span class="pill">indicative</span>'}</td>
        ${MAY('survey')
          ? `<td class="btns"><button onclick="editZone('${s.id}')">Edit</button>
             ${KEEPER() ? `<button class="ghost" onclick="dropRow('survey','${s.id}','${esc(s.id)}')">Remove</button>` : ''}</td>` : ''}
      </tr>`).join('')}
    </tbody></table></div>
  </div>`;
}

function editZone(id) {
  const z = DB.survey.find(x => x.id === id);
  form(`Zone ${id}`, [
    { k: 'zone', label: 'Zone', value: z.zone },
    { k: 'location', label: 'Site / location', value: z.location },
    { k: 'observation', label: 'Observation', type: 'textarea', value: z.observation },
    { k: 'condition', label: 'Condition', type: 'select', value: z.condition,
      options: ['Not surveyed', 'Good', 'Fair', 'Poor', 'Unsafe'] },
    { k: 'hazard', label: 'Hazard flagged', type: 'checkbox', value: z.hazard },
    { k: 'access_clear', label: 'Access / possession clear', type: 'select', value: z.accessClear,
      options: ['Pending', 'Yes', 'No'] },
    { k: 'approx_size', label: 'Approximate size', value: z.approxSize },
    { k: 'proposal', label: 'Proposed solution', type: 'textarea', value: z.proposal },
    { k: 'route', label: 'Implementation route', type: 'select', options: ROUTES, value: z.route },
    { k: 'dept_id', label: 'Implementing department', type: 'select', options: deptOptions(), value: z.deptId },
    { k: 'task_id', label: 'Linked task', type: 'select', value: z.taskId,
      options: [['', '— none —']].concat(DB.tasks.filter(t => t.isTask).map(t => [t.id, `${t.id} — ${t.title.slice(0, 40)}`])) },
    { k: 'before_url', label: 'Before photo link', value: z.beforeUrl },
    { k: 'confirmed', label: 'Confirmed after the survey', type: 'checkbox', value: z.confirmed },
    { k: 'remarks', label: 'Remarks', type: 'textarea', value: z.remarks },
  ], async (v) => {
    await api('/row', 'PATCH', { table: 'survey', id, changes: v });
    if (await boot()) { toast('Saved'); render(); }
  });
}

/* ------------------------------------------------------------------- log */
function tabHistory(t) {
  const list = DB.activity.filter(a =>
    (a.subject === 'task' && a.subjectId === t.id) ||
    (a.subject === 'photo' && a.subjectId === t.id) ||
    (a.subject === 'budget' && (a.note || '').includes(t.id)));
  return `<div class="card">
    <h2>Everything that has happened to ${esc(t.id)}</h2>
    ${list.length ? logRows(list) : '<p class="small">Nothing yet.</p>'}
    <p class="small">Written by the server as each change is made — not typed, and not editable.</p>
  </div>`;
}

function activityView() {
  return `${topbar()}<div class="wrap">
    <h1>Log</h1>
    <div class="card">${logRows(DB.activity)}</div>
  </div>`;
}

/* What an entry is about, in a form somebody can read.
   ------------------------------------------------------------------------
   The trail stores the subject's own id, which for a task is CL25-19 and
   worth printing, and for an account is a uuid — thirty-six characters of
   nothing, bolded at the front of every line. Worse after the account is
   removed, when there is no longer a name to resolve it to; and the line
   already says who it was about.

   So: a reference is printed when it reads as one, and otherwise the
   sentence stands on its own. */
function refOf(a) {
  const id = a && a.subjectId;
  if (!id) return '';
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    /* A uuid: useful only if it still names somebody. */
    const u = (DB.users || []).find(x => x.id === id);
    return u ? u.name : '';
  }
  return id;
}

function logRows(list) {
  return `<table class="grid log"><thead><tr>
      <th class="dt">When</th><th class="who">Who</th><th>What changed</th>
    </tr></thead><tbody>${list.map(a => `<tr>
    <td class="dt">${fmtWhen(a.at)}</td>
    <td class="who">${esc(a.userName || 'system')}</td>
    <td class="ti">${refOf(a) ? `<b class="ref">${esc(refOf(a))}</b> ` : ''}${esc(a.what)}
      ${a.was || a.now ? `<span class="small">${a.was ? `from ${esc(a.was)}` : ''}</span>` : ''}
      ${a.note ? `<div class="small">${esc(a.note)}</div>` : ''}</td>
  </tr>`).join('')}</tbody></table>`;
}

/* ---------------------------------------------------------------- people */
function peopleView() {
  const lock = DB.siteLock || { on: false, msg: '' };
  return `${topbar()}<div class="wrap">
    <h1>People</h1>
    ${KEEPER() ? `<div class="card">
      <h2>Site lock</h2>
      <p class="small">From gate G9 on 13 November until the IAUP meeting ends, no disruptive work
      is permitted on campus. Closing the site stops everyone but keyholders writing anything —
      enforced on the server, so a tab left open on a phone cannot write either.</p>
      <label class="chk"><input type="checkbox" ${lock.on ? 'checked' : ''}
        onchange="setLock(this.checked)"> Site closed to the field</label>
    </div>` : ''}
    ${peopleTable()}
  </div>`;
}

/* The account list, shown on People and again on the Administration page so
   that adding somebody and giving their role its permissions are one errand
   rather than two. */
function peopleTable() {
  const admin = MAY('users');
  return `<div class="card">
      <div class="rowhead"><h2>Accounts <span class="count">${DB.users.length}</span></h2>
      ${admin ? `<div class="btns">
        <button onclick="sendListAll()">&#9993; Send everyone their own list</button>
        <button class="primary" onclick="newUser()">+ Add</button>
      </div>` : ''}</div>
      <table class="grid"><thead><tr>
        <th>Name</th><th>Email</th><th>Copy to</th><th>Phone</th><th>Department</th>
        <th>Role</th><th></th></tr></thead><tbody>
      ${DB.users.map(u => `<tr class="${u.active ? '' : 'off'}">
        <td class="ti">${esc(u.name)}${u.hasPassword ? '' : ' <span class="pill">no password</span>'}
          ${u.active ? '' : ' <span class="pill">disabled</span>'}</td>
        <td class="small">${esc(u.email)}</td>
        <td class="small">${esc(u.ccEmail || '—')}</td>
        <td class="small">${esc(u.phone || '—')}${u.ipPhone
          ? `<div class="small">IP ${esc(u.ipPhone)}</div>` : ''}</td>
        <td>${esc(deptName(u.deptId))}</td>
        <td>${rolesHeld(u).map(r => `<span class="rtag">${esc(roleLabel(r))}</span>`).join(' ')}</td>
        <td class="btns">${admin ? `<button onclick="editUser('${u.id}')">Edit</button>
          <button class="ghost" onclick="sendList('${u.id}')"
            title="Email ${esc(u.name)} their own open tasks">Send list</button>
          <button class="ghost" onclick="setPw('${u.id}')">Password</button>
          ${u.id === DB.me.id ? ''
            : `<button class="ghost" onclick="dropUser('${u.id}')">Remove</button>`}` : ''}</td>
      </tr>`).join('')}
      </tbody></table>
      <p class="small">Accounts ending @cl25.local came from the tracker as posts rather than people.
      Give each a real DIU address as they are named — Edit now takes the address too.</p>
      <p class="small"><b>Remove</b> takes an account off the list for good, and only works if
      nothing in the record points at it. Somebody who has done work on this project is part of
      what happened: untick <b>Active</b> in Edit instead, which stops them signing in while
      every entry with their name on it still reads correctly.</p>
    </div>`;
}

function setLock(on) {
  if (!on) return sendLock(false, '');
  form('Close the system to changes', [
    { k: 'msg', label: 'What should people see?', type: 'textarea', required: true,
      value: 'The system is closed to changes during the no-disruptive-work period before the IAUP meeting.' },
  ], v => sendLock(true, v.msg), {
    ok: 'Close it',
    note: 'Everybody but a keyholder sees this notice and nothing else. Nothing can be '
        + 'changed until it is reopened.',
  });
}

async function sendLock(on, msg) {
  try {
    await api('/settings', 'PUT', { key: 'siteLock', value: { on, msg } });
    DB.siteLock = { on, msg };
    toast(on ? 'Site closed' : 'Site reopened'); render();
  } catch (e) {
    if (on) throw e;
    toast(e.message, true); render();
  }
}

/* Every role the system knows, including any made on the Roles page. It
   was a fixed list of six, so a role created in Administration could be
   given to nobody — the dropdown it had to be chosen from did not know it
   existed. */
const roleOptions = () => (DB.roles && DB.roles.length)
  ? DB.roles.map(r => [r.key, `${r.name} · ${r.key}`])
  : [['ADMIN', 'Administrator'], ['DIRECTOR', 'Project Director'],
     ['APPROVER', 'Approval authority'], ['DEPT_HEAD', 'Department head'],
     ['MEMBER', 'Responsible person'], ['VIEWER', 'Observer']];

/* The same list as ticks, with a word on what each one carries, because a
   person can hold more than one and the second is usually chosen for what it
   adds rather than for its name. */
const roleTicks = () => (DB.roles && DB.roles.length ? DB.roles : []).map(r => [
  r.key, r.name,
  [r.superApprove ? 'signs off for others' : '', r.keeper ? "acts on others' records" : '']
    .filter(Boolean).join(' · '),
]);

/** Every role a person holds, old single-role rows included. */
const rolesHeld = u => (u && Array.isArray(u.roles) && u.roles.length)
  ? u.roles : (u && u.role ? [u.role] : []);

const roleLabel = key => {
  const r = (DB.roles || []).find(x => x.key === key);
  return r ? r.name : key;
};

function newUser() {
  form('Add somebody', [
    { k: 'name', label: 'Name', required: true },
    { k: 'email', label: 'DIU email', type: 'email', required: true },
    { k: 'ccEmail', label: 'Copy to (optional)', type: 'email', hint: 'their head of department' },
    { k: 'empId', label: 'Employee ID' },
    { k: 'phone', label: 'Phone' },
    { k: 'ipPhone', label: 'IP phone', hint: 'campus extension' },
    { k: 'designation', label: 'Designation' },
    { k: 'deptId', label: 'Department', type: 'select', options: deptOptions() },
    { k: 'roles', label: 'Roles', type: 'tickset', options: roleTicks(), value: ['MEMBER'],
      full: true, hint: 'More than one is allowed. They get the best of each.' },
    { k: 'password', label: 'First password', required: true, hint: 'they must change it' },
  ], async (v) => {
    await api('/user', 'POST', v);
    if (await boot()) { toast('Added'); render(); }
  }, { ok: 'Add' });
}

function editUser(id) {
  const u = by(DB.users, id);
  form(`Edit ${u.name}`, [
    { k: 'name', label: 'Name', value: u.name },
    { k: 'email', label: 'DIU email', type: 'email', value: u.email, required: true },
    { k: 'ccEmail', label: 'Copy to', type: 'email', value: u.ccEmail },
    { k: 'empId', label: 'Employee ID', value: u.empId },
    { k: 'phone', label: 'Phone', value: u.phone },
    { k: 'ipPhone', label: 'IP phone', value: u.ipPhone, hint: 'campus extension' },
    { k: 'designation', label: 'Designation', value: u.designation },
    { k: 'deptId', label: 'Department', type: 'select', options: deptOptions(), value: u.deptId },
    { k: 'roles', label: 'Roles', type: 'tickset', options: roleTicks(), value: rolesHeld(u),
      full: true, hint: 'More than one is allowed. They get the best of each.' },
    { k: 'active', label: 'Active', type: 'checkbox', value: u.active },
  ], async (v) => {
    await api('/user', 'PATCH', { id, ...v });
    if (await boot()) { toast('Saved'); render(); }
  });
}

/* Removing an account, which only works for one the record does not
   mention. The server decides that and says what it found; this only has
   to ask once and pass the answer on. */
function dropUser(id) {
  const u = by(DB.users, id);
  if (!u) return;
  form(`Remove ${u.name}?`, [], async () => {
    await api('/user', 'DELETE', { id });
    if (await boot()) { toast('Removed'); render(); }
  }, { ok: 'Remove the account',
       note: `${u.name} (${u.email}) goes off the list for good. This only works if nothing in `
           + `the record points at them — no task, verification, approval, photograph or entry `
           + `in the trail. If anything does, the tasks holding it are listed, and the answer is `
           + `to open each one and name somebody else, or untick Active instead.`,
       /* "1 responsible for" leaves somebody to go and find out which task
          that is. Naming it, as a link, is the difference between a refusal
          and an instruction. */
       explain: (d) => {
         const holds = (d && d.holds) || [];
         if (!holds.length) return '';
         return `<ul class="holds">${holds.map(h => `<li>
           <b>${h.n}</b> ${esc(h.says)}${h.tasks && h.tasks.length
             ? ' — ' + h.tasks.map(id =>
                 `<a onclick="closeDialogs();go('task',{taskId:'${esc(id)}'})">${esc(id)}</a>`)
                 .join(', ') + (h.n > h.tasks.length ? ` and ${h.n - h.tasks.length} more` : '')
             : ''}</li>`).join('')}</ul>`;
       } });
}

/** Shut whatever dialog is open, for a link inside one that goes elsewhere. */
function closeDialogs() {
  document.querySelectorAll('dialog[open]').forEach(d => { d.close(); d.remove(); });
}

function setPw(id) {
  const u = by(DB.users, id);
  form(`Password for ${u.name}`, [
    { k: 'password', label: 'New password', required: true, hint: 'at least eight characters' },
  ], async (v) => {
    await api('/user', 'PATCH', { id, password: v.password });
    toast('Set. They will be asked to change it.');
  }, { note: 'Signs them out everywhere, and they must change it when they next sign in.' });
}

/* ------------------------------------------------------------------ init */
(async function init() {
  /* The address bar is read first, so a bookmark or a pasted link opens the
     page it names rather than Home. */
  if (await boot()) { readUrl(); render(); }
  else { S.user = null; render(); }
})();

/* ========================================================= administration =
   Three tabs. People is the account list that already existed; Roles is the
   grid of who may reach what; Data is the recycle bin and the two ways to
   clear the project. */

const ADMIN = { tab: 'roles', trash: [], roles: [], locked: [], builtin: [], counts: {},
                link: { slug: '', on: false }, store: null, scanning: false, loaded: false,
                chats: null };

async function loadAdmin() {
  const d = await api('/admin');
  ADMIN.trash = d.trash || []; ADMIN.roles = d.roles || [];
  ADMIN.locked = d.locked || []; ADMIN.builtin = d.builtin || [];
  ADMIN.counts = d.counts || {}; ADMIN.link = d.link || { slug: '', on: false };
  ADMIN.loaded = true;
}

function adminView() {
  if (!ADMIN.loaded) { loadAdmin().then(render).catch(e => { toast(e.message, true); }); }
  const tabs = [['roles', 'Roles'], ['data', 'Recycle bin and data'],
                ['backup', 'Backup'], ['storage', 'Storage'],
                ['link', "Chairman's link"], ['people', 'People']];
  return `${topbar()}<div class="wrap">
    <h1>Administration</h1>
    <p class="meta">Who may reach what, what has been removed, and how to clear the project.</p>
    <nav class="tabs noprint">${tabs.map(([k, l]) =>
      `<a href="/admin" class="${ADMIN.tab === k ? 'on' : ''}"
         onclick="ADMIN.tab='${k}';render();return false">${l}</a>`).join('')}</nav>
    ${!ADMIN.loaded ? '<div class="booting"><span class="spin"></span>Reading the settings…</div>'
      : ADMIN.tab === 'roles' ? adminRoles()
      : ADMIN.tab === 'data' ? adminData()
      : ADMIN.tab === 'backup' ? adminBackup()
      : ADMIN.tab === 'storage' ? adminStorage()
      : ADMIN.tab === 'link' ? adminLink()
      : peopleTable()}
  </div>`;
}

/* ------------------------------------------------------------- the grid */
const LEVELS = [['none', '—'], ['read', 'Read'], ['edit', 'Edit']];
const SECTIONS = [
  ['tasks', 'Task register'], ['photos', 'Photographs'], ['budget', 'Budget'],
  ['approvals', 'Decisions'], ['milestones', 'Gates'], ['survey', 'Zones'],
  ['students', 'Student teams'], ['reports', 'Dashboard'], ['reference', "Chairman's tracker"],
  ['activity', 'Log'], ['users', 'People'], ['admin', 'Administration'],
];

function adminRoles() {
  return `<div class="alert"><b>i</b><div>
    <b>Read</b> lets somebody open a section. <b>Edit</b> lets them change their own
    records in it — the task they are responsible for, the verification they were
    named for. <b>Acts on others' records</b> is separate: it lets a role reassign
    work and correct somebody else's figures.
    <div class="small"><b>Super approve</b> is separate again: it records a verification
    or an approval <i>on behalf of</i> the person it is waiting on, for when that person
    is away or is a post nobody holds yet. The record still names them as the one who
    signed off; the trail names who recorded it and why.</div>
    <div class="small">Nobody verifies or approves their own work, whatever is set here.
    That rule is in the database and no permission can reach it.</div></div></div>

  <div class="card scroll">
    <table class="grid roles"><thead><tr>
      <th class="nm">Role</th>
      <th class="rot" title="May act on records that are not their own"><span>Others' records</span></th>
      <th class="rot" title="May record a sign-off on behalf of the person it waits on"><span>Super approve</span></th>
      ${SECTIONS.map(([, l]) => `<th class="rot"><span>${esc(l)}</span></th>`).join('')}
      <th class="btns"></th>
    </tr></thead><tbody>
    ${ADMIN.roles.map((r, i) => {
      const lock = ADMIN.locked.includes(r.key);
      return `<tr>
        <td class="nm">${esc(r.name)}<div class="small">${esc(r.key)}${lock ? ' · fixed' : ''}</div></td>
        <td class="n"><input type="checkbox" ${r.keeper ? 'checked' : ''} ${lock ? 'disabled' : ''}
          aria-label="${esc(r.name)} may act on other people's records"
          onchange="ADMIN.roles[${i}].keeper=this.checked"></td>
        <td class="n"><input type="checkbox" ${r.superApprove ? 'checked' : ''} ${lock ? 'disabled' : ''}
          aria-label="${esc(r.name)} may sign off on somebody else's behalf"
          onchange="ADMIN.roles[${i}].superApprove=this.checked"></td>
        ${SECTIONS.map(([k]) => `<td class="rl">
          <select ${lock ? 'disabled' : ''} aria-label="${esc(r.name)} — ${esc(k)}"
            onchange="ADMIN.roles[${i}].perms['${k}']=this.value">
            ${LEVELS.map(([v, l]) =>
              `<option value="${v}" ${(r.perms[k] || 'none') === v ? 'selected' : ''}>${l}</option>`).join('')}
          </select></td>`).join('')}
        <td class="btns">${lock || ADMIN.builtin.includes(r.key) ? ''
          : `<button class="ghost" onclick="dropRole('${esc(r.key)}')">Remove</button>`}</td>
      </tr>`;
    }).join('')}
    </tbody></table>
  </div>
  <div class="btns">
    <button class="primary" onclick="saveRoles()">Save the roles</button>
    <button onclick="newRole()">+ New role</button>
    <button class="ghost" onclick="ADMIN.loaded=false;render()">Discard changes</button>
  </div>`;
}

function newRole() {
  form('A new role', [
    { k: 'name', label: 'Call it', required: true, hint: 'for example, Treasurer\'s assistant' },
    { k: 'key', label: 'Short key', required: true, hint: 'letters and numbers, no spaces — TREASURY_ASST' },
  ], async (v) => {
    const key = v.key.toUpperCase().replace(/[^A-Z0-9_]/g, '');
    if (!key) throw new Error('The key needs at least one letter.');
    if (ADMIN.roles.some(r => r.key === key)) throw new Error(`There is already a role called ${key}.`);
    const perms = {};
    SECTIONS.forEach(([k]) => { perms[k] = 'none'; });
    ADMIN.roles.push({ key, name: v.name, keeper: false, superApprove: false, perms });
    render();
  });
}

function dropRole(key) {
  const inUse = DB.users.filter(u => rolesHeld(u).includes(key));
  if (inUse.length) return toast(
    `${inUse.length} ${inUse.length === 1 ? 'person is' : 'people are'} on that role. Move them first.`, true);
  ADMIN.roles = ADMIN.roles.filter(r => r.key !== key);
  render();
}

async function saveRoles() {
  try {
    const d = await api('/admin', 'POST', { act: 'roles', roles: ADMIN.roles });
    ADMIN.roles = d.roles;
    toast('Saved');
    if (await boot()) render();
  } catch (e) { toast(e.message, true); }
}

/* ----------------------------------------------------------- storage --- */
/* The bucket only ever grows, and until now nothing said why.

   A photograph taken off a task keeps its file on purpose — it was part of
   an audit record once. An upload interrupted halfway keeps its file for
   no reason at all. In Cloudflare the two look identical; here they do
   not, because the register is asked which keys it still knows about. */
const mb = n => {
  const x = Number(n) || 0;
  return x >= 1048576 ? `${(x / 1048576).toFixed(1)} MB`
       : x >= 1024 ? `${Math.round(x / 1024)} KB` : `${x} B`;
};

/* ===================================================== a copy that leaves =
   A database somebody else hosts is a database somebody else can lose. Neon
   winds itself back a few days, which covers a mistake and not an account
   closed or a region gone — so the record also leaves the building, hourly,
   as a file the project office holds in Telegram. */
/* A moment, in the time zone of whoever is reading it. The backup records the
   moment in UTC, as a moment should be recorded; a project office in Dhaka
   reading "16:37" for a ten-at-night backup would reasonably think it had not
   run. */
function dhaka(iso) {
  const t = Date.parse(iso || '');
  if (isNaN(t)) return '—';
  const d = new Date(t + 6 * 60 * 60 * 1000);
  const z = n => String(n).padStart(2, '0');
  return `${z(d.getUTCDate())} ${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct',
    'Nov','Dec'][d.getUTCMonth()]} ${String(d.getUTCFullYear()).slice(2)}, `
    + `${z(d.getUTCHours())}:${z(d.getUTCMinutes())}`;
}

function adminBackup() {
  const last = (DB.settings && DB.settings.backup_last) || null;
  const chats = ADMIN.chats;
  return `<div class="card">
    <h2>Backup</h2>
    <p class="small">Everything the system holds — tasks and sub-tasks, the budget, the
      decisions, the gates, the zones, the student teams, the accounts and the trail — in
      one file.</p>
    <div class="btns">
      <button class="primary" onclick="getBackup('json')">⬇ Download backup (JSON)</button>
      <button onclick="getBackup('sql')">⬇ Download SQL dump</button>
      <button class="ghost danger" onclick="pickRestore()">↺ Restore from a JSON backup</button>
    </div>

    <div class="card inner">
      <div class="rowhead"><h2 style="font-size:15px">Copy to Telegram</h2></div>
      <p class="small">A JSON copy goes to your Telegram channel every hour — but only when
        something has changed, so a quiet night sends nothing. Every evening both files go
        regardless, so there is one certain copy a day with the date on it.
        ${last ? `<br><b>Last sent:</b> ${esc(dhaka(last.at))}
          · ${esc(last.how || '')}${(last.failed || []).length
            ? ` · <span class="bad">failed: ${esc((last.failed || []).join(', '))}</span>` : ''}`
          : '<br>Nothing has been sent yet.'}</p>
      <div class="btns">
        <button onclick="findChannel()">⌕ Find my channel</button>
        <button onclick="sendBackup('json')">✈ Send JSON now</button>
        <button onclick="sendBackup('sql')">✈ Send SQL now</button>
      </div>
      ${chats ? (chats.ok ? (chats.chats.length ? `<table class="grid"><thead><tr>
          <th>Chat</th><th>Kind</th><th>Chat ID</th><th></th></tr></thead><tbody>
          ${chats.chats.map(c => `<tr><td class="ti">${esc(c.name)}</td><td>${esc(c.kind)}</td>
            <td><code>${esc(c.id)}</code></td>
            <td>${String(c.id) === String(chats.using)
              ? '<span class="pill">in use</span>' : ''}</td></tr>`).join('')}
        </tbody></table>
        <p class="small">Put the one you want in <b>TELEGRAM_CHAT_ID</b> on Vercel, then redeploy.</p>`
        : `<p class="small">The bot has not heard from any chat. Send it a message, or add it
           to the channel as an administrator, then press Find my channel again.</p>`)
        : `<div class="alert warn"><b>!</b><div>${esc(chats.reason)}</div></div>`) : ''}
    </div>

    <p class="small"><b>JSON</b> is the one this system reads back — Restore takes that and
      nothing else. <b>SQL</b> is a plain Postgres dump, the schema and every row, which any
      Postgres will take: it is how the record survives this software, and how the project
      would move to a university server. Passwords are stored as one-way hashes — unreadable,
      and everybody can still sign in with the password they already know. Keep the file
      private all the same, and off GitHub.</p>
  </div>`;
}

async function getBackup(kind) {
  toast('Building the file…');
  try {
    const r = await fetch('/api/state/backup?format=' + kind);
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'It could not be built.');
    const blob = await r.blob();
    const name = (/filename="([^"]+)"/.exec(r.headers.get('content-disposition') || '') || [])[1]
              || `CL25-backup.${kind}.gz`;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
    toast('Downloaded ' + name);
  } catch (e) { toast(e.message, true); }
}

async function sendBackup(kind) {
  try {
    toast('Sending…');
    const d = await api('/backup', 'POST', { act: 'send', format: kind });
    toast('Sent ' + d.name);
    if (await boot()) render();
  } catch (e) { toast(e.message, true); }
}

async function findChannel() {
  try {
    ADMIN.chats = await api('/backup', 'POST', { act: 'chats' });
    render();
  } catch (e) { toast(e.message, true); }
}

/* ---- putting one back ----
   Two steps on purpose. The file is read and its numbers shown beside what is
   live before anything is touched, because the mistake this guards against is
   not pressing the wrong button — it is restoring a week-old copy over a day's
   work without having seen the two numbers side by side. */
function pickRestore() {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = '.gz,.json,application/json,application/gzip';
  inp.onchange = async () => {
    const f = inp.files && inp.files[0];
    if (!f) return;
    try {
      toast('Reading the file…');
      const text = f.name.endsWith('.gz')
        ? await (async () => {
            const buf = new Uint8Array(await f.arrayBuffer());
            let s = '';
            for (let i = 0; i < buf.length; i += 8192)
              s += String.fromCharCode.apply(null, buf.subarray(i, i + 8192));
            return btoa(s);
          })()
        : await f.text();
      const d = await api('/restore', 'POST', { file: text });
      showRestore(text, d);
    } catch (e) { toast(e.message, true); }
  };
  inp.click();
}

function showRestore(file, d) {
  const names = Object.keys(d.inFile).filter(k => d.inFile[k] || d.live[k] > 0);
  const rows = names.map(k => `<tr>
      <td class="ti">${esc(k.replace(/_/g, ' '))}</td>
      <td class="n">${d.live[k] < 0 ? '—' : d.live[k]}</td>
      <td class="n">${d.inFile[k]}</td>
      <td class="n ${d.inFile[k] < d.live[k] ? 'bad' : ''}">${
        d.live[k] < 0 ? '' : (d.inFile[k] - d.live[k] > 0 ? '+' : '') + (d.inFile[k] - d.live[k])}</td>
    </tr>`).join('');

  form('Restore the project', [
    { k: 'code', label: `Type ${'DIU-CL25-2026'} to confirm`, required: true, full: true },
  ], async (v) => {
    await api('/restore', 'POST', { act: 'apply', file, code: v.code });
    toast('Restored. Everybody has been signed out.');
    setTimeout(() => location.reload(), 1200);
  }, {
    ok: 'Replace the project with this file',
    wide: true,
    /* Red, because it is the one button in the application that throws away
       everything the project has done since the file was taken. */
    danger: true,
    note: `This backup was taken ${dhaka(d.takenAt)}. `
        + `Every table is emptied and refilled from it, in one go — it either all happens or `
        + `none of it does. Everybody is signed out afterwards. Photographs: the records come `
        + `back and name their files, but a file already deleted from storage does not return.`,
    html: `<table class="grid"><thead><tr><th>Table</th><th class="n">Now</th>
      <th class="n">In the file</th><th class="n">Change</th></tr></thead>
      <tbody>${rows}</tbody></table>`,
  });
}

function adminStorage() {
  const s = ADMIN.store;
  if (ADMIN.scanning) return '<div class="booting"><span class="spin"></span>Reading the bucket…</div>';
  if (!s) return `<div class="card">
    <h2>Photograph storage</h2>
    <p class="small">Counting the files in Cloudflare and asking the register which of them it
      still knows about. Nothing is changed by looking.</p>
    <div class="btns"><button class="primary" onclick="scanStore()">Scan the bucket</button></div>
  </div>`;
  if (!s.ready) return `<div class="card"><h2>Photograph storage</h2>
    <div class="alert warn"><b>!</b><div>Storage is not configured — see the R2_* settings.</div></div></div>`;

  const t = s.tally;
  return `<div class="kpis">
    <div class="kpi"><div class="v">${s.total}</div><div class="l">files in the bucket</div></div>
    <div class="kpi"><div class="v">${mb(s.bytes)}</div><div class="l">in all</div></div>
    <div class="kpi"><div class="v">${t.live.n}</div><div class="l">on a task now</div></div>
    <div class="kpi ${t.removed.n ? 'warn' : ''}"><div class="v">${t.removed.n}</div>
      <div class="l">taken off the register</div></div>
    <div class="kpi ${t.orphan.n ? 'warn' : ''}"><div class="v">${t.orphan.n}</div>
      <div class="l">nothing points at</div></div>
  </div>

  <div class="card">
    <h2>What is in there</h2>
    <table class="grid"><thead><tr><th>Pile</th><th class="n">Files</th><th class="n">Size</th>
      <th>What it is</th></tr></thead><tbody>
      <tr><td><b>On a task</b></td><td class="n">${t.live.n}</td><td class="n">${mb(t.live.bytes)}</td>
        <td class="ti">A live photograph points at it. Leave it alone.</td></tr>
      <tr><td><b>In the recycle bin</b></td><td class="n">${t.bin.n}</td><td class="n">${mb(t.bin.bytes)}</td>
        <td class="ti">It belongs to a task somebody removed. It comes back with the task,
          and goes for good when the bin is emptied.</td></tr>
      <tr><td><b>Taken off the register</b></td><td class="n">${t.removed.n}</td>
        <td class="n">${mb(t.removed.bytes)}</td>
        <td class="ti">Somebody pressed Remove on the photograph. The file was kept on purpose,
          because it had been part of the record. The trail of who removed it stays either way.</td></tr>
      <tr><td><b>Nothing points at it</b></td><td class="n">${t.orphan.n}</td>
        <td class="n">${mb(t.orphan.bytes)}</td>
        <td class="ti">An upload that did not finish — the file went up, the record never
          did. Nobody can see these, and nothing will ever use them.</td></tr>
      <tr><td><b>Too new to judge</b></td><td class="n">${t.young.n}</td>
        <td class="n">${mb(t.young.bytes)}</td>
        <td class="ti">Written in the last day. It may be an upload still on its way,
          so it is left alone.</td></tr>
    </tbody></table>
    ${s.capped ? '<p class="small">Only the first ten thousand files were read.</p>' : ''}
  </div>

  <div class="card act">
    <h2>Clearing it</h2>
    <div class="two">
      <div>
        <b>Delete what nothing points at</b>
        <p class="small">${t.orphan.n} file${t.orphan.n === 1 ? '' : 's'},
          ${mb(t.orphan.bytes)}. These are failed uploads. No record mentions them and
          nothing on any screen will change.</p>
        <button ${t.orphan.n ? '' : 'disabled'} onclick="sweepStore('orphan')">Delete the ${t.orphan.n} orphans</button>
      </div>
      <div>
        <b class="bad">Delete what was taken off the register</b>
        <p class="small">${t.removed.n} file${t.removed.n === 1 ? '' : 's'},
          ${mb(t.removed.bytes)}. These were once evidence on a task. The entry in the trail
          stays, but the picture will be gone and cannot be put back.</p>
        <button class="danger" ${t.removed.n ? '' : 'disabled'}
          onclick="sweepStore('removed')">Delete the ${t.removed.n} files</button>
      </div>
    </div>
  </div>

  <div class="btns"><button class="ghost" onclick="scanStore()">Scan again</button></div>`;
}

async function scanStore() {
  ADMIN.scanning = true; render();
  try {
    const d = await api('/admin', 'POST', { act: 'storage' });
    ADMIN.store = d.storage;
  } catch (e) { toast(e.message, true); }
  ADMIN.scanning = false; render();
}

function sweepStore(which) {
  const orphan = which === 'orphan';
  form(orphan ? 'Delete the orphaned files' : 'Delete the files taken off the register', [
    { k: 'confirm', label: 'Type DIU-CL25-2026 to confirm', required: true },
  ], async (v) => {
    const d = await api('/admin', 'POST', { act: 'sweep', which, confirm: v.confirm });
    toast(`${d.swept.gone} file${d.swept.gone === 1 ? '' : 's'} deleted`);
    ADMIN.store = null;
    await scanStore();
  }, {
    ok: orphan ? 'Delete them' : 'Delete them for good',
    note: orphan
      ? 'These belong to uploads that never finished. Nothing in the register points at them, so nothing on screen will change. Files written in the last day are left alone in case an upload is still on its way.'
      : 'These photographs were removed from their tasks. The record of who removed them and why stays; the pictures themselves will be gone from Cloudflare and cannot be recovered.',
  });
}

/* ------------------------------------------------- the Chairman's link --- */
/* A read-only overview of the project behind one address, with no sign-in,
   so it can be given to somebody who will never hold an account here.

   The address is the whole of the protection. That is worth saying on the
   page rather than in a comment, because the person choosing the words is
   choosing how hard it is to guess — and the page says it. */
function adminLink() {
  const l = ADMIN.link || { slug: '', on: false };
  const url = l.slug ? `${location.origin}/c/${l.slug}` : '';
  return `<div class="card">
    <h2>A link for the Chairman</h2>
    <p class="small">Whoever opens this address sees the project: the roll-ups, the gates,
      what is late, the department workload and the budget totals. Nothing on it can be
      changed, and no email address or telephone number appears on it. There is no sign-in,
      so <b>anyone who has the address is in</b> — choose words that would not be guessed,
      and send it to the Chairman's office rather than posting it anywhere.</p>

    <div class="field">
      <label for="cl">The address</label>
      <div class="pathbox">
        <span>${esc(location.origin)}/c/</span>
        <input id="cl" value="${esc(l.slug)}" spellcheck="false" autocomplete="off"
               placeholder="chairman-office-2026" aria-label="The part of the address you choose">
      </div>
      <p class="small">Letters, numbers, dashes and dots. At least four characters.</p>
    </div>

    <label class="chk sw"><input id="clon" type="checkbox" ${l.on ? 'checked' : ''}>
      <b>The link is open</b> — untick it and the address stops working at once</label>

    <div class="btns">
      <button class="primary" onclick="saveLink()">Save</button>
      ${l.on && url ? `<button onclick="copyLink('${esc(url)}')">Copy the address</button>
        <a class="ghost btn" href="${esc(url)}" target="_blank" rel="noopener">Open it</a>` : ''}
    </div>

    ${l.on && url ? `<p class="ok">✓ Open now at <b class="ref">${esc(url)}</b>${l.setBy
      ? ` · set by ${esc(l.setBy)}` : ''}</p>`
      : `<p class="small">${l.slug
        ? 'The address is saved but switched off, so it answers "not open".'
        : 'Nothing is published yet.'}</p>`}
  </div>`;
}

async function saveLink() {
  const slug = ($('cl') || {}).value || '';
  const on = !!(($('clon') || {}).checked);
  try {
    const d = await api('/admin', 'POST', { act: 'link', slug, on });
    ADMIN.link = d.link;
    toast(d.link.on ? 'The link is open' : 'The link is off');
    render();
  } catch (e) { toast(e.message, true); }
}

function copyLink(url) {
  const done = () => toast('Address copied');
  if (navigator.clipboard && navigator.clipboard.writeText)
    navigator.clipboard.writeText(url).then(done, () => toast('Copy it from the box above.', true));
  else toast('Copy it from the box above.', true);
}

/* --------------------------------------------------- the bin, and clearing */
function adminData() {
  const c = ADMIN.counts || {};
  const live = ['task', 'budget', 'approval', 'milestone', 'survey', 'team', 'student_day', 'photo']
    .reduce((a, k) => a + (c[k] || 0), 0);

  return `<div class="kpis">
    ${[['task', 'Tasks'], ['budget', 'Budget lines'], ['approval', 'Decisions'],
       ['milestone', 'Gates'], ['survey', 'Zones'], ['photo', 'Photographs']]
      .map(([k, l]) => `<div class="kpi"><div class="v">${c[k] || 0}</div><div class="l">${l}</div></div>`).join('')}
    <div class="kpi ${c.trash ? 'warn' : ''}"><div class="v">${c.trash || 0}</div><div class="l">In the bin</div></div>
  </div>

  <div class="card">
    <div class="rowhead"><h2>Recycle bin <span class="count">${ADMIN.trash.length}</span></h2>
      ${ADMIN.trash.length ? `<button class="ghost" onclick="emptyBin()">Empty the bin</button>` : ''}</div>
    ${ADMIN.trash.length ? `<table class="grid"><thead><tr>
        <th class="id">Ref</th><th>What it was</th><th class="dt">Removed</th>
        <th class="who">By</th><th class="btns">Action</th>
      </tr></thead><tbody>
      ${ADMIN.trash.map(t => `<tr>
        <td class="id">${esc(t.recordId)}</td>
        <td class="ti">${esc(t.label)}
          <div class="small">${esc(kindName(t.kind))}${t.children
            ? ` · with ${t.children} attached record${t.children === 1 ? '' : 's'}` : ''}</div></td>
        <td class="dt">${fmtWhen(t.at)}</td>
        <td class="who">${esc(t.by || '—')}</td>
        <td class="btns">
          <button onclick="restoreItem(${t.id})">Put back</button>
          <button class="ghost" onclick="purgeItem(${t.id},'${esc(t.label).replace(/'/g, "\\'")}')">Delete</button>
        </td></tr>`).join('')}
      </tbody></table>`
      : `<div class="none"><b>The bin is empty</b>
          Anything removed anywhere in the application waits here until you empty it.</div>`}
  </div>

  <div class="card act">
    <h2>Clear the project</h2>
    <p class="small"><b>Both keep</b> the accounts, the departments and the roles, because
      without them there is no way back in. <b>Both clear</b> tasks and sub-tasks, budget
      lines, decisions and their approval steps, gates, zones, student teams and days,
      photographs, the responsibility matrix, and the Chairman's tracker.</p>
    <div class="two">
      <div>
        <b>Reset the register</b>
        <p class="small">Moves all ${live} working record${live === 1 ? '' : 's'} — tasks, budget,
          decisions, gates, zones, teams and photographs — and the Chairman's tracker
          into the recycle bin. Everything can be put back.</p>
        <button onclick="clearData('reset')">Reset the register</button>
      </div>
      <div>
        <b class="bad">Erase everything</b>
        <p class="small">Deletes those records and the bin for good, and removes the
          photograph files from Cloudflare storage. There is no step after this one.</p>
        <button class="danger" onclick="clearData('erase')">Erase everything</button>
      </div>
    </div>
  </div>`;
}

const kindName = k => ({
  task: 'Task', budget: 'Budget line', approval: 'Decision', milestone: 'Gate',
  survey: 'Zone', team: 'Student team', student_day: 'Student day',
  photo: 'Photograph', department: 'Department', user: 'Account', step: 'Approval step',
  chairman_reference: "Chairman's tracker",
}[k] || k);

async function restoreItem(id) {
  try {
    const d = await api('/admin', 'POST', { act: 'restore', id });
    toast(`${d.restored.label} is back`);
    ADMIN.loaded = false;
    if (await boot()) render();
  } catch (e) { toast(e.message, true); }
}

function purgeItem(id, label) {
  form('Delete for good', [], async () => {
    await api('/admin', 'POST', { act: 'purge', id });
    toast('Deleted');
    ADMIN.loaded = false;
    if (await boot()) render();
  }, { note: `${label} will be gone for good, and any photographs with it will be removed from storage. This cannot be undone.`, ok: 'Delete for good' });
}

function emptyBin() {
  form('Empty the recycle bin', [], async () => {
    const d = await api('/admin', 'POST', { act: 'purge' });
    toast(`${d.purged.entries} item${d.purged.entries === 1 ? '' : 's'} deleted`);
    ADMIN.loaded = false;
    if (await boot()) render();
  }, { note: 'Everything in the bin will be gone for good, and the photographs in it will be removed from Cloudflare storage. This cannot be undone.', ok: 'Empty the bin' });
}

function clearData(act) {
  const reset = act === 'reset';
  form(reset ? 'Reset the register' : 'Erase everything', [
    { k: 'confirm', label: `Type DIU-CL25-2026 to confirm`, required: true },
  ], async (v) => {
    const d = await api('/admin', 'POST', { act, confirm: v.confirm });
    toast(reset ? `${d.moved} records moved to the recycle bin`
                : `${d.wiped} records erased`);
    ADMIN.loaded = false;
    if (await boot()) render();
  }, {
    note: reset
      ? "Every task, budget line, decision, gate, zone, team and photograph, and the Chairman's tracker, goes to the recycle bin. Accounts, departments and roles are kept. You can put it all back."
      : "Every task, budget line, decision, gate, zone, team and photograph, and the Chairman's tracker, is deleted for good, the recycle bin is emptied, and the photograph files are removed from Cloudflare storage. Accounts, departments and roles are kept. There is no way back.",
    ok: reset ? 'Move it all to the bin' : 'Erase it all',
  });
}


/* ------------------------------------------------------- a new decision */
/* The workbook came with eighteen and no nineteenth. */
function newDecision() {
  form('A new decision', [
    { k: 'item', label: 'What is being decided', required: true },
    { k: 'finalAuthority', label: 'Who decides', hint: 'the post, as the tracker writes it' },
    { k: 'taskId', label: 'About which task', required: true, type: 'select',
      options: DB.tasks.filter(t => t.isTask)
        .map(t => [t.id, `${t.id} · ${t.title.slice(0, 48)}`]) },
    { k: 'verifierId', label: 'Verified by', type: 'select', options: peopleOptions('') },
    { k: 'dueOn', label: 'Due by', type: 'date' },
    { k: 'chairmanNeeded', label: "The Chairman's own sign-off is needed", type: 'checkbox' },
  ], async (v) => {
    const r = await api('/approval', 'POST', v);
    if (await boot()) { toast(`${r.id} added`); render(); }
  });
}

function dropDecision(id) {
  const a = DB.approvals.find(x => x.id === id) || {};
  const decided = ['Approved', 'Approved with conditions', 'Rejected'].includes(a.decision);
  form(`Remove ${id}`, [
    { k: 'reason', label: 'Why', required: decided,
      hint: decided ? 'this one has already been decided' : 'optional' },
  ], async (v) => {
    await api('/approval', 'DELETE', { id, reason: v.reason });
    if (await boot()) { toast(`${id} is in the recycle bin`); render(); }
  }, { note: 'It goes to the recycle bin on the Administration page, with its approval steps. Nothing is lost until the bin is emptied.',
       ok: 'Move to the bin' });
}

/* ===================================================== adding to the lists =
   The zones, the teams, the activities and the departments arrived from the
   workbook and could only ever be edited. These are the same forms the Edit
   buttons use, with nothing filled in, pointed at POST instead of PATCH. */

function newZone() {
  form('A new zone', [
    { k: 'zone', label: 'Zone', hint: 'Z01, Z02…' },
    { k: 'location', label: 'Where it is', required: true },
    { k: 'observation', label: 'What was seen' },
    { k: 'dept_id', label: 'Department', type: 'select', options: deptOptions() },
    { k: 'task_id', label: 'Against which task', type: 'select',
      options: [['', '— none —']].concat(DB.tasks.filter(t => t.isTask)
        .map(t => [t.id, `${t.id} · ${t.title.slice(0, 44)}`])) },
    { k: 'route', label: 'Implementation route', type: 'select', options: ROUTES },
    { k: 'condition', label: 'Condition', type: 'select',
      options: ['Not surveyed', 'Good', 'Fair', 'Poor', 'Unsafe'], value: 'Not surveyed' },
    { k: 'approx_size', label: 'Approximate size' },
    { k: 'hazard', label: 'A hazard is present', type: 'checkbox' },
    { k: 'remarks', label: 'Remarks', type: 'textarea' },
  ], async (v) => {
    const r = await api('/row', 'POST', { table: 'survey', values: v });
    if (await boot()) { toast(`${r.id} added`); render(); }
  }, { ok: 'Add the zone' });
}

function newTeam() {
  form('A new student team', [
    { k: 'leader_name', label: 'Student leader', required: true },
    { k: 'leader_sid', label: 'Student ID' },
    { k: 'supervisor_id', label: 'Faculty supervisor', type: 'select', options: peopleOptions() },
    { k: 'members', label: 'Members (7–8)', type: 'number', value: 7 },
    { k: 'course_map', label: 'Course / credit mapping' },
    { k: 'hours_planned', label: 'Approved hours', type: 'number' },
    { k: 'induction_on', label: 'Safety induction', type: 'date' },
    { k: 'remarks', label: 'Remarks', type: 'textarea' },
  ], async (v) => {
    const r = await api('/row', 'POST', { table: 'student_teams', values: v });
    if (await boot()) { toast(`${r.id} added`); render(); }
  }, { ok: 'Add the team' });
}

function newDays() {
  form('A new activity', [
    { k: 'activity', label: 'What the students will do', required: true },
    { k: 'task_id', label: 'Against which task', type: 'select',
      options: [['', '— none —']].concat(DB.tasks.filter(t => t.isTask)
        .map(t => [t.id, `${t.id} · ${t.title.slice(0, 44)}`])) },
    { k: 'students', label: 'How many students', type: 'number' },
    { k: 'days', label: 'How many days', type: 'number' },
    { k: 'note', label: 'Note', type: 'textarea' },
  ], async (v) => {
    const r = await api('/row', 'POST', { table: 'student_days', values: v });
    if (await boot()) { toast(`${r.id} added`); render(); }
  }, { ok: 'Add the activity' });
}

function newDept() {
  form('A new department', [
    { k: 'name', label: 'Department', required: true },
    { k: 'responsibilities', label: 'What it is responsible for', type: 'textarea' },
    { k: 'focal_user_id', label: 'Focal person', type: 'select', options: peopleOptions() },
    { k: 'active', label: 'Active', type: 'checkbox', value: true },
  ], async (v) => {
    const r = await api('/row', 'POST', { table: 'departments', values: v });
    if (await boot()) { toast(`${v.name} added`); render(); }
  }, { ok: 'Add the department' });
}

/** One remover for all four. Everything goes to the recycle bin. */
function dropRow(table, id, label) {
  form(`Remove ${label}`, [
    { k: 'reason', label: 'Why', hint: 'optional' },
  ], async (v) => {
    await api('/row', 'DELETE', { table, id, reason: v.reason });
    if (await boot()) { toast(`${label} is in the recycle bin`); render(); }
  }, { note: 'It goes to the recycle bin on the Administration page. Nothing is lost until the bin is emptied.',
       ok: 'Move to the bin' });
}


function editDept(id) {
  const d = DB.departments.find(x => x.id === id);
  form(esc(d.name), [
    { k: 'name', label: 'Department', value: d.name, required: true },
    { k: 'responsibilities', label: 'What it is responsible for', type: 'textarea',
      value: d.responsibilities },
    { k: 'focal_user_id', label: 'Focal person', type: 'select',
      options: peopleOptions(), value: d.focalUserId },
    { k: 'active', label: 'Active', type: 'checkbox', value: d.active },
  ], async (v) => {
    await api('/row', 'PATCH', { table: 'departments', id, changes: v });
    if (await boot()) { toast('Saved'); render(); }
  });
}
