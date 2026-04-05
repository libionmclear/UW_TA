/* ── State ────────────────────────────────────────────────────────────────── */
const S = {
  health: null,
  courses: [],
  course: null,          // { id, name }
  assignments: [],
  assignment: null,      // { id, name, points_possible, due_at }
  students: [],          // canvas enrollments
  submissions: [],       // canvas submissions
  rubric: null,          // active rubric object
  rubrics: [],           // all saved rubrics
  grades: {},            // studentId → grade object
  manualStudents: [],
  aiInstructions: '',    // per-assignment AI grading instructions
  quizBank: { questions: [] },
};

/* ── API helpers ──────────────────────────────────────────────────────────── */
async function api(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(path, opts);
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}
const GET  = p       => api('GET',    p);
const POST = (p, b)  => api('POST',   p, b);
const PUT  = (p, b)  => api('PUT',    p, b);
const DEL  = p       => api('DELETE', p);

/* ── Toast ────────────────────────────────────────────────────────────────── */
let toastTimer;
function toast(msg, type = '') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `toast ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 3000);
}

/* ── Tab navigation ───────────────────────────────────────────────────────── */
document.querySelectorAll('.nav-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab;
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(s => s.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`tab-${tab}`)?.classList.add('active');
    if (tab === 'grades') renderGradesTable();
    if (tab === 'students') renderStudentsTable();
    if (tab === 'rubric') { renderSavedRubrics(); renderAiInstructionsPanel(); }
    if (tab === 'overview') renderOverview();
    if (tab === 'quiz') renderQuizBank();
  });
});

/* ── Startup ──────────────────────────────────────────────────────────────── */
async function init() {
  try {
    S.health = await GET('/api/health');
    renderStatusBadges();
  } catch { /* offline */ }

  await loadRubrics();
  await loadQuizBank();
  renderSavedRubrics();
  renderRubricBuilder();
  renderQuizBank();

  if (S.health?.canvas) {
    await loadCourses();
  } else {
    document.getElementById('sel-course').innerHTML = '<option value="">Canvas not configured</option>';
  }
}

function renderStatusBadges() {
  const el = document.getElementById('status-badges');
  const canvas = S.health?.canvas
    ? '<span class="badge badge--green">Canvas ✓</span>'
    : '<span class="badge badge--red">Canvas ✗</span>';
  const claude = S.health?.claude
    ? '<span class="badge badge--green">Claude ✓</span>'
    : '<span class="badge badge--red">Claude ✗</span>';
  el.innerHTML = canvas + claude;
}

/* ── Courses ──────────────────────────────────────────────────────────────── */
async function loadCourses() {
  try {
    S.courses = await GET('/api/courses');
    const sel = document.getElementById('sel-course');
    sel.innerHTML = '<option value="">— Select Course —</option>' +
      S.courses.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
  } catch (e) {
    toast('Failed to load courses: ' + e.message, 'error');
  }
}

document.getElementById('sel-course').addEventListener('change', async function () {
  const id = this.value;
  if (!id) { S.course = null; S.assignment = null; resetAssignment(); return; }
  S.course = S.courses.find(c => String(c.id) === id) || { id, name: this.options[this.selectedIndex].text };
  await loadAssignments(id);
});

async function loadAssignments(courseId) {
  try {
    S.assignments = await GET(`/api/courses/${courseId}/assignments`);
    const sel = document.getElementById('sel-assignment');
    sel.disabled = false;
    sel.innerHTML = '<option value="">— Select Assignment —</option>' +
      S.assignments.map(a => {
        const pts = a.points_possible ? ` (${a.points_possible} pts)` : '';
        return `<option value="${a.id}">${esc(a.name)}${pts}</option>`;
      }).join('');
  } catch (e) {
    toast('Failed to load assignments: ' + e.message, 'error');
  }
}

document.getElementById('sel-assignment').addEventListener('change', async function () {
  const id = this.value;
  if (!id) { S.assignment = null; resetAssignment(); return; }
  S.assignment = S.assignments.find(a => String(a.id) === id) ||
    { id, name: this.options[this.selectedIndex].text };
  await loadSubmissions();
  await loadGrades();
  await loadAssignmentSettings();
  updateButtons();
  renderOverview();
  renderAiInstructionsPanel();
});

function resetAssignment() {
  S.students = []; S.submissions = []; S.grades = {}; S.aiInstructions = '';
  updateButtons(); renderOverview(); renderAiInstructionsPanel();
}

/* ── Students & Submissions ───────────────────────────────────────────────── */
async function loadSubmissions() {
  if (!S.course || !S.assignment) return;
  try {
    const [enrollments, subs] = await Promise.all([
      GET(`/api/courses/${S.course.id}/students`),
      GET(`/api/courses/${S.course.id}/assignments/${S.assignment.id}/submissions`),
    ]);
    S.students = enrollments;
    S.submissions = subs;
    toast('Students and submissions loaded.', 'success');
  } catch (e) {
    toast('Canvas load error: ' + e.message, 'error');
  }
}

async function loadGrades() {
  if (!S.course || !S.assignment) return;
  try {
    S.grades = await GET(`/api/grades/${S.course.id}/${S.assignment.id}`);
  } catch { S.grades = {}; }
}

document.getElementById('btn-refresh-students').addEventListener('click', async () => {
  if (!S.course || !S.assignment) { toast('Select a course and assignment first.', 'warn'); return; }
  await loadSubmissions();
  renderStudentsTable();
});

/* ── Assignment Settings (AI Instructions) ────────────────────────────────── */
async function loadAssignmentSettings() {
  if (!S.course || !S.assignment) { S.aiInstructions = ''; return; }
  try {
    const settings = await GET(`/api/assignment-settings/${S.course.id}/${S.assignment.id}`);
    S.aiInstructions = settings.aiInstructions || '';
  } catch { S.aiInstructions = ''; }
}

function renderAiInstructionsPanel() {
  const ta = document.getElementById('ai-instructions-text');
  const status = document.getElementById('ai-instructions-status');
  if (ta) ta.value = S.aiInstructions || '';
  if (status) status.textContent = S.assignment ? `Assignment: ${S.assignment.name}` : 'No assignment selected';
}

document.getElementById('btn-save-ai-instructions').addEventListener('click', async () => {
  if (!S.course || !S.assignment) { toast('Select an assignment first.', 'warn'); return; }
  const text = document.getElementById('ai-instructions-text').value.trim();
  S.aiInstructions = text;
  try {
    await PUT(`/api/assignment-settings/${S.course.id}/${S.assignment.id}`, { aiInstructions: text });
    document.getElementById('ai-instructions-status').textContent = 'Saved!';
    toast('AI instructions saved.', 'success');
    setTimeout(() => {
      const el = document.getElementById('ai-instructions-status');
      if (el) el.textContent = `Assignment: ${S.assignment.name}`;
    }, 2000);
  } catch (e) {
    toast('Save failed: ' + e.message, 'error');
  }
});

/* ── Merge students + manual ──────────────────────────────────────────────── */
function allStudents() {
  const canvas = S.students.map(e => ({
    id: String(e.user_id || e.user?.id || e.id),
    name: e.user?.name || e.user?.sortable_name || `Student ${e.user_id}`,
    source: 'canvas',
  }));
  const manual = S.manualStudents.map(s => ({ ...s, source: 'manual' }));
  const seen = new Set();
  return [...canvas, ...manual].filter(s => {
    if (seen.has(s.id)) return false;
    seen.add(s.id); return true;
  });
}

function submissionFor(studentId) {
  return S.submissions.find(s => String(s.user_id) === String(studentId)) || null;
}

function submissionText(sub) {
  if (!sub) return '';
  if (sub._manualText) return sub._manualText;
  if (sub.body) return sub.body;
  return '';
}

/* ── Students Table ───────────────────────────────────────────────────────── */
function renderStudentsTable() {
  const wrap = document.getElementById('students-table-wrap');
  const students = allStudents();
  if (!students.length) {
    wrap.innerHTML = '<p class="muted padded">No students loaded. Select an assignment or add manually.</p>';
    return;
  }

  const rows = students.map(st => {
    const sub = submissionFor(st.id);
    const g = S.grades[st.id];
    const submitted = sub && sub.workflow_state !== 'unsubmitted' ? '✓' : '—';
    const isLate = sub?.late ? '<span class="status-badge status--late">LATE</span>' : '';
    const gradeStatus = g
      ? `<span class="status-badge status--graded">${g.status === 'reviewed' ? 'Reviewed' : 'AI Graded'}</span>`
      : '<span class="status-badge status--pending">Pending</span>';
    const flagged = g?.flagged ? '<span class="ai-badge ai-badge--flagged">⚑ AI Flag</span>' : '';
    const finalPts = g?.finalScore != null ? `<strong>${g.finalScore}</strong>` : '—';

    return `<tr>
      <td class="col-sticky"><button class="link-btn" onclick="openStudent('${esc(st.id)}')">${esc(st.name)}</button></td>
      <td style="text-align:center">${submitted}</td>
      <td>${isLate}</td>
      <td>${gradeStatus} ${flagged}</td>
      <td style="text-align:center">${finalPts} ${S.rubric ? '/ ' + S.rubric.totalPoints : ''}</td>
      <td>
        <button class="btn btn-surf-sec" style="font-size:11px;padding:4px 8px"
          onclick="openStudent('${esc(st.id)}')">View/Grade</button>
      </td>
    </tr>`;
  }).join('');

  wrap.innerHTML = `<table>
    <thead><tr>
      <th>Student</th><th>Submitted</th><th>Status</th><th>Grade Status</th><th>Score</th><th></th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

