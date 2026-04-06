/* ═══════════════════════════════════════════════════════════════════════════
   TA Companion — app.js
   4-grader model: AI (auto) | Marco | Marlowe | Final
   Sidebar: collapsible groups by assignment type from Canvas
   Default course: B BUS 464 (auto-selected on login)
   ═══════════════════════════════════════════════════════════════════════════ */

/* ── State ─────────────────────────────────────────────────────────────────── */
const S = {
  health: null,
  courses: [],
  course: null,
  assignments: [],           // all Canvas assignments for current course
  assignmentGroups: {},      // { groupName: [assignment, ...] }
  currentAssignment: null,   // assignment currently open
  students: [],
  submissions: [],
  grades: {},                // studentId → grade  (for current assignment)
  allGrades: {},             // assignmentId → { studentId → grade }
  rubric: null,              // active rubric for current assignment
  rubrics: [],
  aiInstructions: '',
  manualStudents: [],
  quizBank: { questions: [] },
};

const DEFAULT_COURSE_NAME = 'B BUS 464';

/* ── API helpers ────────────────────────────────────────────────────────────── */
async function api(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(path, opts);
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}
const GET  = p      => api('GET',    p);
const POST = (p, b) => api('POST',   p, b);
const PUT  = (p, b) => api('PUT',    p, b);
const DEL  = p      => api('DELETE', p);

/* ── Toast ─────────────────────────────────────────────────────────────────── */
let toastTimer;
function toast(msg, type = '') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `toast ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 3500);
}

/* ── Escape HTML ────────────────────────────────────────────────────────────── */
function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/* ═══════════════════════════════════════════════════════════════════════════
   BOOT
   ═══════════════════════════════════════════════════════════════════════════ */
async function init() {
  // Check health
  try { S.health = await GET('/api/health'); renderStatusBadges(); } catch { }

  // Load quiz bank
  try { S.quizBank = await GET('/api/quiz-bank'); } catch { S.quizBank = { questions: [] }; }

  // Load courses then auto-select B BUS 464
  if (S.health?.canvas) {
    await loadCourses();
    autoSelectCourse();
  } else {
    document.getElementById('sel-course').innerHTML = '<option value="">Canvas not configured</option>';
    showView('overview');
  }
}

function renderStatusBadges() {
  const el = document.getElementById('status-badges');
  const c = S.health?.canvas ? '<span class="badge badge--green">Canvas ✓</span>' : '<span class="badge badge--red">Canvas ✗</span>';
  const ai = S.health?.claude ? '<span class="badge badge--green">Claude ✓</span>' : '<span class="badge badge--red">Claude ✗</span>';
  el.innerHTML = c + ai;
}

/* ── Courses ─────────────────────────────────────────────────────────────────── */
async function loadCourses() {
  try {
    S.courses = await GET('/api/courses');
    const sel = document.getElementById('sel-course');
    sel.innerHTML = '<option value="">— Select Course —</option>' +
      S.courses.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
  } catch (e) { toast('Failed to load courses: ' + e.message, 'error'); }
}

function autoSelectCourse() {
  const match = S.courses.find(c => c.name && c.name.toUpperCase().includes(DEFAULT_COURSE_NAME.toUpperCase()));
  if (match) {
    const sel = document.getElementById('sel-course');
    sel.value = String(match.id);
    sel.dispatchEvent(new Event('change'));
  } else {
    showView('overview');
  }
}

document.getElementById('sel-course').addEventListener('change', async function () {
  const id = this.value;
  if (!id) { S.course = null; S.assignments = []; renderSidebar(); showView('overview'); return; }
  S.course = S.courses.find(c => String(c.id) === id) || { id, name: this.options[this.selectedIndex].text };
  await loadCourseData();
});

async function loadCourseData() {
  if (!S.course) return;
  toast('Loading course data…');
  try {
    const [assignments, allGradesRaw] = await Promise.all([
      GET(`/api/courses/${S.course.id}/assignments`),
      GET(`/api/grades/${S.course.id}/all`).catch(() => ({})),
    ]);
    S.assignments = assignments;
    S.allGrades = allGradesRaw;
    groupAssignments();
    renderSidebar();
    showView('overview');
    toast('Course loaded.', 'success');
  } catch (e) { toast('Load error: ' + e.message, 'error'); }
}

/* ── Assignment grouping ─────────────────────────────────────────────────────── */
// Maps Canvas assignment name patterns → display group (matches syllabus exactly)
const GROUP_RULES = [
  // QUIZZES — "Quiz – Chapters X–Y" style
  { key: 'Quizzes', patterns: [
    /quiz/i,
    /chapter \d{1,2}[-–]\d{1,2}/i,
  ]},
  // CASE DISCUSSIONS — HBS cases, case write-ups, in-class discussions, essays
  { key: 'Case Discussions', patterns: [
    /case/i,
    /hbs/i,
    /discussion/i,
    /coffee mug/i,
    /amazon 2025/i,
    /lego/i,
    /anker/i,
    /coca.?cola/i,
    /fitbit/i,
    /cree/i,
    /gillette/i,
    /tesla.*marketing/i,
    /chipotle/i,
    /crossing the chasm.*essay/i,
  ]},
  // ACTIVITIES — simulations, AI exercises, workshops, presentations
  { key: 'Activities', patterns: [
    /simulation/i,
    /workshop/i,
    /exercise/i,
    /food truck/i,
    /persona/i,
    /positioning.*(map|sim)/i,
    /blog writing/i,
    /slide creation/i,
    /product of the week/i,
    /atar/i,
    /launch management/i,
    /minimum viable/i,
    /jobs to be done/i,
    /ai.*demo/i,
    /copilot/i,
  ]},
  // GROUP PROJECT — milestones and final deliverables
  { key: 'Group Project', patterns: [
    /milestone/i,
    /group.*project/i,
    /project.*group/i,
    /peer evaluation/i,
    /final project/i,
    /form group/i,
    /company selection/i,
    /first take/i,
    /draft outline/i,
    /mid.project/i,
    /forecast.*group/i,
  ]},
  // PARTICIPATION
  { key: 'Participation', patterns: [
    /participation/i,
    /class part/i,
  ]},
  // FINAL EXAM
  { key: 'Final Exam', patterns: [
    /final exam/i,
    /comprehensive.*exam/i,
    /exam.*final/i,
  ]},
  // RECORDED LECTURES — weekly chapter videos (1 pt each)
  { key: 'Recorded Lectures', patterns: [
    /recorded lecture/i,
    /week \d.*chapter/i,
    /chapter.*week \d/i,
    /lecture.*week/i,
    /week \d.*lecture/i,
  ]},
];

function classifyAssignment(a) {
  const name = a.name || '';
  for (const rule of GROUP_RULES) {
    if (rule.patterns.some(p => p.test(name))) return rule.key;
  }
  return 'Other Assignments';
}

function groupAssignments() {
  const groups = {};
  S.assignments.forEach(a => {
    const g = classifyAssignment(a);
    if (!groups[g]) groups[g] = [];
    groups[g].push(a);
  });
  // Sort each group by due date
  Object.values(groups).forEach(arr => arr.sort((a, b) => {
    if (!a.due_at) return 1;
    if (!b.due_at) return -1;
    return new Date(a.due_at) - new Date(b.due_at);
  }));
  S.assignmentGroups = groups;
}

/* ── Sidebar ─────────────────────────────────────────────────────────────────── */
const GROUP_ICONS = {
  'Quizzes':            '?',
  'Case Discussions':   '📋',
  'Activities':         '✏',
  'Group Project':      '◈',
  'Participation':      '✦',
  'Final Exam':         '★',
  'Recorded Lectures':  '▶',
  'Other Assignments':  '◉',
};

// Sidebar display order matches syllabus
const GROUP_ORDER = ['Quizzes', 'Case Discussions', 'Activities', 'Group Project', 'Participation', 'Final Exam', 'Recorded Lectures', 'Other Assignments'];

// All groups start CLOSED — click to expand
const expandedGroups = new Set();

function renderSidebar() {
  const wrap = document.getElementById('sidebar-assignments');
  if (!S.assignments.length) { wrap.innerHTML = ''; return; }

  const keys = [...GROUP_ORDER.filter(k => S.assignmentGroups[k]), ...Object.keys(S.assignmentGroups).filter(k => !GROUP_ORDER.includes(k))];

  wrap.innerHTML = keys.map(groupName => {
    const assignments = S.assignmentGroups[groupName] || [];
    const isOpen = expandedGroups.has(groupName);
    const icon = GROUP_ICONS[groupName] || '◉';

    // Count how many need grading in this group
    const needsGrading = assignments.filter(a => assignmentNeedsGrading(a)).length;
    const badge = needsGrading > 0 ? `<span class="sidebar-badge">${needsGrading}</span>` : '';

    const items = assignments.map(a => {
      const isActive = S.currentAssignment && String(S.currentAssignment.id) === String(a.id);
      const pts = a.points_possible ? ` · ${a.points_possible}pt` : '';
      const flag = assignmentNeedsGrading(a) ? '<span class="sidebar-dot"></span>' : '';
      return `<button class="sidebar-item ${isActive ? 'active' : ''}" onclick="selectAssignment('${a.id}')" title="${esc(a.name)}">
        ${flag}${esc(shortName(a.name))}${pts}
      </button>`;
    }).join('');

    return `<div class="sidebar-group">
      <button class="sidebar-group-header" onclick="toggleGroup('${esc(groupName)}')">
        <span class="nav-icon">${icon}</span>
        <span class="sidebar-group-name">${esc(groupName)}</span>
        ${badge}
        <span class="sidebar-chevron">${isOpen ? '▾' : '▸'}</span>
      </button>
      <div class="sidebar-group-items ${isOpen ? 'open' : ''}" id="grp-${esc(groupName)}">${items}</div>
    </div>`;
  }).join('');
}

function shortName(name) {
  return name.length > 28 ? name.substring(0, 27) + '…' : name;
}

function toggleGroup(name) {
  if (expandedGroups.has(name)) expandedGroups.delete(name);
  else expandedGroups.add(name);
  renderSidebar();
}

function assignmentNeedsGrading(a) {
  const gradeData = S.allGrades[String(a.id)] || {};
  const anyUnreviewed = Object.values(gradeData).some(g => g.status !== 'reviewed');
  return anyUnreviewed; // simplistic — also true if no grades yet but has submissions
}

/* ── Sidebar nav buttons (non-assignment views) ──────────────────────────────── */
document.querySelectorAll('.nav-btn[data-view]').forEach(btn => {
  btn.addEventListener('click', () => showView(btn.dataset.view));
});

function setActiveSidebarBtn(view) {
  document.querySelectorAll('.nav-btn[data-view]').forEach(b => {
    b.classList.toggle('active', b.dataset.view === view);
  });
  // Deactivate all assignment items if a static view is selected
  document.querySelectorAll('.sidebar-item').forEach(b => b.classList.remove('active'));
}

/* ── Select assignment ───────────────────────────────────────────────────────── */
async function selectAssignment(assignmentId) {
  const a = S.assignments.find(x => String(x.id) === String(assignmentId));
  if (!a) return;
  S.currentAssignment = a;
  S.students = [];
  S.submissions = [];
  S.grades = {};
  S.rubric = null;
  S.aiInstructions = '';

  // Deactivate all sidebar items, activate this one
  document.querySelectorAll('.sidebar-item').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.sidebar-item').forEach(b => {
    if (b.onclick?.toString().includes(String(assignmentId))) b.classList.add('active');
  });
  setActiveSidebarBtn(null);

  // Update header buttons
  document.getElementById('btn-export').disabled = false;
  document.getElementById('btn-grade-all').disabled = false;

  showView('assignment');

  // Load data in background
  loadAssignmentData(assignmentId);
}

async function loadAssignmentData(assignmentId) {
  if (!S.course) return;
  const cid = S.course.id;
  const aid = assignmentId;

  try {
    const [enrollments, subs, grades, settings, savedRubric] = await Promise.all([
      GET(`/api/courses/${cid}/students`),
      GET(`/api/courses/${cid}/assignments/${aid}/submissions`),
      GET(`/api/grades/${cid}/${aid}`),
      GET(`/api/assignment-settings/${cid}/${aid}`).catch(() => ({})),
      GET(`/api/assignment-rubric/${cid}/${aid}`).catch(() => null),
      GET('/api/rubrics').then(r => { S.rubrics = r; }).catch(() => {}),
    ]);
    S.students = enrollments;
    S.submissions = subs;
    S.grades = grades;
    S.aiInstructions = settings.aiInstructions || '';
    if (savedRubric) S.rubric = savedRubric;
    else S.rubric = defaultRubricForAssignment(S.currentAssignment);

    // Update allGrades cache
    S.allGrades[String(aid)] = grades;

    renderAssignmentView();
    renderSidebar();
    toast('Assignment data loaded.', 'success');
  } catch (e) {
    toast('Load error: ' + e.message, 'error');
    renderAssignmentView();
  }
}

/* ── Default rubric based on assignment type ─────────────────────────────────── */
function defaultRubricForAssignment(a) {
  if (!a) return defaultRubric();
  const group = classifyAssignment(a);
  const pts = a.points_possible || 15;

  if (group === 'Recorded Lectures') {
    return {
      name: a.name, totalPoints: pts,
      criteria: [
        { id: 'c1', name: 'Lecture Viewed', maxPoints: pts, description: 'Student has watched all required lecture videos for this week.', autoGrant: false },
      ],
    };
  }
  if (group === 'Quizzes') {
    return {
      name: a.name, totalPoints: pts,
      criteria: [
        { id: 'c1', name: 'Quiz Score', maxPoints: pts, description: 'Automatically graded quiz score (5 pts).', autoGrant: false },
      ],
    };
  }
  if (group === 'Case Studies') {
    return {
      name: a.name, totalPoints: pts,
      description: '',
      criteria: [
        { id: 'c1', name: 'Submission', maxPoints: 5, description: 'Student submitted any work.', autoGrant: true },
        { id: 'c2', name: 'Executive Summary & Recommendations', maxPoints: 4, description: 'Clear executive summary with specific, actionable recommendations presented upfront.', autoGrant: false },
        { id: 'c3', name: 'Supporting Points & Evidence', maxPoints: 3, description: 'Recommendations backed with data, evidence, and analysis.', autoGrant: false },
        { id: 'c4', name: 'Conclusion / Alternatives', maxPoints: 2, description: 'Thoughtful conclusion with alternatives considered or other insights.', autoGrant: false },
        { id: 'c5', name: 'Writing Quality', maxPoints: 1, description: 'Well-organized, clearly written, and professional.', autoGrant: false },
      ],
    };
  }
  return defaultRubric();
}

function defaultRubric() {
  return {
    name: '', totalPoints: 15,
    criteria: [
      { id: 'c1', name: 'Submission', maxPoints: 5, description: 'Student submitted any work.', autoGrant: true },
      { id: 'c2', name: 'Executive Summary & Recommendations', maxPoints: 3, description: 'Clear executive summary with specific, actionable recommendations upfront.', autoGrant: false },
      { id: 'c3', name: 'Supporting Points & Evidence', maxPoints: 3, description: 'Claims backed with specific evidence, data, or analysis.', autoGrant: false },
      { id: 'c4', name: 'Conclusion / Alternatives', maxPoints: 3, description: 'Thoughtful conclusion, alternatives considered, additional insights.', autoGrant: false },
      { id: 'c5', name: 'Writing Quality', maxPoints: 1, description: 'Well-organized, clearly written, professional.', autoGrant: false },
    ],
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   VIEWS — rendered into #view-root
   ═══════════════════════════════════════════════════════════════════════════ */
let currentView = null;

function showView(name) {
  currentView = name;
  if (name !== 'assignment') setActiveSidebarBtn(name);
  const root = document.getElementById('view-root');
  switch (name) {
    case 'overview':    renderOverview(root); break;
    case 'assignment':  renderAssignmentView(root); break;
    case 'quiz':        renderQuizView(root); break;
    case 'content':     renderContentView(root); break;
    case 'manual':      renderManualView(root); break;
    default:            renderOverview(root);
  }
}

/* ── OVERVIEW VIEW ───────────────────────────────────────────────────────────── */
function renderOverview(root) {
  root = root || document.getElementById('view-root');

  // Compute stats across all assignments
  const now = new Date();
  const upcoming = S.assignments
    .filter(a => a.due_at && new Date(a.due_at) > now)
    .sort((a, b) => new Date(a.due_at) - new Date(b.due_at))
    .slice(0, 8);

  const needsGrading = S.assignments.filter(a => {
    const g = S.allGrades[String(a.id)] || {};
    return Object.values(g).some(gr => gr.status !== 'reviewed');
  });

  // Recent graded — last assignment with all reviewed
  const recentlyGraded = S.assignments.filter(a => {
    const g = S.allGrades[String(a.id)] || {};
    const vals = Object.values(g);
    return vals.length > 0 && vals.every(gr => gr.status === 'reviewed');
  }).slice(-3);

  // AI flags across all assignments
  const allFlags = [];
  Object.entries(S.allGrades).forEach(([aid, students]) => {
    const a = S.assignments.find(x => String(x.id) === aid);
    Object.values(students).forEach(g => {
      if (g.flagged) allFlags.push({ ...g, assignmentName: a?.name || aid });
    });
  });

  // Avg score of most recent reviewed assignment
  let avgHtml = '—';
  if (recentlyGraded.length) {
    const last = recentlyGraded[recentlyGraded.length - 1];
    const grades = Object.values(S.allGrades[String(last.id)] || {});
    const scores = grades.map(g => g.finalScore).filter(s => s != null);
    if (scores.length) {
      const avg = (scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1);
      avgHtml = `${avg} / ${last.points_possible || '?'} <span class="muted" style="font-size:12px">(${esc(last.name)})</span>`;
    }
  }

  root.innerHTML = `
    <div class="page-title">Overview — ${esc(S.course?.name || 'No course selected')}</div>

    <!-- Stat strip -->
    <div class="stat-cards">
      <div class="stat-card">
        <div class="stat-value">${S.assignments.length || '—'}</div>
        <div class="stat-label">Assignments</div>
      </div>
      <div class="stat-card stat-card--warn">
        <div class="stat-value">${needsGrading.length || '0'}</div>
        <div class="stat-label">Need Grading</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${allFlags.length || '0'}</div>
        <div class="stat-label">AI Flags</div>
      </div>
      <div class="stat-card">
        <div class="stat-value" style="font-size:18px">${avgHtml}</div>
        <div class="stat-label">Last Avg Score</div>
      </div>
    </div>

    <div class="overview-grid">

      <!-- Needs Grading -->
      <div class="card card-full">
        <div class="card-title">🔴 Needs Grading (${needsGrading.length})</div>
        ${needsGrading.length ? `<table class="overview-table">
          <thead><tr><th>Assignment</th><th>Type</th><th>Due</th><th>Points</th><th>Pending</th><th></th></tr></thead>
          <tbody>${needsGrading.map(a => {
            const g = S.allGrades[String(a.id)] || {};
            const pending = Object.values(g).filter(gr => gr.status !== 'reviewed').length;
            const due = a.due_at ? new Date(a.due_at).toLocaleDateString() : '—';
            return `<tr>
              <td><button class="link-btn" onclick="selectAssignment('${a.id}')">${esc(a.name)}</button></td>
              <td><span class="type-badge">${esc(classifyAssignment(a))}</span></td>
              <td>${due}</td>
              <td>${a.points_possible || '—'}</td>
              <td><span class="status-badge status--warn">${pending} pending</span></td>
              <td><button class="btn btn-surf" style="font-size:11px;padding:4px 10px" onclick="selectAssignment('${a.id}')">Open</button></td>
            </tr>`;
          }).join('')}</tbody>
        </table>` : '<p class="muted">All assignments reviewed! 🎉</p>'}
      </div>

      <!-- Upcoming Due -->
      <div class="card">
        <div class="card-title">📅 Upcoming Due Dates</div>
        ${upcoming.length ? `<ul class="overview-list">${upcoming.map(a => {
          const due = new Date(a.due_at);
          const diff = Math.ceil((due - now) / (1000 * 60 * 60 * 24));
          const urgency = diff <= 2 ? 'color:var(--danger);font-weight:700' : diff <= 7 ? 'color:var(--warn)' : '';
          return `<li>
            <button class="link-btn" onclick="selectAssignment('${a.id}')">${esc(a.name)}</button>
            <span style="${urgency}">${due.toLocaleDateString()} (${diff}d)</span>
          </li>`;
        }).join('')}</ul>` : '<p class="muted">No upcoming due dates.</p>'}
      </div>

      <!-- AI Flags -->
      <div class="card">
        <div class="card-title">⚑ AI Flags (${allFlags.length})</div>
        ${allFlags.length ? `<ul class="overview-list">${allFlags.slice(0, 10).map(f => `
          <li>
            <strong>${esc(f.studentName)}</strong>
            <span class="muted">${esc(f.assignmentName)}</span>
            <span class="ai-badge ai-badge--high">${f.aiConfidence || 0}%</span>
          </li>`).join('')}
          ${allFlags.length > 10 ? `<li class="muted">…and ${allFlags.length - 10} more</li>` : ''}
        </ul>` : '<p class="muted">No AI flags.</p>'}
      </div>

      <!-- Recently Graded -->
      <div class="card">
        <div class="card-title">✅ Recently Completed</div>
        ${recentlyGraded.length ? `<ul class="overview-list">${recentlyGraded.map(a => {
          const grades = Object.values(S.allGrades[String(a.id)] || {});
          const scores = grades.map(g => g.finalScore).filter(s => s != null);
          const avg = scores.length ? (scores.reduce((x, y) => x + y, 0) / scores.length).toFixed(1) : '—';
          return `<li>
            <button class="link-btn" onclick="selectAssignment('${a.id}')">${esc(a.name)}</button>
            <span>Avg: <strong>${avg}</strong> / ${a.points_possible || '?'}</span>
          </li>`;
        }).join('')}</ul>` : '<p class="muted">No completed assignments yet.</p>'}
      </div>

    </div>`;
}

/* ── ASSIGNMENT VIEW ─────────────────────────────────────────────────────────── */
function renderAssignmentView(root) {
  root = root || document.getElementById('view-root');
  const a = S.currentAssignment;
  if (!a) { root.innerHTML = '<p class="muted padded">Select an assignment from the sidebar.</p>'; return; }

  const group = classifyAssignment(a);
  const due = a.due_at ? new Date(a.due_at).toLocaleDateString() : 'No due date';
  const students = allStudents();
  const graded  = Object.values(S.grades).filter(g => g.status !== 'pending');
  const flagged = Object.values(S.grades).filter(g => g.flagged);
  const scores  = Object.values(S.grades).map(g => g.finalScore).filter(s => s != null);
  const avg     = scores.length ? (scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1) : '—';

  root.innerHTML = `
    <div class="page-title">
      ${esc(a.name)}
      <span class="type-badge" style="font-size:13px">${esc(group)}</span>
      <div class="page-actions">
        <button class="btn btn-ghost" onclick="selectAssignment('${a.id}')">⟳ Refresh</button>
      </div>
    </div>

    <!-- Assignment meta + stats -->
    <div class="assignment-meta-bar">
      <span>Due: <strong>${due}</strong></span>
      <span>Points: <strong>${a.points_possible || '?'}</strong></span>
      <span>Students: <strong>${students.length}</strong></span>
      <span>Graded: <strong>${graded.length}</strong></span>
      <span>Avg: <strong>${avg}</strong></span>
      ${flagged.length ? `<span class="ai-badge ai-badge--high">⚑ ${flagged.length} AI flags</span>` : ''}
    </div>

    <!-- Tabs -->
    <div class="assign-tabs" id="assign-tabs">
      <button class="assign-tab active" data-atab="instructions" onclick="switchAssignTab('instructions')">Instructions & Rubric</button>
      <button class="assign-tab" data-atab="students" onclick="switchAssignTab('students')">Students (${students.length})</button>
      <button class="assign-tab" data-atab="matrix" onclick="switchAssignTab('matrix')">Grading Matrix</button>
    </div>

    <div id="atab-instructions" class="atab-content active">${renderInstructionsTab()}</div>
    <div id="atab-students"     class="atab-content">${renderStudentsTabHtml()}</div>
    <div id="atab-matrix"       class="atab-content">${renderMatrixTabHtml()}</div>
  `;
}

function switchAssignTab(tab) {
  document.querySelectorAll('.assign-tab').forEach(b => b.classList.toggle('active', b.dataset.atab === tab));
  document.querySelectorAll('.atab-content').forEach(c => c.classList.toggle('active', c.id === `atab-${tab}`));
}

/* ── Instructions & Rubric Tab ───────────────────────────────────────────────── */
function renderInstructionsTab() {
  const rubric = S.rubric || defaultRubricForAssignment(S.currentAssignment);
  const criteriaHtml = (rubric.criteria || []).map((c, i) => `
    <div class="criterion-row ${c.autoGrant ? 'auto-grant' : ''}" id="cr-${esc(c.id)}">
      <div class="criterion-inner">
        <input class="input" type="text" placeholder="Criterion name" value="${esc(c.name)}"
          oninput="updateCriterion('${esc(c.id)}','name',this.value)" />
        <textarea class="input" rows="2" placeholder="Description — what earns full points?"
          oninput="updateCriterion('${esc(c.id)}','description',this.value)">${esc(c.description)}</textarea>
      </div>
      <div>
        <label style="font-size:11px;color:var(--text-muted)">Max Pts</label>
        <input class="input criterion-pts" type="number" min="0" value="${c.maxPoints}"
          oninput="updateCriterion('${esc(c.id)}','maxPoints',Number(this.value))" />
      </div>
      <div class="criterion-autogrant">
        <label>Auto</label>
        <input type="checkbox" ${c.autoGrant ? 'checked' : ''}
          onchange="updateCriterion('${esc(c.id)}','autoGrant',this.checked)" />
      </div>
      <button class="criterion-delete" onclick="deleteCriterion('${esc(c.id)}')" title="Remove">✕</button>
    </div>`).join('');

  return `
    <div class="two-col-grid">

      <!-- AI Grading Instructions -->
      <div class="card">
        <div class="card-title">AI Grading Instructions
          <span class="card-title-hint">Injected into every AI grading prompt for this assignment</span>
        </div>
        <textarea id="ai-instructions-text" class="input" rows="5"
          placeholder="Enter specific grading instructions for the AI…