/* ── Grading Matrix ───────────────────────────────────────────────────────── */
function renderGradesTable() {
  const wrap = document.getElementById('grades-table-wrap');
  const students = allStudents();
  if (!students.length) {
    wrap.innerHTML = '<p class="muted padded">No students. Select an assignment or add manually.</p>';
    return;
  }
  if (!S.rubric) {
    wrap.innerHTML = '<p class="muted padded">No rubric active. Build one in the Rubric tab first.</p>';
    return;
  }

  const criteria = S.rubric.criteria;

  const headerCols = criteria.map(c =>
    `<th colspan="3" title="${esc(c.description)}" style="text-align:center">${esc(c.name)}<br><small style="opacity:.7">/ ${c.maxPoints}</small></th>`
  ).join('');

  const subHeaderCols = criteria.map(() =>
    `<th class="sub-th sub-th-ai">AI</th><th class="sub-th sub-th-h1">TA</th><th class="sub-th sub-th-h2">Instr.</th>`
  ).join('');

  const rows = students.map(st => {
    const g = S.grades[st.id];
    const sub = submissionFor(st.id);
    const submitted = sub && sub.workflow_state !== 'unsubmitted';
    const isLate = sub?.late;
    const flagged = g?.flagged;

    let rowClass = '';
    if (flagged) rowClass = 'row--flagged';
    else if (g?.status === 'reviewed') rowClass = 'row--reviewed';

    const aiConf = g?.aiDetection
      ? `<span class="ai-badge ai-badge--${g.aiDetection.level?.toLowerCase() || 'none'}">${g.aiDetection.score * 10}%</span>`
      : '—';

    const statusBadge = !submitted
      ? '<span class="status-badge status--pending">Not Submitted</span>'
      : isLate
        ? '<span class="status-badge status--late">Late</span>'
        : g
          ? `<span class="status-badge status--${g.status === 'reviewed' ? 'reviewed' : 'graded'}">${g.status === 'reviewed' ? 'Reviewed' : 'Graded'}</span>`
          : '<span class="status-badge status--submitted">Submitted</span>';

    const flagBadge = flagged ? '<span class="ai-badge ai-badge--flagged">⚑ AI</span>' : '';

    const scoreCols = criteria.map(c => {
      const cd = g?.criteria?.[c.id];
      const aiS = cd?.aiScore != null ? cd.aiScore : '—';
      const h1Val = cd?.humanScore != null ? cd.humanScore : '';
      const h2Val = cd?.humanScore2 != null ? cd.humanScore2 : '';
      return `<td class="score-td score-td-ai"><span class="score-ai">${aiS}</span></td>
        <td class="score-td score-td-h1">
          <input class="score-human-input ${h1Val !== '' ? 'changed' : ''}"
            type="number" min="0" max="${c.maxPoints}" placeholder="—"
            value="${h1Val}"
            data-student="${esc(st.id)}" data-criterion="${esc(c.id)}" data-max="${c.maxPoints}" data-grade="1"
            onchange="onHumanScoreChange(this)" />
        </td>
        <td class="score-td score-td-h2">
          <input class="score-human-input score-h2-input ${h2Val !== '' ? 'changed' : ''}"
            type="number" min="0" max="${c.maxPoints}" placeholder="—"
            value="${h2Val}"
            data-student="${esc(st.id)}" data-criterion="${esc(c.id)}" data-max="${c.maxPoints}" data-grade="2"
            onchange="onHumanScoreChange(this)" />
        </td>`;
    }).join('');

    const aiTotal   = g?.aiTotalScore != null ? g.aiTotalScore : '—';
    const h1Total   = g?.humanTotalScore != null ? g.humanTotalScore : '—';
    const h2Total   = g?.humanTotalScore2 != null ? g.humanTotalScore2 : '—';
    const finalScore = g?.finalScore != null ? `<strong>${g.finalScore}</strong>` : '—';

    return `<tr class="${rowClass}" id="row-${esc(st.id)}">
      <td class="col-sticky">
        <button class="link-btn" onclick="openStudent('${esc(st.id)}')">${esc(st.name)}</button>
      </td>
      <td>${statusBadge} ${flagBadge}</td>
      <td>${aiConf}</td>
      ${scoreCols}
      <td class="score-td score-td-ai" style="text-align:center">${aiTotal}</td>
      <td class="score-td score-td-h1" style="text-align:center">${h1Total}</td>
      <td class="score-td score-td-h2" style="text-align:center">${h2Total}</td>
      <td style="text-align:center">${finalScore}</td>
    </tr>`;
  }).join('');

  wrap.innerHTML = `<table>
    <thead>
      <tr>
        <th rowspan="2">Student</th>
        <th rowspan="2">Status</th>
        <th rowspan="2">AI Conf.</th>
        ${headerCols}
        <th rowspan="2" class="sub-th-ai">AI Total</th>
        <th rowspan="2" class="sub-th-h1">TA Total</th>
        <th rowspan="2" class="sub-th-h2">Instr. Total</th>
        <th rowspan="2">Final</th>
      </tr>
      <tr>${subHeaderCols}</tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>`;
}

async function onHumanScoreChange(input) {
  const studentId = input.dataset.student;
  const criterionId = input.dataset.criterion;
  const max = Number(input.dataset.max);
  const gradeNum = input.dataset.grade; // '1' or '2'
  let val = input.value.trim() === '' ? null : Number(input.value);
  if (val !== null) val = Math.max(0, Math.min(max, val));

  if (!S.grades[studentId]) S.grades[studentId] = buildEmptyGrade(studentId);
  if (!S.grades[studentId].criteria) S.grades[studentId].criteria = {};
  if (!S.grades[studentId].criteria[criterionId]) S.grades[studentId].criteria[criterionId] = {};

  if (gradeNum === '2') {
    S.grades[studentId].criteria[criterionId].humanScore2 = val;
  } else {
    S.grades[studentId].criteria[criterionId].humanScore = val;
  }

  recalcTotals(studentId);
  S.grades[studentId].status = 'reviewed';
  input.classList.toggle('changed', val !== null);

  await saveGrade(studentId);
}

function buildEmptyGrade(studentId) {
  const st = allStudents().find(s => s.id === studentId);
  const sub = submissionFor(studentId);
  return {
    studentId,
    studentName: st?.name || studentId,
    submitted: !!(sub && sub.workflow_state !== 'unsubmitted'),
    isLate: sub?.late || false,
    rubric: S.rubric,
    criteria: {},
    status: 'pending',
  };
}

function recalcTotals(studentId) {
  const g = S.grades[studentId];
  if (!g || !S.rubric) return;
  let aiTotal = 0, h1Total = 0, h2Total = 0, hasH1 = false, hasH2 = false;
  S.rubric.criteria.forEach(c => {
    const cd = g.criteria?.[c.id] || {};
    if (cd.aiScore != null) aiTotal += cd.aiScore;
    if (cd.humanScore != null) { h1Total += cd.humanScore; hasH1 = true; }
    else if (cd.aiScore != null) h1Total += cd.aiScore;
    if (cd.humanScore2 != null) { h2Total += cd.humanScore2; hasH2 = true; }
    else if (cd.humanScore != null) h2Total += cd.humanScore;
    else if (cd.aiScore != null) h2Total += cd.aiScore;
  });
  g.aiTotalScore = aiTotal;
  g.humanTotalScore = hasH1 ? h1Total : null;
  g.humanTotalScore2 = hasH2 ? h2Total : null;
  // Final = Instructor grade → TA grade → AI grade (in priority order)
  g.finalScore = g.humanTotalScore2 != null ? g.humanTotalScore2
               : g.humanTotalScore != null ? g.humanTotalScore
               : g.aiTotalScore;
}

async function saveGrade(studentId) {
  if (!S.course || !S.assignment) return;
  try {
    await PUT(`/api/grades/${S.course.id}/${S.assignment.id}/${studentId}`, S.grades[studentId]);
  } catch (e) {
    toast('Save failed: ' + e.message, 'error');
  }
}

/* ── Grade All with AI ────────────────────────────────────────────────────── */
document.getElementById('btn-grade-all').addEventListener('click', gradeAll);

async function gradeAll() {
  if (!S.rubric) { toast('Build a rubric first!', 'warn'); return; }
  const students = allStudents();
  if (!students.length) { toast('No students loaded.', 'warn'); return; }
  if (!S.health?.claude) { toast('Claude API key not configured.', 'error'); return; }

  const submissions = students.map(st => {
    const sub = submissionFor(st.id);
    const text = submissionText(sub);
    const manualCite = sub?._hasAiCitation || false;
    return {
      studentId: st.id,
      studentName: st.name,
      text: text || '',
      hasAiCitation: manualCite,
    };
  });

  const btn = document.getElementById('btn-grade-all');
  btn.disabled = true;
  btn.textContent = '⏳ Grading…';

  const progressWrap = document.getElementById('grades-progress');
  const progressLabel = document.getElementById('progress-label');
  const progressFill  = document.getElementById('progress-fill');
  progressWrap.style.display = 'block';

  try {
    const resp = await fetch('/api/grade/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ submissions, rubric: S.rubric, aiInstructions: S.aiInstructions }),
    });

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      chunk.split('\n').forEach(line => {
        if (!line.startsWith('data: ')) return;
        const msg = JSON.parse(line.slice(6));
        if (msg.type === 'progress' || msg.type === 'error') {
          const pct = Math.round((msg.completed / msg.total) * 100);
          progressFill.style.width = pct + '%';
          progressLabel.textContent = `Grading ${msg.completed} / ${msg.total}…`;
          if (msg.type === 'progress') {
            applyAiGrade(msg.studentId, msg.grade, msg.aiDetection, msg.flagged);
          }
        }
        if (msg.type === 'complete') {
          progressLabel.textContent = `Done! ${msg.total} students graded.`;
          toast(`Graded ${msg.total} submissions.`, 'success');
        }
      });
    }

    renderGradesTable();
    renderStudentsTable();
    renderOverview();

    if (S.course && S.assignment) {
      await Promise.all(
        allStudents().map(st => S.grades[st.id] ? saveGrade(st.id) : Promise.resolve())
      );
    }
  } catch (e) {
    toast('Grading error: ' + e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '▶ Grade All with AI';
    setTimeout(() => { progressWrap.style.display = 'none'; }, 4000);
  }
}