Example: 'This is a case write-up. Students MUST have an executive summary with recommendations, supporting points, and a conclusion with alternatives. Penalize missing sections heavily.'"
        >${esc(S.aiInstructions)}</textarea>
        <div style="display:flex;gap:8px;margin-top:8px;align-items:center">
          <button class="btn btn-surf" onclick="saveAiInstructions()">Save Instructions</button>
          <span id="ai-instr-status" class="muted" style="font-size:12px"></span>
        </div>
        <div class="case-reminder">
          <strong>Case Write-up Format:</strong>
          ① Executive Summary + Recommendations &nbsp;·&nbsp;
          ② Supporting Points &amp; Evidence &nbsp;·&nbsp;
          ③ Conclusion / Alternatives / Other Thoughts
        </div>
      </div>

      <!-- Rubric -->
      <div class="card">
        <div class="card-title">
          Rubric
          <div class="page-actions" style="margin-left:auto">
            <button class="btn btn-ghost" style="font-size:12px" onclick="generateRubricAi()">✦ AI Generate</button>
            <button class="btn btn-surf" style="font-size:12px" onclick="saveAssignmentRubric()">Save Rubric</button>
          </div>
        </div>
        <div class="rubric-meta-row" style="margin-bottom:12px">
          <div class="field-group field-group--sm">
            <label>Total Points</label>
            <input id="rubric-total" type="number" class="input" value="${rubric.totalPoints || 15}" min="1"
              oninput="if(S.rubric)S.rubric.totalPoints=Number(this.value)" />
          </div>
          <div class="field-group" style="flex:1">
            <label>Description (for AI generation)</label>
            <input id="rubric-desc" type="text" class="input" placeholder="Describe the assignment…"
              value="${esc(rubric.description || '')}"
              oninput="if(S.rubric)S.rubric.description=this.value" />
          </div>
        </div>
        <div id="rubric-criteria-list">${criteriaHtml}</div>
        <button class="btn btn-ghost btn-add-row" onclick="addCriterion()">+ Add Criterion</button>
      </div>

    </div>`;
}

function updateCriterion(id, field, value) {
  if (!S.rubric) return;
  const c = S.rubric.criteria.find(x => x.id === id);
  if (c) c[field] = value;
  if (field === 'autoGrant') document.getElementById(`cr-${id}`)?.classList.toggle('auto-grant', value);
}

function deleteCriterion(id) {
  if (!S.rubric) return;
  S.rubric.criteria = S.rubric.criteria.filter(c => c.id !== id);
  refreshInstructionsTab();
}

function addCriterion() {
  if (!S.rubric) S.rubric = defaultRubricForAssignment(S.currentAssignment);
  S.rubric.criteria.push({ id: 'c' + Date.now(), name: '', maxPoints: 3, description: '', autoGrant: false });
  refreshInstructionsTab();
}

function refreshInstructionsTab() {
  const el = document.getElementById('atab-instructions');
  if (el) el.innerHTML = renderInstructionsTab();
}

async function saveAiInstructions() {
  if (!S.course || !S.currentAssignment) { toast('No assignment selected.', 'warn'); return; }
  S.aiInstructions = document.getElementById('ai-instructions-text')?.value?.trim() || '';
  try {
    await PUT(`/api/assignment-settings/${S.course.id}/${S.currentAssignment.id}`, { aiInstructions: S.aiInstructions });
    const el = document.getElementById('ai-instr-status');
    if (el) { el.textContent = 'Saved!'; setTimeout(() => { el.textContent = ''; }, 2000); }
    toast('Instructions saved.', 'success');
  } catch (e) { toast('Save failed: ' + e.message, 'error'); }
}

async function saveAssignmentRubric() {
  if (!S.course || !S.currentAssignment || !S.rubric) { toast('No rubric to save.', 'warn'); return; }
  try {
    await PUT(`/api/assignment-rubric/${S.course.id}/${S.currentAssignment.id}`, S.rubric);
    toast('Rubric saved.', 'success');
  } catch (e) { toast('Save failed: ' + e.message, 'error'); }
}

async function generateRubricAi() {
  const desc = document.getElementById('rubric-desc')?.value || S.currentAssignment?.name || '';
  const pts  = Number(document.getElementById('rubric-total')?.value) || 15;
  if (!desc) { toast('Enter a description first.', 'warn'); return; }
  if (!S.health?.claude) { toast('Claude not configured.', 'error'); return; }
  toast('Generating rubric…');
  try {
    const gen = await POST('/api/rubrics/generate', { description: desc, totalPoints: pts });
    S.rubric = { ...gen, id: S.rubric?.id };
    refreshInstructionsTab();
    toast('Rubric generated! Save it when ready.', 'success');
  } catch (e) { toast('Generation failed: ' + e.message, 'error'); }
}

/* ── Students Tab ────────────────────────────────────────────────────────────── */
function renderStudentsTabHtml() {
  const students = allStudents();
  if (!students.length) return '<p class="muted padded">No students loaded yet. Data loads automatically.</p>';

  const rows = students.map(st => {
    const sub = submissionFor(st.id);
    const g = S.grades[st.id];
    const submitted = sub && sub.workflow_state !== 'unsubmitted' ? '✓' : '—';
    const late = sub?.late ? '<span class="status-badge status--late">LATE</span>' : '';
    const status = g
      ? `<span class="status-badge status--${g.status === 'reviewed' ? 'reviewed' : 'graded'}">${g.status === 'reviewed' ? 'Reviewed' : 'AI Graded'}</span>`
      : '<span class="status-badge status--pending">Pending</span>';
    const flag = g?.flagged ? '<span class="ai-badge ai-badge--flagged">⚑ AI</span>' : '';
    const final = g?.finalScore != null ? `<strong>${g.finalScore}</strong>` : '—';

    return `<tr>
      <td><button class="link-btn" onclick="openStudent('${esc(st.id)}')">${esc(st.name)}</button></td>
      <td style="text-align:center">${submitted}</td>
      <td>${late}</td>
      <td>${status} ${flag}</td>
      <td style="text-align:center">${final} ${S.rubric ? '/ ' + S.rubric.totalPoints : ''}</td>
      <td><button class="btn btn-surf-sec" style="font-size:11px;padding:4px 8px" onclick="openStudent('${esc(st.id)}')">View/Grade</button></td>
    </tr>`;
  }).join('');

  return `<table>
    <thead><tr><th>Student</th><th>Submitted</th><th>Status</th><th>Grade Status</th><th>Score</th><th></th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