function applyAiGrade(studentId, grade, aiDetection, flagged) {
  const st = allStudents().find(s => s.id === studentId);
  if (!st || !S.rubric) return;

  if (!S.grades[studentId]) S.grades[studentId] = buildEmptyGrade(studentId);
  const g = S.grades[studentId];

  g.aiDetection = aiDetection;
  g.flagged = flagged;
  g.aiOverallFeedback = grade.overallFeedback;
  g.aiConfidence = grade.aiConfidence;
  g.aiSignals = grade.aiSignals;
  g.rubric = S.rubric;

  S.rubric.criteria.forEach(c => {
    if (!g.criteria[c.id]) g.criteria[c.id] = {};
    const ai = grade.criteria?.[c.id];
    g.criteria[c.id].aiScore = ai?.score != null ? ai.score : (c.autoGrant ? c.maxPoints : 0);
    g.criteria[c.id].aiJustification = ai?.justification || '';
  });

  recalcTotals(studentId);
  g.status = 'ai_graded';
}

/* ── Student Detail Modal ─────────────────────────────────────────────────── */
let modalStudentId = null;

function openStudent(studentId) {
  modalStudentId = studentId;
  const st = allStudents().find(s => s.id === studentId);
  const sub = submissionFor(studentId);
  const g = S.grades[studentId];

  document.getElementById('modal-student-name').textContent = st?.name || studentId;

  let meta = [];
  if (sub?.late) meta.push('LATE');
  if (g?.flagged) meta.push('⚑ AI Flagged');
  if (g?.status) meta.push(g.status.replace('_', ' ').toUpperCase());
  document.getElementById('modal-student-meta').textContent = meta.join(' · ');

  const text = submissionText(sub);
  document.getElementById('modal-submission-text').textContent =
    text || '(No submission text available)';

  const flagBanner = document.getElementById('modal-ai-flag');
  if (g?.flagged && g.aiDetection) {
    flagBanner.style.display = 'block';
    const signals = (g.aiSignals || g.aiDetection?.details?.aiPhrases?.matched || []).slice(0, 3);
    flagBanner.innerHTML = `<strong>⚑ Potential AI Use — ${g.aiConfidence || g.aiDetection.score * 10}% confidence</strong>
      ${signals.length ? '<br>Signals: ' + signals.map(s => `<em>"${esc(s)}"</em>`).join(', ') : ''}`;
  } else {
    flagBanner.style.display = 'none';
  }

  renderModalCriteria(studentId);

  document.getElementById('modal-ai-total').textContent =
    g?.aiTotalScore != null ? g.aiTotalScore : '—';
  document.getElementById('modal-human-total').textContent =
    g?.humanTotalScore != null ? g.humanTotalScore : '—';
  document.getElementById('modal-human-total2').textContent =
    g?.humanTotalScore2 != null ? g.humanTotalScore2 : '—';
  document.getElementById('modal-final').textContent =
    g?.finalScore != null ? g.finalScore : '—';

  document.getElementById('modal-notes').value = g?.notes || '';

  const fbBox = document.getElementById('modal-ai-feedback');
  const fbText = document.getElementById('modal-ai-feedback-text');
  if (g?.aiOverallFeedback) {
    fbBox.style.display = 'block';
    fbText.textContent = g.aiOverallFeedback;
  } else {
    fbBox.style.display = 'none';
  }

  document.getElementById('modal-backdrop').classList.remove('hidden');
}

function renderModalCriteria(studentId) {
  const wrap = document.getElementById('modal-criteria-scores');
  const g = S.grades[studentId];

  if (!S.rubric) {
    wrap.innerHTML = '<p class="muted">No rubric set.</p>';
    return;
  }

  wrap.innerHTML = S.rubric.criteria.map(c => {
    const cd = g?.criteria?.[c.id] || {};
    const aiS = cd.aiScore != null ? cd.aiScore : '—';
    const h1Val = cd.humanScore != null ? cd.humanScore : '';
    const h2Val = cd.humanScore2 != null ? cd.humanScore2 : '';
    const justif = cd.aiJustification ? `<div class="crit-score-sub">${esc(cd.aiJustification)}</div>` : '';

    return `<div class="criterion-score-row">
      <div style="flex:1">
        <div class="crit-score-name">${esc(c.name)}</div>
        <div class="crit-score-sub">/ ${c.maxPoints} pts</div>
        ${justif}
      </div>
      <div class="crit-score-col">
        <div class="crit-score-lbl score-lbl-ai">AI</div>
        <div class="crit-score-val">${aiS}</div>
      </div>
      <div class="crit-score-col">
        <div class="crit-score-lbl score-lbl-h1">TA</div>
        <input class="crit-score-input" type="number" min="0" max="${c.maxPoints}"
          placeholder="${aiS}" value="${h1Val}"
          data-criterion="${esc(c.id)}" data-max="${c.maxPoints}" data-grade="1"
          onchange="onModalScoreChange(this)" />
      </div>
      <div class="crit-score-col">
        <div class="crit-score-lbl score-lbl-h2">Instr.</div>
        <input class="crit-score-input crit-score-instr" type="number" min="0" max="${c.maxPoints}"
          placeholder="${h1Val || aiS}" value="${h2Val}"
          data-criterion="${esc(c.id)}" data-max="${c.maxPoints}" data-grade="2"
          onchange="onModalScoreChange(this)" />
      </div>
    </div>`;
  }).join('');
}

function onModalScoreChange(input) {
  if (!modalStudentId) return;
  const criterionId = input.dataset.criterion;
  const max = Number(input.dataset.max);
  const gradeNum = input.dataset.grade;
  let val = input.value.trim() === '' ? null : Number(input.value);
  if (val !== null) val = Math.max(0, Math.min(max, val));

  if (!S.grades[modalStudentId]) S.grades[modalStudentId] = buildEmptyGrade(modalStudentId);
  if (!S.grades[modalStudentId].criteria) S.grades[modalStudentId].criteria = {};
  if (!S.grades[modalStudentId].criteria[criterionId]) S.grades[modalStudentId].criteria[criterionId] = {};

  if (gradeNum === '2') {
    S.grades[modalStudentId].criteria[criterionId].humanScore2 = val;
  } else {
    S.grades[modalStudentId].criteria[criterionId].humanScore = val;
  }

  recalcTotals(modalStudentId);
  const g = S.grades[modalStudentId];
  document.getElementById('modal-human-total').textContent = g.humanTotalScore != null ? g.humanTotalScore : '—';
  document.getElementById('modal-human-total2').textContent = g.humanTotalScore2 != null ? g.humanTotalScore2 : '—';
  document.getElementById('modal-final').textContent = g.finalScore != null ? g.finalScore : '—';
}

document.getElementById('modal-save').addEventListener('click', async () => {
  if (!modalStudentId) return;
  if (!S.grades[modalStudentId]) S.grades[modalStudentId] = buildEmptyGrade(modalStudentId);
  S.grades[modalStudentId].notes = document.getElementById('modal-notes').value;
  S.grades[modalStudentId].status = 'reviewed';
  await saveGrade(modalStudentId);
  toast('Saved!', 'success');
  closeModal();
  renderGradesTable();
  renderStudentsTable();
  renderOverview();
});

document.getElementById('modal-grade-ai').addEventListener('click', async () => {
  if (!modalStudentId || !S.rubric) return;
  if (!S.health?.claude) { toast('Claude not configured.', 'error'); return; }
  const st = allStudents().find(s => s.id === modalStudentId);
  const sub = submissionFor(modalStudentId);
  const text = submissionText(sub);

  document.getElementById('modal-grade-ai').textContent = '⏳ Grading…';
  document.getElementById('modal-grade-ai').disabled = true;

  try {
    const res = await POST('/api/grade/single', {
      text: text || '',
      rubric: S.rubric,
      studentName: st?.name || modalStudentId,
      hasAiCitation: sub?._hasAiCitation || false,
      aiInstructions: S.aiInstructions,
    });
    applyAiGrade(modalStudentId, res.grade, res.aiDetection, res.flagged);
    renderModalCriteria(modalStudentId);
    const g = S.grades[modalStudentId];
    document.getElementById('modal-ai-total').textContent = g?.aiTotalScore ?? '—';
    document.getElementById('modal-final').textContent = g?.finalScore ?? '—';
    if (g?.aiOverallFeedback) {
      document.getElementById('modal-ai-feedback').style.display = 'block';
      document.getElementById('modal-ai-feedback-text').textContent = g.aiOverallFeedback;
    }
    toast('Re-graded!', 'success');
  } catch (e) {
    toast('Grading error: ' + e.message, 'error');
  } finally {
    document.getElementById('modal-grade-ai').textContent = '⟳ Re-grade with AI';
    document.getElementById('modal-grade-ai').disabled = false;
  }
});

document.getElementById('modal-close').addEventListener('click', closeModal);
document.getElementById('modal-backdrop').addEventListener('click', e => {
  if (e.target === document.getElementById('modal-backdrop')) closeModal();
});

function closeModal() {
  document.getElementById('modal-backdrop').classList.add('hidden');
  modalStudentId = null;
}

/* ── Rubric Builder ───────────────────────────────────────────────────────── */
function defaultRubric() {
  return {
    name: '',
    totalPoints: 15,
    description: '',
    criteria: [
      { id: 'c1', name: 'Submission', maxPoints: 5, description: 'Student submitted any work.', autoGrant: true },
      { id: 'c2', name: 'Executive Summary & Recommendations', maxPoints: 3, description: 'Student provides a clear executive summary with specific, actionable recommendations upfront.', autoGrant: false },
      { id: 'c3', name: 'Supporting Points & Evidence', maxPoints: 3, description: 'Claims and recommendations are backed with specific evidence, data, or analysis.', autoGrant: false },
      { id: 'c4', name: 'Conclusion / Alternatives', maxPoints: 3, description: 'Student includes a thoughtful conclusion, discusses alternatives, or provides additional insights.', autoGrant: false },
      { id: 'c5', name: 'Writing Quality & Clarity', maxPoints: 1, description: 'Submission is well-organized, clearly written, and professional.', autoGrant: false },
    ],
  };
}

if (!S.rubric) S.rubric = defaultRubric();

function renderRubricBuilder() {
  const rubric = S.rubric;
  document.getElementById('rubric-name').value = rubric.name || '';
  document.getElementById('rubric-total').value = rubric.totalPoints || 15;
  document.getElementById('rubric-description').value = rubric.description || '';

  const list = document.getElementById('rubric-criteria-list');
  list.innerHTML = rubric.criteria.map((c, i) => renderCriterionRow(c, i)).join('');
}

function renderCriterionRow(c, i) {
  return `<div class="criterion-row ${c.autoGrant ? 'auto-grant' : ''}" id="cr-${esc(c.id)}">
    <div class="criterion-inner">
      <div class="criterion-name-row">
        <input class="input" type="text" placeholder="Criterion name" value="${esc(c.name)}"
          oninput="updateCriterion('${esc(c.id)}','name',this.value)" />
      </div>
      <textarea class="input" rows="2" placeholder="Description — what earns full points?"
        oninput="updateCriterion('${esc(c.id)}','description',this.value)">${esc(c.description)}</textarea>
    </div>
    <div>
      <label style="font-size:11px;color:var(--text-muted)">Max Pts</label>
      <input class="input criterion-pts" type="number" min="0" value="${c.maxPoints}"
        oninput="updateCriterion('${esc(c.id)}','maxPoints',Number(this.value))" />
    </div>
    <div class="criterion-autogrant">
      <label>Auto<br>Grant</label>
      <input type="checkbox" ${c.autoGrant ? 'checked' : ''}
        onchange="updateCriterion('${esc(c.id)}','autoGrant',this.checked)" />
    </div>
    <button class="criterion-delete" onclick="deleteCriterion('${esc(c.id)}')" title="Remove">✕</button>
  </div>`;
}