/* ── Grading Matrix Tab ──────────────────────────────────────────────────────── */
function renderMatrixTabHtml() {
  const students = allStudents();
  if (!students.length) return '<p class="muted padded">No students loaded.</p>';
  if (!S.rubric) return '<p class="muted padded">No rubric set. Configure it in the Instructions & Rubric tab.</p>';

  const criteria = S.rubric.criteria;

  const headerCols = criteria.map(c =>
    `<th colspan="3" style="text-align:center" title="${esc(c.description)}">${esc(c.name)}<br><small>/ ${c.maxPoints}</small></th>`
  ).join('');

  const subHeaders = criteria.map(() =>
    `<th class="sub-th sub-th-ai">AI</th><th class="sub-th sub-th-m1">Marco</th><th class="sub-th sub-th-m2">Marlowe</th>`
  ).join('');

  const rows = students.map(st => {
    const g = S.grades[st.id];
    const sub = submissionFor(st.id);
    const submitted = sub && sub.workflow_state !== 'unsubmitted';
    const flagged = g?.flagged;

    let rowClass = flagged ? 'row--flagged' : g?.status === 'reviewed' ? 'row--reviewed' : '';

    const aiConf = g?.aiDetection
      ? `<span class="ai-badge ai-badge--${(g.aiDetection.level || 'none').toLowerCase()}">${g.aiDetection.score * 10}%</span>`
      : '—';

    const statusBadge = !submitted ? '<span class="status-badge status--pending">Not Submitted</span>'
      : sub?.late ? '<span class="status-badge status--late">Late</span>'
      : g ? `<span class="status-badge status--${g.status === 'reviewed' ? 'reviewed' : 'graded'}">${g.status === 'reviewed' ? 'Reviewed' : 'Graded'}</span>`
      : '<span class="status-badge status--submitted">Submitted</span>';

    const scoreCols = criteria.map(c => {
      const cd = g?.criteria?.[c.id];
      const aiS   = cd?.aiScore    != null ? cd.aiScore    : '—';
      const marV  = cd?.marcoScore != null ? cd.marcoScore : '';
      const mrlV  = cd?.marlowScore != null ? cd.marlowScore : '';
      return `
        <td class="score-td score-td-ai"><span class="score-ai">${aiS}</span></td>
        <td class="score-td score-td-m1">
          <input class="score-human-input ${marV !== '' ? 'changed' : ''}" type="number" min="0" max="${c.maxPoints}"
            placeholder="—" value="${marV}"
            data-student="${esc(st.id)}" data-criterion="${esc(c.id)}" data-max="${c.maxPoints}" data-grader="marco"
            onchange="onScoreChange(this)" />
        </td>
        <td class="score-td score-td-m2">
          <input class="score-human-input score-m2-input ${mrlV !== '' ? 'changed' : ''}" type="number" min="0" max="${c.maxPoints}"
            placeholder="—" value="${mrlV}"
            data-student="${esc(st.id)}" data-criterion="${esc(c.id)}" data-max="${c.maxPoints}" data-grader="marlowe"
            onchange="onScoreChange(this)" />
        </td>`;
    }).join('');

    const aiT  = g?.aiTotalScore     != null ? g.aiTotalScore     : '—';
    const marT = g?.marcoTotalScore  != null ? g.marcoTotalScore  : '—';
    const mrlT = g?.marloweTotalScore != null ? g.marloweTotalScore : '—';
    const fin  = g?.finalScore       != null ? `<strong>${g.finalScore}</strong>` : '—';

    return `<tr class="${rowClass}" id="row-${esc(st.id)}">
      <td class="col-sticky"><button class="link-btn" onclick="openStudent('${esc(st.id)}')">${esc(st.name)}</button></td>
      <td>${statusBadge} ${flagged ? '<span class="ai-badge ai-badge--flagged">⚑</span>' : ''}</td>
      <td>${aiConf}</td>
      ${scoreCols}
      <td class="score-td score-td-ai">${aiT}</td>
      <td class="score-td score-td-m1">${marT}</td>
      <td class="score-td score-td-m2">${mrlT}</td>
      <td><strong>${fin}</strong></td>
    </tr>`;
  }).join('');

  const reviewed = Object.values(S.grades).filter(g => g.finalScore != null);

  return `<div class="grade-col-legend">
    <span class="legend-item legend-ai">AI (auto)</span>
    <span class="legend-item legend-m1">Marco</span>
    <span class="legend-item legend-m2">Marlowe</span>
    <span class="muted" style="font-size:11px">Final = Marlowe → Marco → AI</span>
    <div style="margin-left:auto;display:flex;gap:8px;align-items:center">
      <span class="muted" style="font-size:11px">${reviewed.length} with final grade</span>
      <button class="btn btn-surf" style="font-size:12px;padding:5px 12px" onclick="pushAllToCanvas()">
        ⬆ Push Finals to Canvas
      </button>
    </div>
  </div>
  <div class="table-wrap"><table>
    <thead>
      <tr>
        <th rowspan="2">Student</th><th rowspan="2">Status</th><th rowspan="2">AI Conf.</th>
        ${headerCols}
        <th rowspan="2" class="sub-th-ai">AI Total</th>
        <th rowspan="2" class="sub-th-m1">Marco</th>
        <th rowspan="2" class="sub-th-m2">Marlowe</th>
        <th rowspan="2">Final</th>
      </tr>
      <tr>${subHeaders}</tr>
    </thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}

/* ── Push Finals to Canvas ───────────────────────────────────────────────────── */
async function pushAllToCanvas() {
  if (!S.course || !S.currentAssignment) { toast('No assignment open.', 'warn'); return; }
  const withFinal = Object.values(S.grades).filter(g => g.finalScore != null);
  if (!withFinal.length) { toast('No final grades to push.', 'warn'); return; }

  const confirmed = confirm(
    `Push ${withFinal.length} final grade(s) to Canvas for "${S.currentAssignment.name}"?\n\n` +
    `This will overwrite any existing Canvas grades for these students.`
  );
  if (!confirmed) return;

  const btn = document.querySelector('[onclick="pushAllToCanvas()"]');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Pushing…'; }

  try {
    const res = await POST(`/api/canvas/push-grades/${S.course.id}/${S.currentAssignment.id}`, {});
    toast(`✓ Pushed ${res.pushed} grades to Canvas!`, 'success');
  } catch (e) {
    toast('Push failed: ' + e.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '⬆ Push Finals to Canvas'; }
  }
}

/* ── Score change handler ────────────────────────────────────────────────────── */
async function onScoreChange(input) {
  const studentId  = input.dataset.student;
  const criterionId = input.dataset.criterion;
  const max    = Number(input.dataset.max);
  const grader = input.dataset.grader; // 'marco' or 'marlowe'
  let val = input.value.trim() === '' ? null : Number(input.value);
  if (val !== null) val = Math.max(0, Math.min(max, val));

  if (!S.grades[studentId]) S.grades[studentId] = buildEmptyGrade(studentId);
  if (!S.grades[studentId].criteria) S.grades[studentId].criteria = {};
  if (!S.grades[studentId].criteria[criterionId]) S.grades[studentId].criteria[criterionId] = {};

  if (grader === 'marlowe') S.grades[studentId].criteria[criterionId].marlowScore = val;
  else                       S.grades[studentId].criteria[criterionId].marcoScore  = val;

  recalcTotals(studentId);
  S.grades[studentId].status = 'reviewed';
  input.classList.toggle('changed', val !== null);
  await saveGrade(studentId);
}

function recalcTotals(studentId) {
  const g = S.grades[studentId];
  if (!g || !S.rubric) return;
  let aiT = 0, marT = 0, mrlT = 0, hasMarco = false, hasMarlow = false;
  S.rubric.criteria.forEach(c => {
    const cd = g.criteria?.[c.id] || {};
    if (cd.aiScore    != null) aiT  += cd.aiScore;
    if (cd.marcoScore != null) { marT += cd.marcoScore; hasMarco = true; }
    else if (cd.aiScore != null) marT += cd.aiScore;
    if (cd.marlowScore != null) { mrlT += cd.marlowScore; hasMarlow = true; }
    else if (cd.marcoScore != null) mrlT += cd.marcoScore;
    else if (cd.aiScore != null) mrlT += cd.aiScore;
  });
  g.aiTotalScore      = aiT;
  g.marcoTotalScore   = hasMarco  ? marT : null;
  g.marloweTotalScore = hasMarlow ? mrlT : null;
  // Final priority: Marlowe → Marco → AI
  g.finalScore = g.marloweTotalScore != null ? g.marloweTotalScore
               : g.marcoTotalScore   != null ? g.marcoTotalScore
               : g.aiTotalScore;
}

/* ── Grade All with AI ───────────────────────────────────────────────────────── */
document.getElementById('btn-grade-all').addEventListener('click', gradeAll);

async function gradeAll() {
  if (!S.rubric) { toast('No rubric configured.', 'warn'); return; }
  const students = allStudents();
  if (!students.length) { toast('No students loaded.', 'warn'); return; }
  if (!S.health?.claude) { toast('Claude API key not configured.', 'error'); return; }

  const submissions = students.map(st => ({
    studentId: st.id, studentName: st.name,
    text: submissionText(submissionFor(st.id)) || '',
    hasAiCitation: submissionFor(st.id)?._hasAiCitation || false,
  }));

  const overlay = document.getElementById('grade-progress-overlay');
  const label   = document.getElementById('progress-label');
  const fill    = document.getElementById('progress-fill');
  const sub     = document.getElementById('progress-sub');
  overlay.classList.remove('hidden');

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
      decoder.decode(value, { stream: true }).split('\n').forEach(line => {
        if (!line.startsWith('data: ')) return;
        const msg = JSON.parse(line.slice(6));
        if (msg.type === 'progress' || msg.type === 'error') {
          const pct = Math.round((msg.completed / msg.total) * 100);
          fill.style.width = pct + '%';
          label.textContent = `Grading ${msg.completed} / ${msg.total}`;
          sub.textContent = msg.studentName || '';
          if (msg.type === 'progress') applyAiGrade(msg.studentId, msg.grade, msg.aiDetection, msg.flagged);
        }
        if (msg.type === 'complete') {
          label.textContent = `Done! ${msg.total} students graded.`;
          toast(`Graded ${msg.total} submissions.`, 'success');
        }
      });
    }

    // Persist all
    await Promise.all(allStudents().map(st => S.grades[st.id] ? saveGrade(st.id) : Promise.resolve()));
    S.allGrades[String(S.currentAssignment?.id)] = { ...S.grades };
    renderSidebar();
    showView('assignment');

  } catch (e) {
    toast('Grading error: ' + e.message, 'error');
  } finally {
    setTimeout(() => overlay.classList.add('hidden'), 2500);
  }
}

function applyAiGrade(studentId, grade, aiDetection, flagged) {
  if (!S.rubric) return;
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

/* ── Student Modal ───────────────────────────────────────────────────────────── */
let modalStudentId = null;

function openStudent(studentId) {
  modalStudentId = studentId;
  const st  = allStudents().find(s => s.id === studentId);
  const sub = submissionFor(studentId);
  const g   = S.grades[studentId];

  document.getElementById('modal-student-name').textContent = st?.name || studentId;
  const meta = [sub?.late && 'LATE', g?.flagged && '⚑ AI Flagged', g?.status?.replace('_', ' ').toUpperCase()].filter(Boolean);
  document.getElementById('modal-student-meta').textContent = meta.join(' · ');
  document.getElementById('modal-submission-text').textContent = submissionText(sub) || '(No submission text)';

  const flagBanner = document.getElementById('modal-ai-flag');
  if (g?.flagged) {
    flagBanner.style.display = 'block';
    const signals = (g.aiSignals || []).slice(0, 3);
    flagBanner.innerHTML = `<strong>⚑ ${g.aiConfidence || 0}% AI confidence</strong>${signals.length ? '<br>Signals: ' + signals.map(s => `<em>"${esc(s)}"</em>`).join(', ') : ''}`;
  } else {
    flagBanner.style.display = 'none';
  }

  renderModalCriteria(studentId);
  renderModalTotals(studentId);

  document.getElementById('modal-notes').value = g?.notes || '';

  const fbBox  = document.getElementById('modal-ai-feedback');
  const fbText = document.getElementById('modal-ai-feedback-text');
  if (g?.aiOverallFeedback) { fbBox.style.display = 'block'; fbText.textContent = g.aiOverallFeedback; }
  else fbBox.style.display = 'none';

  document.getElementById('modal-backdrop').classList.remove('hidden');
}

function renderModalCriteria(studentId) {
  const wrap = document.getElementById('modal-criteria-scores');
  const g = S.grades[studentId];
  if (!S.rubric) { wrap.innerHTML = '<p class="muted">No rubric.</p>'; return; }

  wrap.innerHTML = S.rubric.criteria.map(c => {
    const cd  = g?.criteria?.[c.id] || {};
    const aiS = cd.aiScore    != null ? cd.aiScore    : '—';
    const marV = cd.marcoScore != null ? cd.marcoScore : '';
    const mrlV = cd.marlowScore != null ? cd.marlowScore : '';
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
        <div class="crit-score-lbl score-lbl-m1">Marco</div>
        <input class="crit-score-input" type="number" min="0" max="${c.maxPoints}"
          placeholder="${aiS}" value="${marV}"
          data-criterion="${esc(c.id)}" data-max="${c.maxPoints}" data-grader="marco"
          onchange="onModalScoreChange(this)" />
      </div>
      <div class="crit-score-col">
        <div class="crit-score-lbl score-lbl-m2">Marlowe</div>
        <input class="crit-score-input crit-score-m2" type="number" min="0" max="${c.maxPoints}"
          placeholder="${marV || aiS}" value="${mrlV}"
          data-criterion="${esc(c.id)}" data-max="${c.maxPoints}" data-grader="marlowe"
          onchange="onModalScoreChange(this)" />
      </div>
    </div>`;
  }).join('');
}