function updateCriterion(id, field, value) {
  const c = S.rubric.criteria.find(x => x.id === id);
  if (c) { c[field] = value; }
  if (field === 'autoGrant') {
    const row = document.getElementById(`cr-${id}`);
    row?.classList.toggle('auto-grant', value);
  }
}

function deleteCriterion(id) {
  S.rubric.criteria = S.rubric.criteria.filter(c => c.id !== id);
  renderRubricBuilder();
}

document.getElementById('btn-add-criterion').addEventListener('click', () => {
  const id = 'c' + Date.now();
  S.rubric.criteria.push({ id, name: '', maxPoints: 3, description: '', autoGrant: false });
  renderRubricBuilder();
});

document.getElementById('rubric-name').addEventListener('input', function () { S.rubric.name = this.value; });
document.getElementById('rubric-total').addEventListener('input', function () { S.rubric.totalPoints = Number(this.value); });
document.getElementById('rubric-description').addEventListener('input', function () { S.rubric.description = this.value; });

document.getElementById('btn-save-rubric').addEventListener('click', async () => {
  S.rubric.name = document.getElementById('rubric-name').value;
  S.rubric.totalPoints = Number(document.getElementById('rubric-total').value);
  if (!S.rubric.name) { toast('Give the rubric a name.', 'warn'); return; }
  try {
    const saved = S.rubric.id
      ? await PUT(`/api/rubrics/${S.rubric.id}`, S.rubric)
      : await POST('/api/rubrics', S.rubric);
    S.rubric = saved;
    await loadRubrics();
    renderSavedRubrics();
    toast('Rubric saved!', 'success');
    updateButtons();
  } catch (e) {
    toast('Save failed: ' + e.message, 'error');
  }
});

document.getElementById('btn-generate-rubric').addEventListener('click', async () => {
  const description = document.getElementById('rubric-description').value;
  const totalPoints = Number(document.getElementById('rubric-total').value);
  if (!description) { toast('Enter an assignment description first.', 'warn'); return; }
  if (!S.health?.claude) { toast('Claude not configured.', 'error'); return; }

  const btn = document.getElementById('btn-generate-rubric');
  btn.disabled = true; btn.textContent = '⏳ Generating…';
  try {
    const generated = await POST('/api/rubrics/generate', { description, totalPoints });
    S.rubric = { ...generated, id: S.rubric?.id };
    renderRubricBuilder();

    if (generated.clarifyingQuestions?.length) {
      const section = document.getElementById('rubric-clarifying');
      const list = document.getElementById('clarifying-list');
      list.innerHTML = generated.clarifyingQuestions.map(q => `<li>${esc(q)}</li>`).join('');
      section.style.display = 'block';
    }
    toast('Rubric generated! Review and save.', 'success');
  } catch (e) {
    toast('Generation failed: ' + e.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = '✦ Generate with AI';
  }
});

async function loadRubrics() {
  try { S.rubrics = await GET('/api/rubrics'); } catch { S.rubrics = []; }
}

function renderSavedRubrics() {
  const wrap = document.getElementById('saved-rubrics-list');
  if (!S.rubrics.length) {
    wrap.innerHTML = '<p class="muted">No saved rubrics yet.</p>';
    return;
  }
  wrap.innerHTML = S.rubrics.map(r =>
    `<div class="saved-rubric-item" onclick="loadRubric('${esc(r.id)}')">
      <div>
        <div class="rub-name">${esc(r.name)}</div>
        <div class="rub-pts">${(r.criteria || []).length} criteria · ${r.totalPoints} pts</div>
      </div>
      <button class="btn btn-surf-sec" style="font-size:11px;padding:4px 8px"
        onclick="event.stopPropagation();deleteRubric('${esc(r.id)}')">Delete</button>
    </div>`
  ).join('');
}

function loadRubric(id) {
  const r = S.rubrics.find(x => x.id === id);
  if (!r) return;
  S.rubric = JSON.parse(JSON.stringify(r));
  renderRubricBuilder();
  toast(`Loaded: ${r.name}`, 'success');
  updateButtons();
}

async function deleteRubric(id) {
  if (!confirm('Delete this rubric?')) return;
  await DEL(`/api/rubrics/${id}`);
  await loadRubrics();
  renderSavedRubrics();
  toast('Rubric deleted.');
}

/* ── Quiz Bank ────────────────────────────────────────────────────────────── */
async function loadQuizBank() {
  try { S.quizBank = await GET('/api/quiz-bank'); } catch { S.quizBank = { questions: [] }; }
}

function renderQuizBank() {
  const list = document.getElementById('quiz-bank-list');
  const countEl = document.getElementById('quiz-bank-count');
  const qs = S.quizBank?.questions || [];
  if (countEl) countEl.textContent = `${qs.length} question${qs.length !== 1 ? 's' : ''}`;
  if (!list) return;
  if (!qs.length) {
    list.innerHTML = '<p class="muted">No questions in the bank. Upload a test bank file to get started.</p>';
    return;
  }
  list.innerHTML = `<div class="quiz-list">` +
    qs.map((q, i) => {
      const text = typeof q === 'string' ? q : q.question || JSON.stringify(q);
      return `<div class="quiz-q-item">
        <span class="quiz-q-num">${i + 1}.</span>
        <span class="quiz-q-text">${esc(text)}</span>
        <button class="btn btn-surf-sec" style="font-size:11px;padding:3px 8px;margin-left:auto;flex-shrink:0"
          onclick="deleteQuestion(${i})">Remove</button>
      </div>`;
    }).join('') + `</div>`;
}

async function deleteQuestion(index) {
  S.quizBank.questions.splice(index, 1);
  await PUT('/api/quiz-bank', S.quizBank);
  renderQuizBank();
}

// Upload test bank file
document.getElementById('btn-quiz-upload').addEventListener('click', () => {
  document.getElementById('quiz-file-input').click();
});

document.getElementById('quiz-file-input').addEventListener('change', async function () {
  const file = this.files[0];
  if (!file) return;
  const formData = new FormData();
  formData.append('file', file);

  try {
    const resp = await fetch('/api/quiz-bank/upload', { method: 'POST', body: formData });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error);

    // Parse questions: one per line, skip blanks
    const lines = data.text.split('\n')
      .map(l => l.trim())
      .filter(l => l.length > 5); // skip very short lines

    S.quizBank.questions = [...(S.quizBank.questions || []), ...lines];
    await PUT('/api/quiz-bank', S.quizBank);
    renderQuizBank();
    toast(`Imported ${lines.length} questions from ${data.filename}.`, 'success');
  } catch (e) {
    toast('Upload failed: ' + e.message, 'error');
  }
  this.value = '';
});