function renderModalTotals(studentId) {
  const g = S.grades[studentId];
  document.getElementById('modal-score-totals').innerHTML = `
    <div>AI: <strong>${g?.aiTotalScore ?? '—'}</strong></div>
    <div>Marco: <strong>${g?.marcoTotalScore ?? '—'}</strong></div>
    <div>Marlowe: <strong>${g?.marloweTotalScore ?? '—'}</strong></div>
    <div class="final-score">Final: <strong>${g?.finalScore ?? '—'}</strong></div>`;
}

function onModalScoreChange(input) {
  if (!modalStudentId) return;
  const criterionId = input.dataset.criterion;
  const max    = Number(input.dataset.max);
  const grader = input.dataset.grader;
  let val = input.value.trim() === '' ? null : Number(input.value);
  if (val !== null) val = Math.max(0, Math.min(max, val));

  if (!S.grades[modalStudentId]) S.grades[modalStudentId] = buildEmptyGrade(modalStudentId);
  if (!S.grades[modalStudentId].criteria[criterionId]) S.grades[modalStudentId].criteria[criterionId] = {};
  if (grader === 'marlowe') S.grades[modalStudentId].criteria[criterionId].marlowScore = val;
  else                       S.grades[modalStudentId].criteria[criterionId].marcoScore  = val;

  recalcTotals(modalStudentId);
  renderModalTotals(modalStudentId);
}

document.getElementById('modal-save').addEventListener('click', async () => {
  if (!modalStudentId) return;
  if (!S.grades[modalStudentId]) S.grades[modalStudentId] = buildEmptyGrade(modalStudentId);
  S.grades[modalStudentId].notes = document.getElementById('modal-notes').value;
  S.grades[modalStudentId].status = 'reviewed';
  await saveGrade(modalStudentId);
  toast('Saved!', 'success');
  closeModal();
  showView('assignment');
});

document.getElementById('modal-grade-ai').addEventListener('click', async () => {
  if (!modalStudentId || !S.rubric) return;
  if (!S.health?.claude) { toast('Claude not configured.', 'error'); return; }
  const st  = allStudents().find(s => s.id === modalStudentId);
  const sub = submissionFor(modalStudentId);
  const btn = document.getElementById('modal-grade-ai');
  btn.disabled = true; btn.textContent = '⏳ Grading…';
  try {
    const res = await POST('/api/grade/single', {
      text: submissionText(sub) || '', rubric: S.rubric,
      studentName: st?.name || modalStudentId,
      hasAiCitation: sub?._hasAiCitation || false,
      aiInstructions: S.aiInstructions,
    });
    applyAiGrade(modalStudentId, res.grade, res.aiDetection, res.flagged);
    renderModalCriteria(modalStudentId);
    renderModalTotals(modalStudentId);
    const g = S.grades[modalStudentId];
    if (g?.aiOverallFeedback) {
      document.getElementById('modal-ai-feedback').style.display = 'block';
      document.getElementById('modal-ai-feedback-text').textContent = g.aiOverallFeedback;
    }
    toast('Re-graded!', 'success');
  } catch (e) { toast('Grading error: ' + e.message, 'error'); }
  finally { btn.disabled = false; btn.textContent = '⟳ Re-grade with AI'; }
});

document.getElementById('modal-close').addEventListener('click', closeModal);
document.getElementById('modal-backdrop').addEventListener('click', e => {
  if (e.target === document.getElementById('modal-backdrop')) closeModal();
});
function closeModal() {
  document.getElementById('modal-backdrop').classList.add('hidden');
  modalStudentId = null;
}

/* ── Quiz View ───────────────────────────────────────────────────────────────── */
// Each question stored as: { question: "...", answer: "...", choices: ["A)...","B)..."] }
// or plain string for backwards compat

function qText(q)   { return typeof q === 'string' ? q : (q.question || ''); }
function qAnswer(q) { return typeof q === 'string' ? '' : (q.answer || ''); }
function qChoices(q){ return typeof q === 'string' ? [] : (q.choices || []); }

// Show/hide answer for a question row
function toggleAnswer(i) {
  const el = document.getElementById(`q-answer-${i}`);
  if (el) el.style.display = el.style.display === 'none' ? 'block' : 'none';
}

function renderQuizView(root) {
  root = root || document.getElementById('view-root');
  const qs = S.quizBank?.questions || [];

  const bankHtml = qs.length ? qs.map((q, i) => {
    const text    = qText(q);
    const answer  = qAnswer(q);
    const choices = qChoices(q);
    return `<div class="quiz-q-item">
      <span class="quiz-q-num">${i + 1}.</span>
      <div style="flex:1">
        <div class="quiz-q-text">${esc(text)}</div>
        ${choices.length ? `<div class="quiz-choices">${choices.map(c => `<div class="quiz-choice">${esc(c)}</div>`).join('')}</div>` : ''}
        ${answer ? `
          <button class="btn btn-surf-sec" style="font-size:11px;padding:2px 8px;margin-top:4px" onclick="toggleAnswer(${i})">Show / Hide Answer</button>
          <div id="q-answer-${i}" class="quiz-answer" style="display:none"><strong>Answer:</strong> ${esc(answer)}</div>
        ` : ''}
      </div>
      <button class="btn btn-surf-sec" style="font-size:11px;padding:3px 8px;flex-shrink:0" onclick="deleteQuestion(${i})">✕</button>
    </div>`;
  }).join('') : '<p class="muted">No questions yet. Upload a test bank to get started.</p>';

  root.innerHTML = `
    <div class="page-title">Quiz Question Bank
      <div class="page-actions">
        <button class="btn btn-secondary" onclick="document.getElementById('quiz-file-input').click()">⬆ Upload Test Bank</button>
        <input id="quiz-file-input" type="file" accept=".txt,.csv,.json,.md" style="display:none" onchange="uploadQuizFile(this)" />
        <button class="btn btn-ghost btn-danger" onclick="clearQuizBank()">Clear Bank</button>
      </div>
    </div>

    <!-- Upload format hint -->
    <div class="card" style="padding:12px 18px;margin-bottom:12px;background:#f8f9ff">
      <div class="card-title" style="margin-bottom:6px">Accepted file formats</div>
      <div style="font-size:12px;color:var(--text-muted);line-height:1.8">
        <strong>Plain text (.txt)</strong> — one question per line. Add answer on next line starting with <code>ANSWER:</code><br>
        <strong>JSON (.json)</strong> — array of <code>[{"question":"...","answer":"...","choices":["A) ...","B) ..."]}]</code><br>
        <strong>Q&amp;A format</strong> — lines starting with <code>Q:</code> are questions, <code>A:</code> are answers, <code>a)</code>–<code>d)</code> are choices
      </div>
    </div>

    <!-- Create Quiz on Canvas -->
    <div class="card create-quiz-card">
      <div class="card-title">
        🎓 Create Quiz on Canvas
        <span class="card-title-hint">Builds a real Canvas quiz from selected questions in your bank</span>
      </div>
      <div class="create-quiz-grid">
        <div class="field-group">
          <label>Quiz Title</label>
          <input id="cq-title" type="text" class="input" placeholder="e.g. Quiz – Chapters 2–3" />
        </div>
        <div class="field-group">
          <label>Time Limit (min, blank = none)</label>
          <input id="cq-time" type="number" class="input" min="1" placeholder="20" />
        </div>
        <div class="field-group">
          <label>Allowed Attempts</label>
          <input id="cq-attempts" type="number" class="input" value="1" min="1" />
        </div>
        <div class="field-group">
          <label>Points per question</label>
          <input id="cq-pts" type="number" class="input" value="1" min="1" />
        </div>
      </div>
      <div class="field-group">
        <label>Description (optional)</label>
        <textarea id="cq-desc" class="input" rows="2" placeholder="Instructions for students…"></textarea>
      </div>

      <!-- Question selector -->
      <div class="field-group">
        <label>Select questions to include
          <button class="btn btn-surf-sec" style="font-size:11px;padding:2px 8px;margin-left:8px" onclick="selectAllQuizQs(true)">All</button>
          <button class="btn btn-surf-sec" style="font-size:11px;padding:2px 8px" onclick="selectAllQuizQs(false)">None</button>
        </label>
        <div id="cq-selector" class="cq-selector">
          ${qs.length
            ? qs.map((q, i) => `<label class="cq-q-label">
                <input type="checkbox" class="cq-q-check" data-idx="${i}" checked />
                <span class="cq-q-preview">${esc(qText(q).substring(0, 80))}${qText(q).length > 80 ? '…' : ''}</span>
              </label>`).join('')
            : '<p class="muted" style="padding:8px">No questions in bank yet.</p>'}
        </div>
      </div>

      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:8px">
        <button class="btn btn-surf" onclick="createCanvasQuiz(false)">Create as Draft</button>
        <button class="btn btn-primary" onclick="createCanvasQuiz(true)">Create &amp; Publish</button>
        <span id="cq-status" class="muted" style="font-size:12px"></span>
      </div>
      <div id="cq-result" style="display:none;margin-top:12px" class="quiz-result-banner"></div>
    </div>

    <div class="two-col-grid">
      <div class="card">
        <div class="card-title">Suggest Questions with AI</div>
        <div class="field-group">
          <label>Topic / Focus</label>
          <input id="quiz-topic" type="text" class="input" placeholder="e.g. Customer segmentation and targeting" />
        </div>
        <div class="field-group">
          <label># of questions</label>
          <input id="quiz-count" type="number" class="input" value="5" min="1" max="20" style="max-width:80px" />
        </div>
        <div class="field-group">
          <label>Course content context (optional)</label>
          <textarea id="quiz-context" class="input" rows="3" placeholder="Paste lecture notes, slides summary, or video topics…"></textarea>
        </div>
        <button class="btn btn-surf" onclick="suggestQuizQuestions()">✦ Suggest Questions</button>
      </div>

      <div class="card">
        <div class="card-title">Bank <span class="card-title-hint">${qs.length} question${qs.length !== 1 ? 's' : ''}</span></div>
        <div id="quiz-bank-list" style="max-height:420px;overflow-y:auto">${bankHtml}</div>
      </div>
    </div>

    <div id="quiz-suggestions-wrap" style="display:none" class="card">
      <div class="card-title">AI Suggested Questions</div>
      <div id="quiz-suggestions"></div>
    </div>`;
}