document.getElementById('btn-quiz-clear').addEventListener('click', async () => {
  if (!confirm('Clear the entire question bank?')) return;
  await DEL('/api/quiz-bank');
  S.quizBank = { questions: [] };
  renderQuizBank();
  toast('Question bank cleared.');
});

document.getElementById('btn-quiz-suggest').addEventListener('click', async () => {
  if (!S.health?.claude) { toast('Claude not configured.', 'error'); return; }
  const topic = document.getElementById('quiz-topic').value.trim();
  const count = Number(document.getElementById('quiz-count').value) || 5;
  const courseContent = document.getElementById('quiz-context').value.trim();

  const btn = document.getElementById('btn-quiz-suggest');
  btn.disabled = true; btn.textContent = '⏳ Thinking…';

  try {
    const result = await POST('/api/quiz-bank/suggest', {
      topic,
      courseContent,
      count,
    });

    const wrap = document.getElementById('quiz-suggestions-wrap');
    const inner = document.getElementById('quiz-suggestions');
    wrap.style.display = 'block';

    if (result.notes) {
      inner.innerHTML = `<p class="muted" style="margin-bottom:12px;font-style:italic">${esc(result.notes)}</p>`;
    } else {
      inner.innerHTML = '';
    }

    inner.innerHTML += (result.selectedQuestions || []).map((q, i) =>
      `<div class="quiz-suggestion-item">
        <div class="quiz-q-header">
          <span class="quiz-source-badge ${q.source === 'suggested' ? 'badge-suggested' : 'badge-bank'}">
            ${q.source === 'suggested' ? '✦ AI Suggested' : `Bank #${(q.originalIndex || 0) + 1}`}
          </span>
        </div>
        <div class="quiz-q-body">${esc(q.question)}</div>
        <div class="quiz-q-rationale muted">${esc(q.rationale || '')}</div>
        ${q.source === 'suggested' ? `<button class="btn btn-surf-sec" style="font-size:11px;padding:3px 8px;margin-top:6px"
          onclick="addSuggestedQuestion('${esc(q.question.replace(/'/g, "\\'"))}')">+ Add to Bank</button>` : ''}
      </div>`
    ).join('');

    toast('Questions suggested!', 'success');
  } catch (e) {
    toast('Suggestion failed: ' + e.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = '✦ Suggest Questions';
  }
});

async function addSuggestedQuestion(questionText) {
  S.quizBank.questions.push(questionText);
  await PUT('/api/quiz-bank', S.quizBank);
  renderQuizBank();
  toast('Question added to bank.', 'success');
}

/* ── Course Content & Videos ──────────────────────────────────────────────── */
document.getElementById('btn-load-content').addEventListener('click', loadCourseContent);

async function loadCourseContent() {
  if (!S.course) { toast('Select a course first.', 'warn'); return; }
  const btn = document.getElementById('btn-load-content');
  btn.disabled = true; btn.textContent = '⏳ Loading…';

  try {
    const [modules, pages] = await Promise.all([
      GET(`/api/courses/${S.course.id}/modules`).catch(() => []),
      GET(`/api/courses/${S.course.id}/pages`).catch(() => []),
    ]);

    renderModules(modules);
    renderPages(pages);
    toast('Content loaded.', 'success');
  } catch (e) {
    toast('Load error: ' + e.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = '⟳ Load from Canvas';
  }
}

function renderModules(modules) {
  const wrap = document.getElementById('content-modules');
  if (!modules.length) {
    wrap.innerHTML = '<p class="muted">No modules found.</p>';
    return;
  }
  wrap.innerHTML = modules.map(m => {
    const items = (m.items || []).map(item => {
      const icon = item.type === 'ExternalUrl' ? '🔗'
        : item.type === 'File' ? '📄'
        : item.type === 'Page' ? '📝'
        : item.type === 'Quiz' ? '❓'
        : item.type === 'Assignment' ? '✏'
        : '▸';
      const link = item.url || item.html_url || item.external_url || '#';
      return `<li class="module-item">
        <span>${icon}</span>
        <a href="${esc(link)}" target="_blank" rel="noopener">${esc(item.title)}</a>
        <span class="muted" style="font-size:10px">${esc(item.type || '')}</span>
      </li>`;
    }).join('');
    return `<div class="module-block">
      <div class="module-title">${esc(m.name)} <span class="muted" style="font-size:11px">(${(m.items || []).length} items)</span></div>
      ${items ? `<ul class="module-items">${items}</ul>` : ''}
    </div>`;
  }).join('');
}

function renderPages(pages) {
  const wrap = document.getElementById('content-pages');
  if (!pages.length) {
    wrap.innerHTML = '<p class="muted">No pages found.</p>';
    return;
  }
  wrap.innerHTML = `<ul class="page-list">` +
    pages.map(p =>
      `<li><button class="link-btn" onclick="viewPage('${esc(p.url)}')">${esc(p.title)}</button>
       <span class="muted" style="font-size:10px;margin-left:6px">${p.updated_at ? new Date(p.updated_at).toLocaleDateString() : ''}</span>
       </li>`
    ).join('') + `</ul>`;
}

async function viewPage(pageUrl) {
  if (!S.course) return;
  const wrap = document.getElementById('content-viewer');
  wrap.innerHTML = '<p class="muted">Loading…</p>';
  try {
    const page = await GET(`/api/courses/${S.course.id}/pages/${encodeURIComponent(pageUrl)}`);
    const body = page.body || '(No content)';
    wrap.innerHTML = `<div class="page-title-sm">${esc(page.title)}</div>
      <div class="page-content">${body}</div>`;
  } catch (e) {
    wrap.innerHTML = `<p class="muted">Failed to load page: ${esc(e.message)}</p>`;
  }
}

/* ── Overview ─────────────────────────────────────────────────────────────── */
function renderOverview() {
  const students = allStudents();
  const subs = students.filter(st => {
    const sub = submissionFor(st.id);
    return sub && sub.workflow_state !== 'unsubmitted';
  });
  const graded = Object.values(S.grades).filter(g => g.status !== 'pending');
  const flagged = Object.values(S.grades).filter(g => g.flagged);

  const scores = Object.values(S.grades)
    .map(g => g.finalScore)
    .filter(s => s != null);
  const avg = scores.length ? (scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1) : '—';

  document.getElementById('stat-students').textContent = students.length || '—';
  document.getElementById('stat-submitted').textContent = subs.length || '—';
  document.getElementById('stat-graded').textContent = graded.length || '—';
  document.getElementById('stat-flagged').textContent = flagged.length || '—';
  document.getElementById('stat-avg').textContent = avg;

  const aWrap = document.getElementById('overview-assignment');
  if (S.assignment) {
    const due = S.assignment.due_at ? new Date(S.assignment.due_at).toLocaleDateString() : 'No due date';
    const instrNote = S.aiInstructions ? `<p style="font-size:12px;color:var(--success);margin-top:4px">✓ AI instructions set</p>` : '';
    aWrap.innerHTML = `
      <p><strong>${esc(S.assignment.name)}</strong></p>
      <p class="muted">Due: ${due} · ${S.assignment.points_possible || '?'} pts</p>
      <p class="muted">Course: ${esc(S.course?.name || '—')}</p>
      ${instrNote}`;
  } else {
    aWrap.innerHTML = '<p class="muted">No assignment selected.</p>';
  }

  const rWrap = document.getElementById('overview-rubric');
  if (S.rubric?.criteria?.length) {
    rWrap.innerHTML = `<p><strong>${esc(S.rubric.name || 'Untitled Rubric')}</strong> · ${S.rubric.totalPoints} pts</p>
      <ul style="padding-left:18px;margin-top:8px">
        ${S.rubric.criteria.map(c =>
          `<li>${esc(c.name)} — ${c.maxPoints} pts${c.autoGrant ? ' (auto)' : ''}</li>`
        ).join('')}
      </ul>`;
  } else {
    rWrap.innerHTML = '<p class="muted">No rubric set.</p>';
  }

  const fWrap = document.getElementById('overview-flags');
  if (flagged.length) {
    fWrap.innerHTML = `<ul style="padding-left:18px">
      ${flagged.slice(0, 8).map(g => {
        const conf = g.aiConfidence || (g.aiDetection?.score * 10) || 0;
        return `<li><strong>${esc(g.studentName)}</strong> — ${conf}% AI confidence</li>`;
      }).join('')}
      ${flagged.length > 8 ? `<li class="muted">…and ${flagged.length - 8} more</li>` : ''}
    </ul>`;
  } else {
    fWrap.innerHTML = '<p class="muted">No flags yet.</p>';
  }
}

/* ── Manual Add ───────────────────────────────────────────────────────────── */
async function addManualStudent(gradeNow) {
  const name = document.getElementById('manual-name').value.trim();
  const id = document.getElementById('manual-id').value.trim() || `manual_${Date.now()}`;
  const text = document.getElementById('manual-text').value.trim();
  const isLate = document.getElementById('manual-late').checked;
  const hasAiCitation = document.getElementById('manual-ai-cite').checked;

  if (!name) { toast('Enter a student name.', 'warn'); return; }

  S.manualStudents.push({ id, name });

  S.submissions.push({
    user_id: id,
    workflow_state: text ? 'submitted' : 'unsubmitted',
    body: text,
    late: isLate,
    _manualText: text,
    _hasAiCitation: hasAiCitation,
  });

  document.getElementById('manual-name').value = '';
  document.getElementById('manual-id').value = '';
  document.getElementById('manual-text').value = '';
  document.getElementById('manual-late').checked = false;
  document.getElementById('manual-ai-cite').checked = false;

  toast(`Added ${name}.`, 'success');

  if (gradeNow && S.rubric && text && S.health?.claude) {
    try {
      const res = await POST('/api/grade/single', {
        text, rubric: S.rubric, studentName: name, hasAiCitation,
        aiInstructions: S.aiInstructions,
      });
      applyAiGrade(id, res.grade, res.aiDetection, res.flagged);
      await saveGrade(id);
      toast(`${name} graded!`, 'success');
    } catch (e) {
      toast('Grading failed: ' + e.message, 'error');
    }
  }

  renderStudentsTable();
  renderGradesTable();
  renderOverview();
}

document.getElementById('btn-manual-add').addEventListener('click', () => addManualStudent(true));
document.getElementById('btn-manual-add-only').addEventListener('click', () => addManualStudent(false));

/* ── Export ───────────────────────────────────────────────────────────────── */
document.getElementById('btn-export').addEventListener('click', () => {
  if (!S.course || !S.assignment) { toast('Select a course and assignment.', 'warn'); return; }
  window.location.href = `/api/grades/${S.course.id}/${S.assignment.id}/export.csv`;
});

/* ── Clear Grades ──────────────────────────────────────────────────────────── */
document.getElementById('btn-clear-grades').addEventListener('click', async () => {
  if (!confirm('Clear all grades for this assignment? This cannot be undone.')) return;
  if (S.course && S.assignment) {
    await DEL(`/api/grades/${S.course.id}/${S.assignment.id}`);
  }
  S.grades = {};
  renderGradesTable();
  renderStudentsTable();
  renderOverview();
  toast('Grades cleared.');
});

/* ── Buttons state ────────────────────────────────────────────────────────── */
function updateButtons() {
  const hasAssignment = !!(S.assignment);
  const hasRubric = !!(S.rubric?.criteria?.length);
  document.getElementById('btn-grade-all').disabled = !(hasAssignment || S.manualStudents.length) || !hasRubric;
  document.getElementById('btn-export').disabled = !hasAssignment;
}

/* ── Utility ──────────────────────────────────────────────────────────────── */
function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* ── Auth ─────────────────────────────────────────────────────────────────── */
document.getElementById('btn-logout').addEventListener('click', async () => {
  await fetch('/auth/logout', { method: 'POST' });
  window.location.href = '/login.html';
});

async function loadCurrentUser() {
  try {
    const me = await GET('/auth/me');
    if (!me.authenticated) { window.location.href = '/login.html'; return; }
    document.getElementById('hdr-username').textContent = me.username;
  } catch { window.location.href = '/login.html'; }
}

/* ── Boot ─────────────────────────────────────────────────────────────────── */
loadCurrentUser().then(() => init()).catch(console.error);