function selectAllQuizQs(checked) {
  document.querySelectorAll('.cq-q-check').forEach(cb => cb.checked = checked);
}

async function createCanvasQuiz(publish) {
  if (!S.course) { toast('Select a course first.', 'warn'); return; }

  const title    = document.getElementById('cq-title')?.value?.trim();
  const desc     = document.getElementById('cq-desc')?.value?.trim();
  const timeLimit = Number(document.getElementById('cq-time')?.value) || null;
  const attempts  = Number(document.getElementById('cq-attempts')?.value) || 1;
  const ptsEach   = Number(document.getElementById('cq-pts')?.value) || 1;

  if (!title) { toast('Enter a quiz title.', 'warn'); return; }

  // Collect selected questions
  const checked = [...document.querySelectorAll('.cq-q-check:checked')];
  if (!checked.length) { toast('Select at least one question.', 'warn'); return; }
  const selected = checked.map(cb => {
    const q = S.quizBank.questions[Number(cb.dataset.idx)];
    return typeof q === 'string' ? { question: q, answer: '', choices: [], points: ptsEach }
                                 : { ...q, points: ptsEach };
  });

  const statusEl  = document.getElementById('cq-status');
  const resultEl  = document.getElementById('cq-result');
  const btn1 = document.querySelector('[onclick="createCanvasQuiz(false)"]');
  const btn2 = document.querySelector('[onclick="createCanvasQuiz(true)"]');
  if (statusEl) statusEl.textContent = `Creating quiz with ${selected.length} questions…`;
  if (btn1) btn1.disabled = true;
  if (btn2) btn2.disabled = true;

  try {
    const res = await POST(`/api/canvas/create-quiz/${S.course.id}`, {
      title, description: desc, timeLimit, allowedAttempts: attempts,
      pointsPossible: selected.length * ptsEach,
      questions: selected, publish,
    });

    if (resultEl) {
      resultEl.style.display = 'block';
      resultEl.className = 'quiz-result-banner quiz-result-success';
      resultEl.innerHTML = `
        ✓ Quiz created on Canvas with ${res.questionsAdded} questions.
        ${publish ? ' <strong>Published!</strong>' : ' Saved as draft.'}<br>
        <a href="${esc(res.quizUrl)}" target="_blank" class="quiz-result-link">
          Open in Canvas ↗
        </a>`;
    }
    if (statusEl) statusEl.textContent = '';
    toast(`Quiz "${title}" created on Canvas!`, 'success');
  } catch (e) {
    if (resultEl) {
      resultEl.style.display = 'block';
      resultEl.className = 'quiz-result-banner quiz-result-error';
      resultEl.textContent = 'Error: ' + e.message;
    }
    toast('Failed: ' + e.message, 'error');
  } finally {
    if (btn1) btn1.disabled = false;
    if (btn2) btn2.disabled = false;
  }
}

/* Parse uploaded test bank file into structured question objects */
function parseQuizFile(text) {
  // Try JSON first
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed.map(q =>
      typeof q === 'string' ? { question: q, answer: '', choices: [] } : q
    );
  } catch { /* not JSON */ }

  const questions = [];
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  let current = null;

  for (const line of lines) {
    const qMatch  = line.match(/^(?:Q:|Question:|\d+[\.\)])\s*(.+)/i);
    const aMatch  = line.match(/^(?:A:|Answer:|Correct:)\s*(.+)/i);
    const choiceMatch = line.match(/^([a-dA-D][\.\)])\s*(.+)/);

    if (qMatch) {
      if (current) questions.push(current);
      current = { question: qMatch[1].trim(), answer: '', choices: [] };
    } else if (aMatch && current) {
      current.answer = aMatch[1].trim();
    } else if (choiceMatch && current) {
      current.choices.push(choiceMatch[0].trim());
    } else if (line.length > 10 && !current) {
      // plain line with no prefix = just a question
      questions.push({ question: line, answer: '', choices: [] });
    } else if (line.match(/^ANSWER:\s*/i) && current) {
      current.answer = line.replace(/^ANSWER:\s*/i, '').trim();
    }
  }
  if (current) questions.push(current);
  return questions.filter(q => q.question.length > 3);
}

async function uploadQuizFile(input) {
  const file = input.files[0]; if (!file) return;
  const fd = new FormData(); fd.append('file', file);
  try {
    const resp = await fetch('/api/quiz-bank/upload', { method: 'POST', body: fd });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error);

    const parsed = parseQuizFile(data.text);
    S.quizBank.questions = [...(S.quizBank.questions || []), ...parsed];
    await PUT('/api/quiz-bank', S.quizBank);
    const withAnswers = parsed.filter(q => q.answer).length;
    toast(`Imported ${parsed.length} questions (${withAnswers} with answers).`, 'success');
    showView('quiz');
  } catch (e) { toast('Upload failed: ' + e.message, 'error'); }
  input.value = '';
}

async function clearQuizBank() {
  if (!confirm('Clear the entire question bank?')) return;
  await DEL('/api/quiz-bank');
  S.quizBank = { questions: [] };
  showView('quiz');
}

async function deleteQuestion(index) {
  S.quizBank.questions.splice(index, 1);
  await PUT('/api/quiz-bank', S.quizBank);
  showView('quiz');
}

async function suggestQuizQuestions() {
  if (!S.health?.claude) { toast('Claude not configured.', 'error'); return; }
  const topic   = document.getElementById('quiz-topic')?.value?.trim();
  const count   = Number(document.getElementById('quiz-count')?.value) || 5;
  const context = document.getElementById('quiz-context')?.value?.trim();
  toast('Thinking…');
  try {
    const result = await POST('/api/quiz-bank/suggest', { topic, courseContent: context, count });
    const wrap = document.getElementById('quiz-suggestions-wrap');
    const inner = document.getElementById('quiz-suggestions');
    wrap.style.display = 'block';
    inner.innerHTML = (result.selectedQuestions || []).map((q, i) =>
      `<div class="quiz-suggestion-item">
        <span class="quiz-source-badge ${q.source === 'suggested' ? 'badge-suggested' : 'badge-bank'}">${q.source === 'suggested' ? '✦ AI Suggested' : `Bank #${(q.originalIndex || 0) + 1}`}</span>
        <div class="quiz-q-body">${esc(q.question)}</div>
        <div class="quiz-q-rationale muted">${esc(q.rationale || '')}</div>
        ${q.source === 'suggested' ? `<button class="btn btn-surf-sec" style="font-size:11px;padding:3px 8px;margin-top:4px" onclick="addSuggestedQ('${esc(q.question.replace(/'/g, "\\'"))}')">+ Add to Bank</button>` : ''}
      </div>`
    ).join('');
    if (result.notes) inner.innerHTML = `<p class="muted" style="font-style:italic;margin-bottom:12px">${esc(result.notes)}</p>` + inner.innerHTML;
    toast('Done!', 'success');
  } catch (e) { toast('Failed: ' + e.message, 'error'); }
}

async function addSuggestedQ(q) {
  S.quizBank.questions.push(q);
  await PUT('/api/quiz-bank', S.quizBank);
  toast('Added to bank.', 'success');
  showView('quiz');
}

/* ── Course Content View ─────────────────────────────────────────────────────── */
const PANOPTO_TOOL_URL = 'https://canvas.uw.edu/courses/1901907/external_tools/21130';

function renderContentView(root) {
  root = root || document.getElementById('view-root');
  const courseId = S.course?.id || '1901907';
  const panoptoUrl = `https://canvas.uw.edu/courses/${courseId}/external_tools/21130`;

  root.innerHTML = `
    <div class="page-title">Course Content &amp; Videos
      <div class="page-actions">
        <button class="btn btn-secondary" onclick="loadCourseContent()">⟳ Load Modules &amp; Pages</button>
      </div>
    </div>

    <!-- Panopto Video Attendance -->
    <div class="card">
      <div class="card-title">
        ▶ Panopto — Video Attendance &amp; Analytics
        <span class="card-title-hint">Shows who watched what, completion %, and engagement stats</span>
        <div style="margin-left:auto;display:flex;gap:8px">
          <button class="btn btn-surf" style="font-size:12px;padding:4px 12px"
            onclick="togglePanopto()">Open / Close Panopto</button>
          <a href="${esc(panoptoUrl)}" target="_blank" class="btn btn-ghost" style="font-size:12px;padding:4px 12px">
            Open in Canvas ↗
          </a>
        </div>
      </div>
      <div id="panopto-container" style="display:none">
        <div class="panopto-note">
          <strong>Note:</strong> Panopto is embedded below via Canvas. You must be logged into Canvas in your browser.
          Look for the <strong>Stats / Analytics</strong> tab inside Panopto to see per-student video viewing data.
        </div>
        <iframe
          id="panopto-frame"
          src="${esc(panoptoUrl)}"
          width="100%" height="680"
          style="border:1px solid var(--border);border-radius:var(--radius);margin-top:10px"
          allow="fullscreen"
          title="Panopto Video Attendance">
        </iframe>
      </div>
      <div id="panopto-closed" class="panopto-hint">
        Click <strong>Open / Close Panopto</strong> to embed the Panopto video tool here, or
        <a href="${esc(panoptoUrl)}" target="_blank">open it in Canvas directly ↗</a>.
        Inside Panopto, go to a video → <strong>Stats</strong> to see per-student viewing completion.
      </div>
    </div>

    <div class="two-col-grid">
      <div class="card">
        <div class="card-title">Course Modules</div>
        <div id="content-modules"><p class="muted">Click Load Modules &amp; Pages.</p></div>
      </div>
      <div class="card">
        <div class="card-title">Pages</div>
        <div id="content-pages"><p class="muted">Click Load Modules &amp; Pages.</p></div>
      </div>
    </div>
    <div class="card"><div class="card-title">Page Viewer</div><div id="content-viewer"><p class="muted">Click a page to view.</p></div></div>`;
}

function togglePanopto() {
  const container = document.getElementById('panopto-container');
  const hint      = document.getElementById('panopto-closed');
  if (!container) return;
  const isOpen = container.style.display !== 'none';
  container.style.display = isOpen ? 'none' : 'block';
  if (hint) hint.style.display = isOpen ? 'block' : 'none';
}

async function loadCourseContent() {
  if (!S.course) { toast('Select a course first.', 'warn'); return; }
  toast('Loading…');
  try {
    const [modules, pages] = await Promise.all([
      GET(`/api/courses/${S.course.id}/modules`).catch(() => []),
      GET(`/api/courses/${S.course.id}/pages`).catch(() => []),
    ]);
    const mWrap = document.getElementById('content-modules');
    const pWrap = document.getElementById('content-pages');
    if (mWrap) mWrap.innerHTML = modules.length ? modules.map(m => `
      <div class="module-block">
        <div class="module-title">${esc(m.name)} <span class="muted">(${(m.items||[]).length} items)</span></div>
        <ul class="module-items">${(m.items||[]).map(item => {
          const icon = {ExternalUrl:'🔗',File:'📄',Page:'📝',Quiz:'❓',Assignment:'✏'}[item.type] || '▸';
          const link = item.external_url || item.html_url || '#';
          return `<li class="module-item">${icon} <a href="${esc(link)}" target="_blank">${esc(item.title)}</a> <span class="muted" style="font-size:10px">${item.type||''}</span></li>`;
        }).join('')}</ul>
      </div>`).join('') : '<p class="muted">No modules.</p>';
    if (pWrap) pWrap.innerHTML = pages.length ? `<ul class="page-list">${pages.map(p =>
      `<li><button class="link-btn" onclick="viewPage('${esc(p.url)}')">${esc(p.title)}</button></li>`
    ).join('')}</ul>` : '<p class="muted">No pages.</p>';
    toast('Loaded.', 'success');
  } catch (e) { toast('Error: ' + e.message, 'error'); }
}

async function viewPage(url) {
  const wrap = document.getElementById('content-viewer');
  if (!wrap || !S.course) return;
  wrap.innerHTML = '<p class="muted">Loading…</p>';
  try {
    const page = await GET(`/api/courses/${S.course.id}/pages/${encodeURIComponent(url)}`);
    wrap.innerHTML = `<div class="page-title-sm">${esc(page.title)}</div><div class="page-content">${page.body || '(No content)'}</div>`;
  } catch (e) { wrap.innerHTML = `<p class="muted">Failed: ${esc(e.message)}</p>`; }
}

/* ── Manual Entry View ───────────────────────────────────────────────────────── */
function renderManualView(root) {
  root = root || document.getElementById('view-root');
  root.innerHTML = `
    <div class="page-title">Add Student Manually</div>
    <div class="card" style="max-width:600px">
      <div class="field-group"><label>Student Name</label><input id="manual-name" type="text" class="input" placeholder="First Last" /></div>
      <div class="field-group"><label>Student ID (optional)</label><input id="manual-id" type="text" class="input" placeholder="e.g. 2034567" /></div>
      <div class="field-group"><label>Paste Submission Text</label><textarea id="manual-text" class="input" rows="10" placeholder="Paste the student's submission here…"></textarea></div>
      <div class="field-row">
        <label class="checkbox-label"><input id="manual-late" type="checkbox" /> Late submission</label>
        <label class="checkbox-label"><input id="manual-ai-cite" type="checkbox" /> Student disclosed AI use</label>
      </div>
      <div class="card-actions">
        <button class="btn btn-primary" onclick="addManualStudent(true)">Add &amp; Grade with AI</button>
        <button class="btn btn-secondary" onclick="addManualStudent(false)">Add Without Grading</button>
      </div>
    </div>`;
}

async function addManualStudent(gradeNow) {
  const name = document.getElementById('manual-name')?.value?.trim();
  const id   = document.getElementById('manual-id')?.value?.trim() || `manual_${Date.now()}`;
  const text = document.getElementById('manual-text')?.value?.trim();
  const isLate = document.getElementById('manual-late')?.checked;
  const hasAiCitation = document.getElementById('manual-ai-cite')?.checked;
  if (!name) { toast('Enter a student name.', 'warn'); return; }
  S.manualStudents.push({ id, name });
  S.submissions.push({ user_id: id, workflow_state: text ? 'submitted' : 'unsubmitted', body: text, late: isLate, _manualText: text, _hasAiCitation: hasAiCitation });
  toast(`Added ${name}.`, 'success');
  if (gradeNow && S.rubric && text && S.health?.claude) {
    try {
      const res = await POST('/api/grade/single', { text, rubric: S.rubric, studentName: name, hasAiCitation, aiInstructions: S.aiInstructions });
      applyAiGrade(id, res.grade, res.aiDetection, res.flagged);
      await saveGrade(id);
      toast(`${name} graded!`, 'success');
    } catch (e) { toast('Grading failed: ' + e.message, 'error'); }
  }
  renderManualView();
}

/* ── Export ─────────────────────────────────────────────────────────────────── */
document.getElementById('btn-export').addEventListener('click', () => {
  if (!S.course || !S.currentAssignment) { toast('Open an assignment first.', 'warn'); return; }
  window.location.href = `/api/grades/${S.course.id}/${S.currentAssignment.id}/export.csv`;
});

/* ── Helpers ─────────────────────────────────────────────────────────────────── */
function allStudents() {
  const canvas = S.students.map(e => ({
    id: String(e.user_id || e.user?.id || e.id),
    name: e.user?.name || e.user?.sortable_name || `Student ${e.user_id}`,
    source: 'canvas',
  }));
  const manual = S.manualStudents.map(s => ({ ...s, source: 'manual' }));
  const seen = new Set();
  return [...canvas, ...manual].filter(s => { if (seen.has(s.id)) return false; seen.add(s.id); return true; });
}

function submissionFor(studentId) {
  return S.submissions.find(s => String(s.user_id) === String(studentId)) || null;
}

function submissionText(sub) {
  if (!sub) return '';
  return sub._manualText || sub.body || '';
}

function buildEmptyGrade(studentId) {
  const st  = allStudents().find(s => s.id === studentId);
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

async function saveGrade(studentId) {
  if (!S.course || !S.currentAssignment) return;
  try {
    await PUT(`/api/grades/${S.course.id}/${S.currentAssignment.id}/${studentId}`, S.grades[studentId]);
  } catch (e) { toast('Save failed: ' + e.message, 'error'); }
}

/* ── Auth ────────────────────────────────────────────────────────────────────── */
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

/* ── Boot ────────────────────────────────────────────────────────────────────── */
loadCurrentUser().then(() => init()).catch(console.error);
