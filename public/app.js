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
  assignmentText: '',
  manualStudents: [],
  quizBank: { questions: [] },
  syllabus: [],
  teams: {},          // studentId → { team: number }
  teamMeta: {},       // teamNum → { name, memberNames }
  dismissed: new Set(), // assignment IDs dismissed from "Needs Grading"
  allStudentsList: [], // all students for course (for grade book)
  me: null,           // current logged-in user { username, role }
};

const DEFAULT_COURSE_NAME = 'B BUS 464';

/* ── API helpers ────────────────────────────────────────────────────────────── */
async function api(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(path, opts);
  if (r.status === 401) { window.location.href = '/login.html'; throw new Error('Session expired — redirecting to login'); }
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
  // Check health + current user
  try { S.health = await GET('/api/health'); renderStatusBadges(); } catch { }
  try { S.me = await GET('/api/me'); } catch { S.me = { username: 'unknown' }; }

  // Load quiz bank + syllabus
  try { S.quizBank = await GET('/api/quiz-bank'); } catch { S.quizBank = { questions: [] }; }
  try { S.syllabus = await GET('/api/syllabus'); } catch { S.syllabus = []; }
  if (S.health?.canvas) {
    try { S.teams = await GET(`/api/teams/global`); } catch { S.teams = {}; }
  }

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
  if (!el) return;
  const c  = S.health?.canvas ? '<span class="badge badge--green">Canvas ✓</span>' : '<span class="badge badge--red">Canvas ✗</span>';
  const ai = S.health?.claude ? '<span class="badge badge--green">Claude ✓</span>'  : '<span class="badge badge--red">Claude ✗</span>';
  el.innerHTML = c + ai;
}

// Poll health every 60 s so badges go red if a service drops mid-session
setInterval(async () => {
  try {
    const h = await fetch('/api/health').then(r => r.json());
    const changed = h.canvas !== S.health?.canvas || h.claude !== S.health?.claude;
    S.health = h;
    if (changed) renderStatusBadges();
  } catch { /* ignore network errors */ }
}, 60_000);

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
    const [assignments, allGradesRaw, teamsRaw, teamMetaRaw, students, dismissedArr] = await Promise.all([
      GET(`/api/courses/${S.course.id}/assignments`),
      GET(`/api/grades/${S.course.id}/all`).catch(() => ({})),
      GET(`/api/teams/${S.course.id}`).catch(() => ({})),
      GET(`/api/team-meta/${S.course.id}`).catch(() => ({})),
      GET(`/api/courses/${S.course.id}/students`).catch(() => []),
      GET(`/api/dismissed/${S.course.id}`).catch(() => []),
    ]);
    S.assignments     = assignments;
    S.allGrades       = allGradesRaw;
    S.teamMeta        = teamMetaRaw;
    S.allStudentsList = students;
    S.dismissed       = new Set(dismissedArr.map(String));

    // Auto-seed student→team mapping by name if mostly unset
    const assignedCount = Object.keys(teamsRaw).length;
    if (assignedCount < students.length * 0.5 && students.length && Object.keys(teamMetaRaw).length) {
      const seeded = { ...teamsRaw };
      students.forEach(st => {
        if (seeded[st.id]) return;
        const normSt = normName(st.name);
        for (const [tNum, tData] of Object.entries(teamMetaRaw)) {
          if ((tData.memberNames || []).some(mn => {
            const normMn = normName(mn);
            return normSt.includes(normMn) || normMn.includes(normSt) ||
                   normSt.split(' ')[0] === normMn.split(' ')[0] && normSt.split(' ').slice(-1)[0] === normMn.split(' ').slice(-1)[0];
          })) {
            seeded[st.id] = { team: Number(tNum) };
            break;
          }
        }
      });
      S.teams = seeded;
      PUT(`/api/teams/${S.course.id}`, seeded).catch(() => {});
    } else {
      S.teams = teamsRaw;
    }

    groupAssignments();
    renderSidebar();
    showView('overview');
    toast('Course loaded.', 'success');

    // Enable Sync Canvas button now that course is loaded
    const syncBtn = document.getElementById('btn-sync-canvas');
    if (syncBtn) syncBtn.disabled = false;

    // Auto-sync Canvas grades silently in background
    syncCanvasGrades(true);
  } catch (e) { toast('Load error: ' + e.message, 'error'); }
}

function normName(n) {
  return (n || '').replace(/\s*\(.*?\)/g, '').trim().toLowerCase();
}

/* ── Assignment grouping ─────────────────────────────────────────────────────── */
// Maps Canvas assignment name patterns → display group (matches syllabus exactly)
const GROUP_RULES = [
  // RECORDED LECTURES — must come before Quizzes so "Week 9 Quiz" / chapter videos aren't misclassified
  { key: 'Recorded Lectures', patterns: [
    /recorded lecture/i,
    /week \d.*chapter/i,
    /chapter.*week \d/i,
    /lecture.*week/i,
    /week \d.*lecture/i,
    /week 9/i,
  ]},
  // QUIZZES — "Quiz – Chapters X–Y" style
  { key: 'Quizzes', patterns: [
    /quiz/i,
    /chapter \d{1,2}[-–]\d{1,2}/i,
    /chapters? 15/i,
    /chapters? 16/i,
  ]},
  // AI ASSIGNMENTS — in-class AI exercises and demos (before Activities to avoid overlap)
  { key: 'AI Assignments', patterns: [
    /ai.*slide/i,
    /slide creation/i,
    /ai.*blog/i,
    /blog.*ai/i,
    /blog writing/i,
    /ai.*exercise/i,
    /ai.*agent/i,
    /ai.*demo/i,
    /copilot.*exercise/i,
    /ai.*tool/i,
    /ai.*video/i,
    /video.*ai/i,
    /template.*example/i,
    /example.*template/i,
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
    /crossing the chasm/i,   // essay OR discussion
    /chasm/i,
  ]},
  // ACTIVITIES — simulations, workshops, presentations
  { key: 'Activities', patterns: [
    /simulation/i,
    /workshop/i,
    /exercise/i,
    /food truck/i,
    /persona/i,
    /positioning.*(map|sim)/i,
    /product of the week/i,
    /atar/i,
    /launch management/i,
    /minimum viable/i,
    /jobs to be done/i,
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
  'AI Assignments':     '✦',
  'Case Discussions':   '📋',
  'Activities':         '✏',
  'Group Project':      '◈',
  'Participation':      '✦',
  'Final Exam':         '★',
  'Recorded Lectures':  '▶',
  'Other Assignments':  '◉',
};

// Sidebar display order matches syllabus
const GROUP_ORDER = ['Quizzes', 'AI Assignments', 'Case Discussions', 'Activities', 'Group Project', 'Participation', 'Final Exam', 'Recorded Lectures', 'Other Assignments'];

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
  S.assignmentText = '';
  _oboExtracted = false;
  oboIndex = 0;

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
    if (enrollments.length > S.allStudentsList.length) S.allStudentsList = enrollments;
    S.submissions = subs;
    S.grades = grades;
    S.aiInstructions = settings.aiInstructions || '';
    S.assignmentText = settings.assignmentText || '';
    if (savedRubric) S.rubric = savedRubric;
    else S.rubric = defaultRubricForAssignment(S.currentAssignment);

    // Merge Canvas scores: if a submission has a score and our grade lacks a finalScore, import it
    subs.forEach(sub => {
      const sid = String(sub.user_id);
      if (sub.score != null && !S.grades[sid]) {
        S.grades[sid] = { status: 'canvas', canvasScore: sub.score, finalScore: sub.score, studentName: sub.user?.name || sid };
      } else if (sub.score != null && S.grades[sid]) {
        S.grades[sid].canvasScore = sub.score;
      }
    });

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
  const pts   = a.points_possible || 10;
  const mk    = (id, name, maxPoints, description, autoGrant = false) => ({ id, name, maxPoints, description, autoGrant });

  if (group === 'Recorded Lectures') {
    return { name: a.name, totalPoints: pts, criteria: [
      mk('c1', 'Lecture Viewed', pts, 'Student has watched all required lecture videos.', false),
    ]};
  }
  if (group === 'Quizzes') {
    return { name: a.name, totalPoints: pts, criteria: [
      mk('c1', 'Quiz Score', pts, 'Automatically graded quiz score from Canvas.', false),
    ]};
  }
  if (group === 'Case Discussions') {
    return { name: a.name, totalPoints: pts, description: '', criteria: [
      mk('c1', 'Submission',                        Math.round(pts * 0.20), 'Student submitted a complete write-up.', true),
      mk('c2', 'Executive Summary & Recommendations', Math.round(pts * 0.33), 'Clear executive summary with specific, actionable recommendations upfront.'),
      mk('c3', 'Supporting Points & Evidence',        Math.round(pts * 0.27), 'Recommendations backed with data, evidence, and analysis.'),
      mk('c4', 'Conclusion / Alternatives',           Math.round(pts * 0.13), 'Thoughtful conclusion with alternatives considered.'),
      mk('c5', 'Writing Quality',                     Math.round(pts * 0.07), 'Well-organized, clearly written, professional.'),
    ]};
  }
  if (group === 'Activities') {
    return { name: a.name, totalPoints: pts, criteria: [
      mk('c1', 'Participation',   Math.round(pts * 0.50), 'Active participation in the activity/simulation.'),
      mk('c2', 'Quality of Work', Math.round(pts * 0.30), 'Quality and thoughtfulness of submitted work.'),
      mk('c3', 'Completion',      Math.round(pts * 0.20), 'All required elements completed and submitted.', true),
    ]};
  }
  if (group === 'AI Assignments') {
    return { name: a.name, totalPoints: pts, criteria: [
      mk('c1', 'Submission',     Math.round(pts * 0.20), 'AI-generated output submitted.', true),
      mk('c2', 'Output Quality', Math.round(pts * 0.40), 'Quality and relevance of the AI-generated content.'),
      mk('c3', 'Reflection',     Math.round(pts * 0.40), 'Student reflection on the AI output and process.'),
    ]};
  }
  if (group === 'Group Project') {
    return { name: a.name, totalPoints: pts, criteria: [
      mk('c1', 'Submission',          Math.round(pts * 0.10), 'Deliverable submitted on time.', true),
      mk('c2', 'Content & Analysis',  Math.round(pts * 0.40), 'Depth and quality of analysis.'),
      mk('c3', 'Recommendations',     Math.round(pts * 0.30), 'Clear, actionable, and well-supported recommendations.'),
      mk('c4', 'Presentation',        Math.round(pts * 0.20), 'Organization, clarity, and professional presentation.'),
    ]};
  }
  if (group === 'Participation') {
    return { name: a.name, totalPoints: pts, criteria: [
      mk('c1', 'Attendance',        Math.round(pts * 0.30), 'Present and engaged throughout class.', true),
      mk('c2', 'Contribution',      Math.round(pts * 0.70), 'Quality of contributions to discussion.'),
    ]};
  }
  // Generic fallback
  return defaultRubric(a.name, pts);
}

function defaultRubric(name = '', pts = 10) {
  return {
    name, totalPoints: pts,
    criteria: [
      { id: 'c1', name: 'Submission',    maxPoints: Math.round(pts * 0.20), description: 'Work submitted.', autoGrant: true },
      { id: 'c2', name: 'Content',       maxPoints: Math.round(pts * 0.50), description: 'Quality and completeness of content.', autoGrant: false },
      { id: 'c3', name: 'Quality',       maxPoints: Math.round(pts * 0.30), description: 'Clarity, organization, and presentation.', autoGrant: false },
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
    case 'overview':    stopChatPoll(); renderOverview(root); break;
    case 'assignment':  renderAssignmentView(root); break;
    case 'gradebook':   renderGradeBook(root); break;
    case 'teams':       renderTeamsView(root); break;
    case 'ledger':      renderLedgerView(root); break;
    case 'quiz':        renderQuizView(root); break;
    case 'content':     renderContentView(root); loadCourseContent(); break;
    case 'syllabus':    renderSyllabusView(root); break;
    case 'manual':      renderManualView(root); break;
    default:            renderOverview(root);
  }
}

/* ── OVERVIEW VIEW ───────────────────────────────────────────────────────────── */

// Returns the next Monday and Wednesday on or after `from`
function nextClassDates(from) {
  const d = new Date(from); d.setHours(0,0,0,0);
  const results = [];
  for (let i = 0; i <= 13 && results.length < 2; i++) {
    const t = new Date(d); t.setDate(d.getDate() + i);
    if (t.getDay() === 1 || t.getDay() === 3) results.push(t); // Mon=1, Wed=3
  }
  return results;  // [next class, class after that]
}

async function dismissAssignment(aid) {
  S.dismissed.add(String(aid));
  await PUT(`/api/dismissed/${S.course.id}`, [...S.dismissed]).catch(() => {});
  renderOverview();
}

function renderOverview(root) {
  root = root || document.getElementById('view-root');
  const now = new Date();

  // Find next 2 class sessions from syllabus
  const today = now.toISOString().slice(0,10);
  const upcomingSessions = [];
  const seenDates = new Set();
  for (const row of (S.syllabus || [])) {
    if (row.date >= today && !row.isCancelled && row.session && row.session.startsWith('Class') && !seenDates.has(row.date)) {
      seenDates.add(row.date);
      if (upcomingSessions.length < 2) upcomingSessions.push(row.date);
    }
  }
  // Build activities per session date
  function sessionRows(date) { return (S.syllabus || []).filter(r => r.date === date && !r.isCancelled); }
  function sessionLabel(date) {
    if (!date) return '—';
    const d = new Date(date + 'T12:00:00');
    return d.toLocaleDateString('en-US', { weekday:'long', month:'short', day:'numeric' });
  }
  function sessionName(date) {
    const first = (S.syllabus || []).find(r => r.date === date && r.session);
    return first?.session || '';
  }

  const needsGrading = S.assignments.filter(a => {
    if (S.dismissed.has(String(a.id))) return false;
    const g = S.allGrades[String(a.id)] || {};
    return Object.values(g).some(gr => gr.status !== 'reviewed');
  });

  const recentlyGraded = S.assignments.filter(a => {
    const g = S.allGrades[String(a.id)] || {};
    const vals = Object.values(g);
    return vals.length > 0 && vals.every(gr => gr.status === 'reviewed');
  }).slice(-4);

  const allFlags = [];
  Object.entries(S.allGrades).forEach(([aid, students]) => {
    const a = S.assignments.find(x => String(x.id) === aid);
    Object.values(students).forEach(g => {
      const pct = g.aiDetection?.pct ?? (g.aiDetection?.score != null ? g.aiDetection.score * 10 : 0);
      if (g.flagged || pct >= 80) allFlags.push({ ...g, assignmentName: a?.name || aid, assignmentId: aid, aiPct: pct });
    });
  });
  allFlags.sort((a, b) => (b.aiPct || 0) - (a.aiPct || 0));

  let avgHtml = '—';
  if (recentlyGraded.length) {
    const last = recentlyGraded[recentlyGraded.length - 1];
    const grades = Object.values(S.allGrades[String(last.id)] || {});
    const scores = grades.map(g => g.finalScore).filter(s => s != null);
    if (scores.length) {
      const avg = (scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1);
      avgHtml = `${avg} / ${last.points_possible || '?'} <span class="muted" style="font-size:11px">${esc(last.name)}</span>`;
    }
  }

  function upcomingRows(list) {
    if (!list.length) return '<p class="muted" style="padding:6px 0">Nothing due.</p>';
    return `<table class="overview-table">
      <thead><tr><th>Assignment</th><th>Type</th><th>Points</th><th></th></tr></thead>
      <tbody>${list.map(a => `<tr>
        <td><button class="link-btn" onclick="selectAssignment('${a.id}')">${esc(a.name)}</button></td>
        <td><span class="type-badge">${esc(classifyAssignment(a))}</span></td>
        <td>${a.points_possible || '—'}</td>
        <td><button class="btn btn-surf" style="font-size:11px;padding:3px 8px" onclick="selectAssignment('${a.id}')">Open</button></td>
      </tr>`).join('')}</tbody>
    </table>`;
  }

  root.innerHTML = `
    <div class="page-title">Overview — ${esc(S.course?.name || 'No course selected')}</div>

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
        <div class="stat-value" style="font-size:16px">${avgHtml}</div>
        <div class="stat-label">Last Avg Score</div>
      </div>
    </div>

    <!-- Upcoming by class day (from syllabus) -->
    <div class="overview-grid">
      ${upcomingSessions.map((date, idx) => {
        const rows = sessionRows(date);
        const label = sessionLabel(date);
        const sName = sessionName(date);
        const hasDue = rows.some(r => r.assignmentDue && r.assignmentDue !== '—');
        return `<div class="card">
          <div class="card-title">📅 ${esc(sName)} — ${esc(label)}
            ${hasDue ? '<span class="card-title-hint" style="color:var(--warn)">assignments due</span>' : ''}
          </div>
          <table class="syllabus-mini">
            <tbody>${rows.map(r => `<tr>
              <td class="syl-act-type ${actTypeClass(r.actType)}">${esc(r.actType)}</td>
              <td class="syl-topic">${esc(r.topic)}</td>
              <td class="syl-inst">${esc(r.instructor)}</td>
              ${r.assignmentDue && r.assignmentDue !== '—' ? `<td class="syl-due">⚑ ${esc(r.assignmentDue)}</td>` : '<td></td>'}
            </tr>`).join('')}</tbody>
          </table>
          ${hasDue ? `<div style="font-size:11px;color:var(--warn);margin-top:6px;padding:0 2px">
            ${rows.filter(r => r.assignmentDue && r.assignmentDue !== '—').map(r => `<div>• ${esc(r.assignmentDue)}</div>`).join('')}
          </div>` : ''}
        </div>`;
      }).join('')}
    </div>

    <!-- Needs grading -->
    <div class="card card-full" style="margin-bottom:12px">
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
            <td style="display:flex;gap:5px">
              <button class="btn btn-surf" style="font-size:11px;padding:4px 10px" onclick="selectAssignment('${a.id}')">Open</button>
              <button class="btn btn-ghost" style="font-size:11px;padding:4px 10px" title="Hide until new submission" onclick="dismissAssignment('${a.id}')">✓ Done</button>
            </td>
          </tr>`;
        }).join('')}</tbody>
      </table>` : '<p class="muted">All assignments reviewed! 🎉</p>'}
    </div>

    <div class="overview-grid">

      <!-- AI Flags -->
      <div class="card">
        <div class="card-title">⚑ AI Flags — Likelihood ≥ 80% (${allFlags.length})</div>
        ${allFlags.length ? `<div class="ai-flags-list">${allFlags.slice(0, 15).map(f => {
          const pct = f.aiPct || 0;
          const color = pct >= 80 ? 'var(--danger)' : pct >= 50 ? 'var(--warn)' : 'var(--success)';
          return `<div class="ai-flag-row">
            <button class="link-btn" onclick="selectAssignment('${esc(f.assignmentId)}')" style="font-weight:700">${esc(f.studentName)}</button>
            <button class="link-btn muted" onclick="selectAssignment('${esc(f.assignmentId)}')" style="font-size:11px">${esc(f.assignmentName)}</button>
            <div class="ai-flag-meter">
              <div class="ai-flag-meter-track"><div class="ai-flag-meter-fill" style="width:${pct}%;background:${color}"></div></div>
              <span style="font-size:12px;font-weight:800;color:${color}">${pct}%</span>
            </div>
          </div>`;
        }).join('')}
          ${allFlags.length > 15 ? `<div class="muted" style="padding:6px 0">…and ${allFlags.length - 15} more</div>` : ''}
        </div>` : '<p class="muted">No AI flags detected.</p>'}
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

/* ── GRADE BOOK VIEW ─────────────────────────────────────────────────────────── */
async function renderGradeBook(root) {
  root = root || document.getElementById('view-root');
  if (!S.course) { root.innerHTML = '<p class="muted padded">Select a course first.</p>'; return; }

  // Ensure we have student list
  if (!S.allStudentsList.length) {
    root.innerHTML = '<p class="muted padded">Loading students…</p>';
    try { S.allStudentsList = await GET(`/api/courses/${S.course.id}/students`); }
    catch (e) { root.innerHTML = `<p class="muted padded">Error: ${esc(e.message)}</p>`; return; }
  }

  _renderGradeBookHtml(root);
}

function _renderGradeBookHtml(root, selectedStudentId) {
  root = root || document.getElementById('view-root');
  const students = S.allStudentsList;
  const assignments = S.assignments.sort((a, b) => new Date(a.due_at||0) - new Date(b.due_at||0));

  // Per-student totals
  function studentTotals(sid) {
    let earned = 0, possible = 0;
    assignments.forEach(a => {
      const g = (S.allGrades[String(a.id)] || {})[sid];
      if (g?.finalScore != null && a.points_possible) {
        earned   += g.finalScore;
        possible += a.points_possible;
      }
    });
    return { earned, possible, pct: possible ? Math.round(earned / possible * 100) : null };
  }

  function letterGrade(pct) {
    if (pct == null) return '—';
    if (pct >= 93) return 'A';  if (pct >= 90) return 'A-';
    if (pct >= 87) return 'B+'; if (pct >= 83) return 'B'; if (pct >= 80) return 'B-';
    if (pct >= 77) return 'C+'; if (pct >= 73) return 'C'; if (pct >= 70) return 'C-';
    if (pct >= 67) return 'D+'; if (pct >= 60) return 'D';
    return 'F';
  }

  // Student list panel
  const listRows = students.map(st => {
    const { earned, possible, pct } = studentTotals(st.id);
    const letter = letterGrade(pct);
    const isSelected = st.id === selectedStudentId;
    const barW = pct != null ? Math.min(pct, 100) : 0;
    const barColor = pct == null ? '#ddd' : pct >= 80 ? 'var(--success)' : pct >= 70 ? 'var(--warn)' : 'var(--danger)';
    return `<tr class="gb-student-row ${isSelected ? 'gb-selected' : ''}" onclick="showStudentCard('${esc(st.id)}')">
      <td class="gb-name"><span class="gb-avatar">${esc((st.name||'?')[0].toUpperCase())}</span>${esc(st.name)}</td>
      <td class="gb-score">${possible ? `${earned}/${possible}` : '—'}</td>
      <td class="gb-pct">
        ${pct != null ? `<div class="gb-bar-wrap"><div class="gb-bar" style="width:${barW}%;background:${barColor}"></div></div>
        <span class="gb-pct-val">${pct}%</span>` : '<span class="muted">—</span>'}
      </td>
      <td class="gb-letter ${pct != null && pct < 70 ? 'grade-low' : ''}">${letter}</td>
    </tr>`;
  }).join('');

  // Student card panel
  const cardHtml = selectedStudentId ? buildStudentCard(selectedStudentId) : `
    <div class="gb-card-empty">
      <div style="font-size:40px;margin-bottom:12px">👤</div>
      <div>Click a student to view their grade card</div>
    </div>`;

  root.innerHTML = `
    <div class="page-title">Grade Book — ${esc(S.course?.name || '')}
      <div class="page-actions">
        <button class="btn btn-ghost" onclick="renderGradeBook()">⟳ Refresh</button>
      </div>
    </div>
    <div class="gb-layout">
      <div class="gb-list-panel">
        <div class="gb-list-header">
          <input class="input" id="gb-search" type="text" placeholder="Search student…" oninput="filterGbStudents(this.value)" style="font-size:12px;padding:5px 8px" />
          <span class="muted" style="font-size:11px;margin-top:4px">${students.length} students</span>
        </div>
        <div class="gb-list-scroll">
          <table class="gb-table"><tbody id="gb-student-rows">${listRows}</tbody></table>
        </div>
      </div>
      <div class="gb-card-panel" id="gb-card-panel">${cardHtml}</div>
    </div>`;
}

function filterGbStudents(q) {
  const rows = document.querySelectorAll('.gb-student-row');
  const lq = q.toLowerCase();
  rows.forEach(r => { r.style.display = r.textContent.toLowerCase().includes(lq) ? '' : 'none'; });
}

function showStudentCard(studentId) {
  _renderGradeBookHtml(null, studentId);
}

async function uploadStudentPhoto(studentId, file) {
  if (!file) return;
  const form = new FormData();
  form.append('photo', file);
  try {
    const resp = await fetch(`/api/student-photo/${studentId}`, { method: 'POST', body: form });
    if (!resp.ok) throw new Error('Upload failed');
    toast('Photo uploaded!', 'success');
    // Refresh the photo
    const img = document.getElementById(`sc-photo-${studentId}`);
    const avatar = document.getElementById(`sc-avatar-${studentId}`);
    if (img) { img.src = `/api/student-photo/${studentId}?t=${Date.now()}`; img.style.display = ''; }
    if (avatar) avatar.style.display = 'none';
  } catch (e) { toast('Upload failed: ' + e.message, 'error'); }
}

function buildStudentCard(studentId) {
  const st = S.allStudentsList.find(s => s.id === studentId) || S.students.find(s => s.id === studentId);
  if (!st) return '<p class="muted">Student not found.</p>';

  const teamData    = S.teams[studentId] || {};
  const teamNum     = teamData.team || null;
  const teamMeta    = teamNum ? (S.teamMeta[String(teamNum)] || {}) : {};
  const teamLabel   = teamNum ? (teamMeta.name ? `Team ${teamNum} — ${teamMeta.name}` : `Team ${teamNum}`) : null;
  const teammates   = teamNum
    ? S.allStudentsList.filter(s => s.id !== studentId && (S.teams[s.id]?.team) === teamNum).map(s => s.name)
    : [];

  const assignments = S.assignments.sort((a, b) => new Date(a.due_at||0) - new Date(b.due_at||0));

  // Group assignments, compute per-category totals
  let totalEarned = 0, totalPossible = 0;
  const byGroup = {};
  assignments.forEach(a => {
    const g = classifyAssignment(a);
    if (!byGroup[g]) byGroup[g] = [];
    const grade = (S.allGrades[String(a.id)] || {})[studentId];
    const sub = S.submissions.find(s => String(s.user_id) === String(studentId));
    const score = grade?.finalScore;
    if (score != null && a.points_possible) { totalEarned += score; totalPossible += a.points_possible; }
    byGroup[g].push({ a, grade, score });
  });

  const pct = totalPossible ? Math.round(totalEarned / totalPossible * 100) : null;
  function letterGrade(p) {
    if (p == null) return '—';
    if (p >= 93) return 'A'; if (p >= 90) return 'A-'; if (p >= 87) return 'B+'; if (p >= 83) return 'B';
    if (p >= 80) return 'B-'; if (p >= 77) return 'C+'; if (p >= 73) return 'C'; if (p >= 70) return 'C-';
    if (p >= 67) return 'D+'; if (p >= 60) return 'D'; return 'F';
  }
  const letter = letterGrade(pct);

  const categoryBlocks = GROUP_ORDER.filter(g => byGroup[g]?.length).map(g => {
    const items = byGroup[g];
    let catEarned = 0, catPossible = 0;
    items.forEach(({ a, score }) => { if (score != null && a.points_possible) { catEarned += score; catPossible += a.points_possible; } });
    const catPct = catPossible ? Math.round(catEarned / catPossible * 100) : null;

    const rows = items.map(({ a, grade, score }) => {
      const sub = S.submissions.find(s => String(s.user_id) === String(studentId));
      // Check allGrades for submission evidence
      const hasGrade = grade != null;
      const isSubmitted = hasGrade || (grade?.status !== 'pending');
      const canvasScore = grade?.canvasScore;
      const statusText = !hasGrade ? '—'
        : grade.status === 'canvas' ? '<span class="status-badge status--canvas">Canvas</span>'
        : grade.status === 'reviewed' ? '<span class="status-badge status--reviewed">Reviewed</span>'
        : '<span class="status-badge status--graded">Graded</span>';
      return `<tr>
        <td class="sc-aname"><button class="link-btn" onclick="selectAssignment('${a.id}')">${esc(a.name)}</button></td>
        <td class="sc-due">${a.due_at ? new Date(a.due_at).toLocaleDateString('en-US',{month:'short',day:'numeric'}) : '—'}</td>
        <td>${statusText}</td>
        <td class="sc-score">${score != null ? `<strong>${score}</strong>` : '—'} ${a.points_possible ? `/ ${a.points_possible}` : ''}</td>
        ${canvasScore != null ? `<td class="muted" style="font-size:11px">Canvas: ${canvasScore}</td>` : '<td></td>'}
      </tr>`;
    }).join('');

    return `<div class="sc-category">
      <div class="sc-cat-header">
        <span>${esc(g)}</span>
        <span class="sc-cat-score">${catPossible ? `${catEarned}/${catPossible}` : '—'} ${catPct != null ? `<span class="muted">(${catPct}%)</span>` : ''}</span>
      </div>
      <table class="sc-table"><tbody>${rows}</tbody></table>
    </div>`;
  }).join('');

  const assessment = pct == null ? 'No grades recorded yet.'
    : pct >= 90 ? 'Excellent performance. Keep it up!'
    : pct >= 80 ? 'Good standing. A few areas to strengthen.'
    : pct >= 70 ? 'Satisfactory. Some assignments need attention.'
    : pct >= 60 ? 'Below expectations. Recommend reaching out to student.'
    : 'Struggling. Immediate attention recommended.';

  const photoUrl = `/api/student-photo/${esc(studentId)}`;

  return `
    <div class="sc-header">
      <div class="sc-photo-wrap">
        <img class="sc-photo-img" id="sc-photo-${esc(studentId)}" src="${photoUrl}" alt="${esc(st.name)}"
          onerror="this.style.display='none';this.nextElementSibling.style.display='grid'" />
        <div class="sc-avatar-lg" id="sc-avatar-${esc(studentId)}" style="display:none;width:80px;height:80px;font-size:28px">${esc((st.name||'?')[0].toUpperCase())}</div>
        <button class="sc-photo-upload-btn" title="Upload photo" onclick="document.getElementById('photo-input-${esc(studentId)}').click()">+</button>
        <input type="file" id="photo-input-${esc(studentId)}" accept="image/*" style="display:none"
          onchange="uploadStudentPhoto('${esc(studentId)}', this.files[0])" />
      </div>
      <div>
        <div class="sc-student-name">${esc(st.name)}</div>
        <div class="muted" style="font-size:12px">${esc(st.email || '')}</div>
      </div>
      <div class="sc-grade-bubble ${pct != null && pct < 70 ? 'grade-low' : ''}">${letter}<div style="font-size:11px;font-weight:400">${pct != null ? pct+'%' : '—'}</div></div>
    </div>

    <div class="sc-team-row">
      <span>Team:</span>
      <input class="sc-team-input" type="number" min="1" max="99" placeholder="—"
        value="${teamNum || ''}"
        onchange="saveStudentTeam('${esc(studentId)}', this.value)"
        title="Set team number" />
      ${teamLabel ? `<span class="tm-label-pill">${esc(teamLabel)}</span>` : ''}
      ${teammates.length ? `<span class="muted" style="font-size:11px">with ${teammates.slice(0,4).map(n => n.split(' ')[0]).join(', ')}</span>` : ''}
    </div>

    <div class="sc-summary">
      <div class="sc-sum-item"><div class="sc-sum-val">${totalEarned}</div><div class="sc-sum-lbl">Earned</div></div>
      <div class="sc-sum-item"><div class="sc-sum-val">${totalPossible}</div><div class="sc-sum-lbl">Possible</div></div>
      <div class="sc-sum-item"><div class="sc-sum-val">${pct != null ? pct+'%' : '—'}</div><div class="sc-sum-lbl">Percentage</div></div>
      <div class="sc-sum-item"><div class="sc-sum-val ${pct != null && pct < 70 ? 'grade-low' : ''}">${letter}</div><div class="sc-sum-lbl">Letter</div></div>
    </div>

    <div class="sc-assessment">${esc(assessment)}</div>

    <div class="sc-categories">${categoryBlocks}</div>`;
}

/* ── TEAMS VIEW ──────────────────────────────────────────────────────────────── */
function renderTeamsView(root) {
  root = root || document.getElementById('view-root');
  if (!S.course) { root.innerHTML = '<p class="muted padded">Select a course first.</p>'; return; }

  // Group project assignments
  const projectAssignments = S.assignments.filter(a => classifyAssignment(a) === 'Group Project')
    .sort((a, b) => new Date(a.due_at||0) - new Date(b.due_at||0));

  // Build team → [studentIds] map
  const teamStudents = {};
  S.allStudentsList.forEach(st => {
    const t = S.teams[st.id]?.team;
    if (t) { if (!teamStudents[t]) teamStudents[t] = []; teamStudents[t].push(st); }
  });

  const teamNums = Object.keys(S.teamMeta).map(Number).sort((a, b) => a - b);

  const teamCards = teamNums.map(tNum => {
    const meta    = S.teamMeta[String(tNum)] || {};
    const members = teamStudents[tNum] || [];
    const label   = meta.name ? `Team ${tNum} — ${meta.name}` : `Team ${tNum}`;

    // Member rows with group project scores
    const memberRows = members.map(st => {
      const scoreCells = projectAssignments.map(a => {
        const g = (S.allGrades[String(a.id)] || {})[st.id];
        const score = g?.finalScore ?? g?.canvasScore ?? null;
        const pct = score != null && a.points_possible ? score / a.points_possible : null;
        const cls = pct == null ? '' : pct >= 0.9 ? 'ldg-cell-a' : pct >= 0.8 ? 'ldg-cell-b' : pct >= 0.7 ? 'ldg-cell-c' : 'ldg-cell-f';
        return `<td class="tm-score ${cls}">${score != null ? score : '<span class="ldg-empty">—</span>'}</td>`;
      }).join('');
      return `<tr>
        <td class="tm-member-name"><button class="link-btn" onclick="showView('gradebook');setTimeout(()=>showStudentCard('${esc(st.id)}'),100)">${esc(st.name)}</button></td>
        ${scoreCells}
      </tr>`;
    }).join('');

    // Team totals per assignment (average of members who have a score)
    const totalRow = projectAssignments.map(a => {
      const scores = members.map(st => {
        const g = (S.allGrades[String(a.id)] || {})[st.id];
        return g?.finalScore ?? g?.canvasScore ?? null;
      }).filter(s => s != null);
      const avg = scores.length ? (scores.reduce((x,y) => x+y, 0) / scores.length).toFixed(1) : '—';
      return `<td class="tm-score tm-avg"><strong>${avg}</strong></td>`;
    }).join('');

    const asgHeaders = projectAssignments.map(a =>
      `<th class="tm-asg-hdr" title="${esc(a.name)}">${esc(a.name.length > 20 ? a.name.slice(0,18)+'…' : a.name)}<div class="ldg-pts">${a.points_possible||'?'}pt</div></th>`
    ).join('');

    return `
      <div class="tm-card">
        <div class="tm-card-hdr">
          <span class="tm-num">Team ${tNum}</span>
          <span class="tm-company">${esc(meta.name || '')}</span>
          <span class="tm-count muted">${members.length} students</span>
        </div>
        ${projectAssignments.length ? `
        <div class="tm-table-wrap">
          <table class="tm-table">
            <thead><tr>
              <th class="tm-name-hdr">Student</th>
              ${asgHeaders}
            </tr></thead>
            <tbody>
              ${memberRows}
              <tr class="tm-total-row">
                <td class="tm-name-hdr"><em>Team Avg</em></td>
                ${totalRow}
              </tr>
            </tbody>
          </table>
        </div>` : `<div class="muted" style="padding:10px 0;font-size:12px">No Group Project assignments found yet.</div>`}
        <div class="tm-members-bare">
          ${members.map(st => `<span class="tm-badge">${esc(st.name.split(' ')[0])} ${esc(st.name.split(' ').slice(-1)[0])}</span>`).join('')}
        </div>
      </div>`;
  }).join('');

  root.innerHTML = `
    <div class="page-title">Teams — ${esc(S.course?.name || '')}
      <div class="page-actions">
        <button class="btn btn-ghost" onclick="renderTeamsView()">⟳ Refresh</button>
      </div>
    </div>
    ${teamNums.length ? `<div class="tm-grid">${teamCards}</div>`
      : '<p class="muted padded">No team data found. Load a course first.</p>'}`;
}

/* ── LEDGER VIEW (Canvas-style grade spreadsheet) ────────────────────────────── */
async function renderLedgerView(root) {
  root = root || document.getElementById('view-root');
  if (!S.course) { root.innerHTML = '<p class="muted padded">Select a course first.</p>'; return; }

  root.innerHTML = `<div class="page-title">Grade Ledger — ${esc(S.course?.name || '')}
    <div class="page-actions">
      <button class="btn btn-primary" id="ledger-sync-btn" onclick="syncLedgerFromCanvas()">⟳ Sync from Canvas</button>
    </div>
  </div><div class="padded muted">Loading…</div>`;

  // Ensure students loaded
  if (!S.allStudentsList.length) {
    try { S.allStudentsList = await GET(`/api/courses/${S.course.id}/students`); }
    catch (e) { root.innerHTML = `<p class="muted padded">Error loading students: ${esc(e.message)}</p>`; return; }
  }

  _renderLedgerHtml(root);
}

function _renderLedgerHtml(root, canvasScores) {
  root = root || document.getElementById('view-root');
  const students   = S.allStudentsList;
  const assignments = [...S.assignments].sort((a, b) => new Date(a.due_at||0) - new Date(b.due_at||0));
  if (!students.length || !assignments.length) {
    root.innerHTML = '<p class="muted padded">No students or assignments loaded. Select a course first.</p>';
    return;
  }

  // Build header columns (group by category, show category label spanning)
  const grouped = {};
  assignments.forEach(a => {
    const g = classifyAssignment(a);
    if (!grouped[g]) grouped[g] = [];
    grouped[g].push(a);
  });
  const orderedGroups = [...GROUP_ORDER.filter(g => grouped[g]), ...Object.keys(grouped).filter(g => !GROUP_ORDER.includes(g))];

  // Group header row
  const groupHeaderCells = orderedGroups.map(g =>
    `<th class="ldg-group-hdr" colspan="${grouped[g].length}">${esc(g)}</th>`
  ).join('');

  // Assignment header row
  const asgHeaderCells = orderedGroups.flatMap(g => grouped[g].map(a =>
    `<th class="ldg-asg-hdr" title="${esc(a.name)}">${esc(a.name.length > 18 ? a.name.slice(0,16)+'…' : a.name)}<div class="ldg-pts">${a.points_possible || '?'}pt</div></th>`
  )).join('');

  // Student rows
  const rows = students.map(st => {
    let earned = 0, possible = 0;
    const cells = orderedGroups.flatMap(g => grouped[g].map(a => {
      const localGrade = (S.allGrades[String(a.id)] || {})[st.id];
      const cvScore    = canvasScores?.[String(a.id)]?.[st.id];
      const score = localGrade?.finalScore ?? localGrade?.canvasScore ?? cvScore ?? null;
      if (score != null && a.points_possible) { earned += score; possible += a.points_possible; }
      const pct  = (score != null && a.points_possible) ? score / a.points_possible : null;
      const bg   = pct == null ? '' : pct >= 0.9 ? 'ldg-cell-a' : pct >= 0.8 ? 'ldg-cell-b' : pct >= 0.7 ? 'ldg-cell-c' : 'ldg-cell-f';
      const src  = localGrade?.finalScore != null ? '' : localGrade?.canvasScore != null ? ' title="Canvas"' : cvScore != null ? ' title="Canvas sync"' : '';
      return `<td class="ldg-cell ${bg}"${src}>${score != null ? score : '<span class="ldg-empty">—</span>'}</td>`;
    }));
    const pct = possible ? Math.round(earned / possible * 100) : null;
    const letter = pct == null ? '—' : pct>=93?'A':pct>=90?'A-':pct>=87?'B+':pct>=83?'B':pct>=80?'B-':pct>=77?'C+':pct>=73?'C':pct>=70?'C-':pct>=67?'D+':pct>=60?'D':'F';
    return `<tr>
      <td class="ldg-name">${esc(st.name)}</td>
      <td class="ldg-total">${possible ? `${earned}/${possible}` : '—'}</td>
      <td class="ldg-letter ${pct != null && pct < 70 ? 'grade-low' : ''}">${letter}</td>
      ${cells.join('')}
    </tr>`;
  }).join('');

  root.innerHTML = `
    <div class="page-title">Grade Ledger — ${esc(S.course?.name || '')}
      <div class="page-actions">
        <button class="btn btn-primary" onclick="syncLedgerFromCanvas()">⟳ Sync from Canvas</button>
      </div>
    </div>
    <div class="ldg-wrap">
      <table class="ldg-table">
        <thead>
          <tr>
            <th class="ldg-name-hdr" rowspan="2">Student</th>
            <th class="ldg-total-hdr" rowspan="2">Total</th>
            <th class="ldg-letter-hdr" rowspan="2">Grade</th>
            ${groupHeaderCells}
          </tr>
          <tr>${asgHeaderCells}</tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

async function syncLedgerFromCanvas() {
  await syncCanvasGrades(false);
}

async function saveStudentTeam(studentId, teamNum) {
  if (!S.course) return;
  const num = parseInt(teamNum) || null;
  if (num) S.teams[studentId] = { team: num };
  else delete S.teams[studentId];
  await PUT(`/api/teams/${S.course.id}`, S.teams);
  // Refresh card without reloading full list
  const panel = document.getElementById('gb-card-panel');
  if (panel) panel.innerHTML = buildStudentCard(studentId);
}

/* ── Syllabus helpers ───────────────────────────────────────────────────────── */
const ACT_TYPE_COLORS = {
  'Quiz':           'act-quiz',
  'Case Discussion':'act-case',
  'Simulation':     'act-sim',
  'AI Exercise':    'act-ai',
  'Online Recorded':'act-recorded',
  'Group Work':     'act-group',
  'Discussion':     'act-discuss',
  'News/Current':   'act-news',
  'Admin':          'act-admin',
  'Exam':           'act-exam',
  'Presentation':   'act-present',
};
function actTypeClass(t) { return ACT_TYPE_COLORS[t] || 'act-other'; }

/* ── SYLLABUS VIEW ───────────────────────────────────────────────────────────── */
/* ── Syllabus save debounce ──────────────────────────────────────────────────── */
let _sylTimer;
function saveSylDebounced() {
  clearTimeout(_sylTimer);
  _sylTimer = setTimeout(() => PUT('/api/syllabus', S.syllabus).catch(() => {}), 800);
}

function updateSylField(idx, field, value) {
  if (!S.syllabus[idx]) return;
  S.syllabus[idx][field] = field === 'points' ? (value === '' ? null : Number(value))
                          : field === 'actNum' ? (value === '' ? '' : Number(value))
                          : value;
  saveSylDebounced();
}

function renderSyllabusView(root) {
  root = root || document.getElementById('view-root');
  const rows = S.syllabus || [];
  const actTypes = Object.keys(ACT_TYPE_COLORS);

  // Build date → class number map (sorted unique dates)
  const uniqueDates = [...new Set(rows.map(r => r.date).filter(Boolean))].sort();
  const dateToClassNum = {};
  uniqueDates.forEach((d, i) => { dateToClassNum[d] = i + 1; });

  const si = (idx, field, val, extra = '') =>
    `<input class="syl-cell-input" type="text" value="${esc(val || '')}"
      oninput="updateSylField(${idx},'${field}',this.value)" ${extra} />`;

  const rowsHtml = rows.map((row, i) => {
    const isCancelled = !!row.isCancelled;
    const classNum    = dateToClassNum[row.date] || '';
    const isEven      = classNum % 2 === 0;
    const rowCls = isCancelled ? 'syl-row-cancelled' : isEven ? 'syl-row syl-row-even' : 'syl-row syl-row-odd';

    const actTypeOpts = actTypes.map(t =>
      `<option value="${esc(t)}" ${row.actType === t ? 'selected' : ''}>${esc(t)}</option>`
    ).join('');

    return `<tr class="${rowCls}" id="syl-row-${i}">
      <td class="syl-session">
        ${classNum ? `<span class="syl-class-num">C${classNum}</span>` : ''}
        ${si(i,'session',row.session,'placeholder="label"')}
      </td>
      <td class="syl-date">
        <input class="syl-cell-input syl-date-input" type="date" value="${row.date || ''}"
          oninput="updateSylField(${i},'date',this.value);updateDayFromDate(${i},this.value)" />
      </td>
      <td class="syl-day">${si(i,'day',row.day,'placeholder="Mon"')}</td>
      <td class="syl-loc">
        <select class="syl-cell-select" onchange="updateSylField(${i},'location',this.value)">
          ${['Zoom','Bothell','Online','—'].map(l=>`<option ${row.location===l?'selected':''}>${l}</option>`).join('')}
        </select>
      </td>
      <td class="syl-time">${si(i,'estTime',row.estTime,'placeholder="15 min"')}</td>
      <td class="syl-num">
        <input class="syl-cell-input syl-num-input" type="number" min="1" value="${row.actNum||''}"
          oninput="updateSylField(${i},'actNum',this.value)" />
      </td>
      <td>
        <select class="syl-cell-select syl-act-select ${actTypeClass(row.actType)}"
          onchange="updateSylField(${i},'actType',this.value);this.className='syl-cell-select syl-act-select '+actTypeClass(this.value)">
          ${actTypeOpts}
        </select>
      </td>
      <td class="syl-topic-cell">
        <textarea class="syl-cell-ta" rows="2" oninput="updateSylField(${i},'topic',this.value)">${esc(row.topic||'')}</textarea>
      </td>
      <td class="syl-reading-cell">
        <textarea class="syl-cell-ta" rows="2" oninput="updateSylField(${i},'reading',this.value)">${esc(row.reading && row.reading!=='—' ? row.reading : '')}</textarea>
      </td>
      <td class="syl-due-cell">
        <textarea class="syl-cell-ta syl-due-ta" rows="2" oninput="updateSylField(${i},'assignmentDue',this.value)">${esc(row.assignmentDue && row.assignmentDue!=='—' ? row.assignmentDue : '')}</textarea>
      </td>
      <td class="syl-pts">
        <input class="syl-cell-input syl-num-input" type="number" min="0" value="${row.points ?? ''}"
          oninput="updateSylField(${i},'points',this.value)" placeholder="—" />
      </td>
      <td class="syl-inst-cell">
        <select class="syl-cell-select" onchange="updateSylField(${i},'instructor',this.value)">
          ${['Marco','Marlowe','Both','—'].map(v=>`<option ${row.instructor===v?'selected':''}>${v}</option>`).join('')}
        </select>
      </td>
      <td class="syl-notes-cell">
        <textarea class="syl-cell-ta syl-notes-ta" rows="2" oninput="updateSylField(${i},'notes',this.value)" placeholder="Notes…">${esc(row.notes||'')}</textarea>
      </td>
      <td class="syl-actions-cell">
        <button class="btn-icon" title="Add row below" onclick="addSylRow(${i})">＋</button>
        <button class="btn-icon btn-icon-del" title="Delete row" onclick="deleteSylRow(${i})">✕</button>
      </td>
    </tr>`;
  }).join('');

  root.innerHTML = `
    <div class="page-title">Instructor Syllabus — B BUS 464
      <div class="page-actions">
        <button class="btn btn-surf" onclick="addSylRow(-1)">＋ Add Row</button>
        <button class="btn btn-ghost" onclick="resetSyllabus()">↺ Reset to Default</button>
      </div>
    </div>
    <div class="syl-legend">
      ${Object.entries(ACT_TYPE_COLORS).map(([t,c])=>`<span class="syl-act-badge ${c}">${esc(t)}</span>`).join('')}
    </div>
    <div class="syl-table-wrap">
      <table class="syl-table">
        <thead><tr>
          <th>Session</th><th>Date</th><th>Day</th><th>Location</th>
          <th>Est.Time</th><th>#</th><th>Activity Type</th><th>Topic / Description</th>
          <th>Reading / Videos</th><th>Assignment DUE</th><th>Pts</th>
          <th>Instructor</th><th>Notes</th><th style="width:56px"></th>
        </tr></thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>`;
}

function formatSylDate(iso) {
  if (!iso) return '';
  const d = new Date(iso + 'T12:00:00');
  return d.toLocaleDateString('en-US', { month:'short', day:'numeric' });
}

function updateDayFromDate(idx, iso) {
  if (!iso) return;
  const day = new Date(iso + 'T12:00:00').toLocaleDateString('en-US', { weekday:'long' });
  updateSylField(idx, 'day', day);
  // also update the day input in the same row
  const row = document.getElementById(`syl-row-${idx}`);
  if (row) { const inp = row.querySelectorAll('.syl-cell-input')[1]; if (inp) inp.value = day; }
}

async function addSylRow(afterIdx) {
  const ref = afterIdx >= 0 ? (S.syllabus[afterIdx] || {}) : {};
  const newRow = { session:'', date: ref.date || '', day: ref.day || '', location: ref.location || 'Zoom',
    estTime:'', actNum:'', actType:'Admin', topic:'', reading:'', assignmentDue:'', points:null,
    instructor:'Both', notes:'' };
  if (afterIdx < 0) S.syllabus.push(newRow);
  else S.syllabus.splice(afterIdx + 1, 0, newRow);
  await PUT('/api/syllabus', S.syllabus);
  renderSyllabusView();
  // scroll to new row
  setTimeout(() => {
    const newIdx = afterIdx < 0 ? S.syllabus.length - 1 : afterIdx + 1;
    document.getElementById(`syl-row-${newIdx}`)?.scrollIntoView({ behavior:'smooth', block:'center' });
  }, 100);
}

async function deleteSylRow(idx) {
  if (!confirm('Delete this row?')) return;
  S.syllabus.splice(idx, 1);
  await PUT('/api/syllabus', S.syllabus);
  renderSyllabusView();
}

async function resetSyllabus() {
  if (!confirm('Reset syllabus to original? All edits will be lost.')) return;
  await fetch('/api/syllabus', { method: 'DELETE' });
  S.syllabus = await GET('/api/syllabus');
  renderSyllabusView();
  toast('Syllabus reset.', 'success');
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

  const submitted = S.submissions.filter(s => s.workflow_state !== 'unsubmitted').length;

  // AI detection average
  const aiPcts = Object.values(S.grades).map(g => g.aiDetection?.pct ?? (g.aiDetection?.score != null ? g.aiDetection.score * 10 : null)).filter(p => p != null);
  const aiAvg = aiPcts.length ? Math.round(aiPcts.reduce((a, b) => a + b, 0) / aiPcts.length) : null;
  const aiAvgColor = aiAvg == null ? 'var(--text-muted)' : aiAvg >= 80 ? 'var(--danger)' : aiAvg >= 50 ? 'var(--warn)' : aiAvg >= 25 ? 'var(--info)' : 'var(--success)';

  // Grade distribution buckets
  const distBuckets = { 'A (90-100%)': 0, 'B (80-89%)': 0, 'C (70-79%)': 0, 'D (60-69%)': 0, 'F (<60%)': 0 };
  const distColors  = { 'A (90-100%)': '#16a34a', 'B (80-89%)': '#2563eb', 'C (70-79%)': '#d97706', 'D (60-69%)': '#ea580c', 'F (<60%)': '#dc2626' };
  const maxPts = a.points_possible || S.rubric?.totalPoints || 1;
  scores.forEach(s => {
    const pct = (s / maxPts) * 100;
    if (pct >= 90) distBuckets['A (90-100%)']++;
    else if (pct >= 80) distBuckets['B (80-89%)']++;
    else if (pct >= 70) distBuckets['C (70-79%)']++;
    else if (pct >= 60) distBuckets['D (60-69%)']++;
    else distBuckets['F (<60%)']++;
  });
  const maxBucket = Math.max(1, ...Object.values(distBuckets));
  const distBars = Object.entries(distBuckets).map(([label, count]) => {
    const pct = Math.round((count / maxBucket) * 100);
    return `<div class="dist-bar-row">
      <span class="dist-bar-label">${label}</span>
      <div class="dist-bar-track"><div class="dist-bar-fill" style="width:${pct}%;background:${distColors[label]}"></div></div>
      <span class="dist-bar-count">${count}</span>
    </div>`;
  }).join('');

  root.innerHTML = `
    <div class="page-title">
      ${esc(a.name)}
      <span class="type-badge" style="font-size:13px">${esc(group)}</span>
      <div class="page-actions">
        <button class="btn btn-ghost" onclick="selectAssignment('${a.id}')">⟳ Refresh</button>
      </div>
    </div>

    <!-- Assignment stat cards -->
    <div class="asgn-stat-cards">
      <div class="asgn-stat-card asgn-stat--due">
        <div class="asgn-stat-icon">📅</div>
        <div class="asgn-stat-value">${due}</div>
        <div class="asgn-stat-label">Due Date</div>
      </div>
      <div class="asgn-stat-card asgn-stat--points">
        <div class="asgn-stat-icon">⭐</div>
        <div class="asgn-stat-value">${a.points_possible || '?'}</div>
        <div class="asgn-stat-label">Points</div>
      </div>
      <div class="asgn-stat-card asgn-stat--students">
        <div class="asgn-stat-icon">👥</div>
        <div class="asgn-stat-value">${students.length}</div>
        <div class="asgn-stat-label">Students</div>
      </div>
      <div class="asgn-stat-card asgn-stat--submitted">
        <div class="asgn-stat-icon">📥</div>
        <div class="asgn-stat-value">${submitted}</div>
        <div class="asgn-stat-label">Submitted</div>
      </div>
      <div class="asgn-stat-card asgn-stat--graded">
        <div class="asgn-stat-icon">✅</div>
        <div class="asgn-stat-value">${graded.length}</div>
        <div class="asgn-stat-label">Graded</div>
      </div>
      <div class="asgn-stat-card asgn-stat--avg">
        <div class="asgn-stat-icon">📊</div>
        <div class="asgn-stat-value">${avg}</div>
        <div class="asgn-stat-label">Average</div>
      </div>
      ${flagged.length ? `<div class="asgn-stat-card asgn-stat--flagged">
        <div class="asgn-stat-icon">⚑</div>
        <div class="asgn-stat-value">${flagged.length}</div>
        <div class="asgn-stat-label">AI Flags</div>
      </div>` : ''}
      <div class="asgn-stat-card asgn-stat--ai-index">
        <div class="asgn-stat-icon">🤖</div>
        <div class="asgn-stat-value" style="color:${aiAvgColor}">${aiAvg != null ? aiAvg + '%' : '—'}</div>
        <div class="asgn-stat-label">AI Index Avg</div>
      </div>
    </div>

    <!-- Grade Distribution -->
    ${scores.length ? `<div class="card dist-chart-card">
      <div class="card-title">Grade Distribution</div>
      <div class="dist-chart">${distBars}</div>
    </div>` : ''}

    <!-- AI Detection Summary -->
    ${(() => {
      const aiStudents = students.map(st => {
        const g = S.grades[st.id];
        const det = g?.aiDetection;
        const pct = det?.pct ?? (det?.score != null ? det.score * 10 : null);
        return pct != null ? { name: st.name, id: st.id, pct, level: det.level } : null;
      }).filter(Boolean).sort((a, b) => b.pct - a.pct);
      if (!aiStudents.length) return '';
      const high = aiStudents.filter(s => s.pct >= 80);
      const med = aiStudents.filter(s => s.pct >= 50 && s.pct < 80);
      return `<div class="card ai-summary-card">
        <div class="card-title">🔍 AI Usage Detection — ${a.name}</div>
        ${high.length ? `<div class="ai-summary-section">
          <div class="ai-summary-hdr ai-summary-hdr--high">High Likelihood (≥80%) — ${high.length} student${high.length > 1 ? 's' : ''}</div>
          ${high.map(s => {
            return `<div class="ai-flag-row">
              <button class="link-btn" onclick="openStudent('${esc(s.id)}')" style="font-weight:700">${esc(s.name)}</button>
              <div class="ai-flag-meter">
                <div class="ai-flag-meter-track"><div class="ai-flag-meter-fill" style="width:${s.pct}%;background:var(--danger)"></div></div>
                <span style="font-size:12px;font-weight:800;color:var(--danger)">${s.pct}%</span>
              </div>
            </div>`;
          }).join('')}
        </div>` : ''}
        ${med.length ? `<div class="ai-summary-section">
          <div class="ai-summary-hdr ai-summary-hdr--med">Moderate (50-79%) — ${med.length} student${med.length > 1 ? 's' : ''}</div>
          ${med.map(s => {
            return `<div class="ai-flag-row">
              <button class="link-btn" onclick="openStudent('${esc(s.id)}')">${esc(s.name)}</button>
              <div class="ai-flag-meter">
                <div class="ai-flag-meter-track"><div class="ai-flag-meter-fill" style="width:${s.pct}%;background:var(--warn)"></div></div>
                <span style="font-size:12px;font-weight:700;color:var(--warn)">${s.pct}%</span>
              </div>
            </div>`;
          }).join('')}
        </div>` : ''}
        ${!high.length && !med.length ? '<p class="muted" style="padding:8px 0">All students below 50% AI likelihood.</p>' : ''}
      </div>`;
    })()}

    <!-- Tabs -->
    <div class="assign-tabs" id="assign-tabs">
      <button class="assign-tab active" data-atab="instructions" onclick="switchAssignTab('instructions')">Instructions & Rubric</button>
      <button class="assign-tab assign-tab--grade" data-atab="oneByOne" onclick="switchAssignTab('oneByOne')">✦ Grade One-by-One</button>
      <button class="assign-tab" data-atab="students" onclick="switchAssignTab('students')">Students (${students.length})</button>
      <button class="assign-tab" data-atab="matrix" onclick="switchAssignTab('matrix')">Grading Matrix</button>
      <button class="assign-tab" data-atab="chat" onclick="switchAssignTab('chat')">Notes</button>
    </div>

    <div id="atab-instructions" class="atab-content active">${renderInstructionsTab()}</div>
    <div id="atab-oneByOne"     class="atab-content">${renderOneByOneTab()}</div>
    <div id="atab-students"     class="atab-content">${renderStudentsTabHtml()}</div>
    <div id="atab-matrix"       class="atab-content">${renderMatrixTabHtml()}</div>
    <div id="atab-chat"         class="atab-content">${renderChatTabHtml()}</div>
  `;
}

function switchAssignTab(tab) {
  document.querySelectorAll('.assign-tab').forEach(b => b.classList.toggle('active', b.dataset.atab === tab));
  document.querySelectorAll('.atab-content').forEach(c => c.classList.toggle('active', c.id === `atab-${tab}`));
  if (tab === 'chat') loadComments();
  else stopChatPoll();
  if (tab === 'oneByOne') oboEnterGrading();
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

      <!-- Assignment Description + AI Grading Instructions (stacked left column) -->
      <div style="display:flex;flex-direction:column;gap:16px">

        <!-- Assignment Description -->
        <div class="card">
          <div class="card-title">Assignment Description
            <span class="card-title-hint">The actual assignment text / prompt given to students</span>
          </div>
          <textarea id="assignment-text-input" class="input" rows="6"
            placeholder="Paste the full assignment description here…"
          >${esc(S.assignmentText)}</textarea>
        </div>

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
            <button class="btn btn-surf" onclick="saveAiInstructions()">Save</button>
            <span id="ai-instr-status" class="muted" style="font-size:12px"></span>
          </div>
          <div class="case-reminder">
            <strong>Case Write-up Format:</strong>
            ① Executive Summary + Recommendations &nbsp;·&nbsp;
            ② Supporting Points &amp; Evidence &nbsp;·&nbsp;
            ③ Conclusion / Alternatives / Other Thoughts
          </div>
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
  S.assignmentText = document.getElementById('assignment-text-input')?.value?.trim() || '';
  try {
    await PUT(`/api/assignment-settings/${S.course.id}/${S.currentAssignment.id}`, {
      aiInstructions: S.aiInstructions,
      assignmentText: S.assignmentText,
    });
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
      ? `<span class="ai-badge ai-badge--${(g.aiDetection.level || 'none').toLowerCase()}">${g.aiDetection.pct ?? (g.aiDetection.score * 10)}%</span>`
      : '—';

    const statusBadge = !submitted ? '<span class="status-badge status--pending">Not Submitted</span>'
      : sub?.late ? '<span class="status-badge status--late">Late</span>'
      : g?.status === 'canvas' ? '<span class="status-badge status--canvas">Canvas</span>'
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

    const aiT    = g?.aiTotalScore      != null ? g.aiTotalScore      : '—';
    const marT   = g?.marcoTotalScore   != null ? g.marcoTotalScore   : '—';
    const mrlT   = g?.marloweTotalScore != null ? g.marloweTotalScore : '—';
    const canvS  = g?.canvasScore       != null ? `<span title="Imported from Canvas" style="color:var(--uw-purple);font-weight:600">${g.canvasScore}</span>` : '—';
    const fin    = g?.finalScore        != null ? `<strong>${g.finalScore}</strong>` : '—';

    return `<tr class="${rowClass}" id="row-${esc(st.id)}">
      <td class="col-sticky"><button class="link-btn" onclick="openStudent('${esc(st.id)}')">${esc(st.name)}</button></td>
      <td>${statusBadge} ${flagged ? '<span class="ai-badge ai-badge--flagged">⚑</span>' : ''}</td>
      <td>${aiConf}</td>
      ${scoreCols}
      <td class="score-td score-td-ai">${aiT}</td>
      <td class="score-td score-td-m1">${marT}</td>
      <td class="score-td score-td-m2">${mrlT}</td>
      <td class="score-td" style="background:#f3f0ff">${canvS}</td>
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
        <th rowspan="2" style="color:var(--uw-purple)">Canvas</th>
        <th rowspan="2">Final</th>
      </tr>
      <tr>${subHeaders}</tr>
    </thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}

/* ── Grade One-by-One Tab ───────────────────────────────────────────────────── */
let oboIndex = 0; // current student index in one-by-one view
let oboChatMessages = []; // chat messages for Marco & Marlowe discussion

function renderOneByOneTab() {
  const students = allStudents();
  if (!students.length) return '<p class="muted padded">No students loaded.</p>';
  if (!S.rubric) return '<p class="muted padded">No rubric set. Configure it in the Instructions & Rubric tab.</p>';
  if (oboIndex >= students.length) oboIndex = 0;
  const st = students[oboIndex];
  const sub = submissionFor(st.id);
  const g = S.grades[st.id];
  const submitted = sub && sub.workflow_state !== 'unsubmitted';

  const criteriaRows = S.rubric.criteria.map(c => {
    const cd = g?.criteria?.[c.id] || {};
    const aiS = cd.aiScore != null ? cd.aiScore : '—';
    const marV = cd.marcoScore != null ? cd.marcoScore : '';
    const mrlV = cd.marlowScore != null ? cd.marlowScore : '';
    const justif = cd.aiJustification || '';
    return `<div class="obo-crit-row">
      <div class="obo-crit-name">${esc(c.name)} <span class="muted">/ ${c.maxPoints}</span></div>
      <div class="obo-crit-scores">
        <div class="obo-score-cell obo-score-ai"><span class="obo-score-lbl">AI</span><span class="obo-score-val">${aiS}</span></div>
        <div class="obo-score-cell obo-score-m1"><span class="obo-score-lbl">Marco</span>
          <input class="obo-score-input" type="number" min="0" max="${c.maxPoints}" value="${marV}" placeholder="—"
            data-criterion="${esc(c.id)}" data-max="${c.maxPoints}" data-grader="marco" onchange="onOboScoreChange(this)" />
        </div>
        <div class="obo-score-cell obo-score-m2"><span class="obo-score-lbl">Marlowe</span>
          <input class="obo-score-input obo-input-m2" type="number" min="0" max="${c.maxPoints}" value="${mrlV}" placeholder="—"
            data-criterion="${esc(c.id)}" data-max="${c.maxPoints}" data-grader="marlowe" onchange="onOboScoreChange(this)" />
        </div>
      </div>
      ${justif ? `<div class="obo-crit-justif">${esc(justif)}</div>` : ''}
    </div>`;
  }).join('');

  const aiTotal = g?.aiTotalScore != null ? g.aiTotalScore : '—';
  const marcoTotal = g?.marcoTotalScore != null ? g.marcoTotalScore : '—';
  const marloweTotal = g?.marloweTotalScore != null ? g.marloweTotalScore : '—';
  const finalTotal = g?.finalScore != null ? g.finalScore : '—';

  const aiFeedback = g?.aiOverallFeedback || '';
  const userName = S.me?.username || 'You';
  const chatHtml = oboChatMessages.map(m => {
    const isMe = m.from === userName;
    const bg = isMe ? 'var(--uw-purple)' : 'var(--info)';
    return `<div class="obo-chat-msg ${isMe ? 'obo-chat-right' : 'obo-chat-left'}">
      <div class="obo-chat-avatar" style="background:${bg}">${m.from[0].toUpperCase()}</div>
      <div class="obo-chat-bubble-wrap">
        <div class="obo-chat-author">${esc(m.from)}</div>
        <div class="obo-chat-bubble">${esc(m.text)}</div>
      </div>
    </div>`;
  }).join('');

  // AI detection data
  const det = g?.aiDetection;
  const aiPct = det?.pct ?? (det?.score != null ? det.score * 10 : null);
  const aiColor = aiPct == null ? 'var(--text-muted)' : aiPct >= 80 ? '#dc2626' : aiPct >= 50 ? '#d97706' : aiPct >= 25 ? '#2563eb' : '#16a34a';
  const aiLevel = det?.level || '';
  const aiPhrases = det?.details?.aiPhrases?.matched || [];

  return `
    <div class="obo-container obo-fullpage">
      <!-- Navigation + Actions bar -->
      <div class="obo-topbar">
        <button class="btn btn-ghost" onclick="oboNavigate(-1)" ${oboIndex === 0 ? 'disabled' : ''}>← Prev</button>
        <div class="obo-nav-info">
          <strong style="font-size:15px">${esc(st.name)}</strong>
          <span class="obo-nav-counter">${oboIndex + 1} / ${students.length}</span>
          ${!submitted ? '<span class="status-badge status--pending">Not Submitted</span>' : sub?.late ? '<span class="status-badge status--late">Late</span>' : '<span class="status-badge status--submitted">Submitted</span>'}
        </div>
        <div class="obo-topbar-actions">
          <button class="btn btn-surf" id="obo-grade-ai-btn" onclick="oboGradeWithAi()">✦ Grade with AI</button>
          <button class="btn btn-ghost" onclick="oboRunAiDetect()">🔍 AI Detect</button>
          <button class="btn btn-primary" onclick="oboSaveAndNext()">Save & Next →</button>
        </div>
        <button class="btn btn-ghost" onclick="oboNavigate(1)" ${oboIndex >= students.length - 1 ? 'disabled' : ''}>Next →</button>
      </div>

      <!-- AI Detection Banner (always visible) -->
      <div class="obo-ai-banner" style="border-left-color:${aiColor}">
        <div class="obo-ai-banner-gauge" style="color:${aiColor}">
          <div class="obo-ai-banner-pct">${aiPct != null ? aiPct + '%' : '—'}</div>
          <div class="obo-ai-banner-lbl">AI Index</div>
        </div>
        <div class="obo-ai-banner-meter">
          <div class="obo-ai-banner-track"><div class="obo-ai-banner-fill" style="width:${aiPct || 0}%;background:${aiColor}"></div></div>
          ${aiLevel ? `<span class="ai-badge ai-badge--${aiLevel.toLowerCase()}">${aiLevel}</span>` : '<span class="muted" style="font-size:11px">Not analyzed yet</span>'}
        </div>
        ${aiPhrases.length ? `<div class="obo-ai-banner-phrases">${aiPhrases.slice(0, 6).map(p => `<span class="ai-detect-phrase">${esc(p)}</span>`).join(' ')}</div>` : ''}
        ${g?.flagged ? '<span class="ai-badge ai-badge--flagged" style="font-size:12px">⚑ FLAGGED</span>' : ''}
      </div>

      <div class="obo-layout">
        <!-- Left: Submission -->
        <div class="obo-panel obo-submission-panel">
          <div class="card" style="flex:1;display:flex;flex-direction:column">
            <div class="card-title">Student Submission</div>
            <div class="obo-submission-content" style="flex:1">${renderSubmissionContent(sub)}</div>
          </div>

          <!-- AI Grading Explanation (under submission) -->
          <div class="obo-ai-explain card" ${aiFeedback ? '' : 'style="display:none"'} id="obo-ai-explain">
            <div class="card-title">AI Grading Explanation</div>
            <div class="obo-ai-explain-text" id="obo-ai-explain-text">
              ${aiFeedback ? `<p style="margin-bottom:10px">${esc(aiFeedback)}</p>` : ''}
              ${g?.criteria ? S.rubric.criteria.map(c => {
                const cd = g.criteria[c.id];
                if (!cd?.aiJustification) return '';
                const sc = cd.aiScore != null ? cd.aiScore : '—';
                return `<div class="obo-ai-crit-feedback">
                  <div class="obo-ai-crit-hdr"><strong>${esc(c.name)}</strong> <span>${sc} / ${c.maxPoints}</span></div>
                  <p>${esc(cd.aiJustification)}</p>
                </div>`;
              }).join('') : ''}
            </div>
          </div>
        </div>

        <!-- Right: Scoring -->
        <div class="obo-panel obo-grading-panel">
          <!-- Criteria scores -->
          <div class="obo-criteria">${criteriaRows}</div>

          <!-- Totals -->
          <div class="obo-totals">
            <div class="obo-total-item obo-total-ai"><span>AI</span><strong>${aiTotal}</strong></div>
            <div class="obo-total-item obo-total-m1"><span>Marco</span><strong>${marcoTotal}</strong></div>
            <div class="obo-total-item obo-total-m2"><span>Marlowe</span><strong>${marloweTotal}</strong></div>
            <div class="obo-total-item obo-total-final"><span>Final</span><strong>${finalTotal}</strong></div>
          </div>

          <!-- Grading Discussion Chat -->
          <div class="obo-chat-card card">
            <div class="card-title">Grading Discussion</div>
            <div class="obo-chat-messages" id="obo-chat-messages">${chatHtml || '<p class="muted" style="text-align:center;padding:12px">Discuss this grade...</p>'}</div>
            <div class="obo-chat-input-row">
              <input class="input obo-chat-input" id="obo-chat-input" placeholder="Type a message..." onkeydown="if(event.key==='Enter')oboSendChat()" />
              <button class="btn btn-surf" onclick="oboSendChat()">Send</button>
            </div>
          </div>
        </div>
      </div>
    </div>`;
}

let _oboExtracted = false; // track if we've already extracted for this assignment

async function oboEnterGrading() {
  if (_oboExtracted) return; // already done for this assignment
  _oboExtracted = true;

  const students = allStudents();
  const subsToExtract = [];
  students.forEach(st => {
    const sub = submissionFor(st.id);
    if (!sub || sub._extractedText) return; // already has text
    if (sub.body || sub._manualText) return; // has inline text
    if (sub.attachments?.length) {
      const att = sub.attachments[0]; // extract first attachment
      subsToExtract.push({ sub, att, studentId: st.id });
    }
  });

  if (!subsToExtract.length) return;

  // Show loading overlay in the tab
  const el = document.getElementById('atab-oneByOne');
  if (!el) return;
  el.innerHTML = `<div class="obo-loading">
    <div class="obo-loading-spinner"></div>
    <div class="obo-loading-text">Loading & extracting ${subsToExtract.length} submissions...</div>
    <div class="obo-loading-sub" id="obo-loading-progress">0 / ${subsToExtract.length}</div>
  </div>`;

  let done = 0;
  for (const { sub, att, studentId } of subsToExtract) {
    try {
      const res = await POST('/api/canvas/extract-text', { url: att.url, filename: att.display_name || att.filename });
      sub._extractedText = res.text;
    } catch { /* skip failures */ }
    done++;
    const prog = document.getElementById('obo-loading-progress');
    if (prog) prog.textContent = `${done} / ${subsToExtract.length}`;
  }

  // Now run AI detection on all submissions that have text
  const progEl = document.getElementById('obo-loading-progress');
  if (progEl) progEl.textContent = 'Running AI detection...';

  for (const st of students) {
    const text = submissionText(submissionFor(st.id));
    if (!text || S.grades[st.id]?.aiDetection) continue;
    try {
      const det = await POST('/api/ai-detect', { text });
      if (!S.grades[st.id]) S.grades[st.id] = buildEmptyGrade(st.id);
      S.grades[st.id].aiDetection = det;
      S.grades[st.id].flagged = det.pct >= 80;
    } catch { /* skip */ }
  }

  // Re-render
  refreshOneByOneTab();
  toast(`Extracted ${done} submissions, AI detection complete.`, 'success');
}

function oboNavigate(dir) {
  const students = allStudents();
  oboIndex = Math.max(0, Math.min(students.length - 1, oboIndex + dir));
  oboChatMessages = []; // reset chat per student
  refreshOneByOneTab();
}

function refreshOneByOneTab() {
  const el = document.getElementById('atab-oneByOne');
  if (el) el.innerHTML = renderOneByOneTab();
}

function onOboScoreChange(input) {
  const students = allStudents();
  const st = students[oboIndex];
  if (!st) return;
  const criterionId = input.dataset.criterion;
  const max = Number(input.dataset.max);
  const grader = input.dataset.grader;
  let val = input.value.trim() === '' ? null : Number(input.value);
  if (val !== null) val = Math.max(0, Math.min(max, val));

  if (!S.grades[st.id]) S.grades[st.id] = buildEmptyGrade(st.id);
  if (!S.grades[st.id].criteria) S.grades[st.id].criteria = {};
  if (!S.grades[st.id].criteria[criterionId]) S.grades[st.id].criteria[criterionId] = {};

  if (grader === 'marlowe') S.grades[st.id].criteria[criterionId].marlowScore = val;
  else S.grades[st.id].criteria[criterionId].marcoScore = val;

  recalcTotals(st.id);
  S.grades[st.id].status = 'reviewed';

  // Update totals display without full re-render
  const totalsEl = document.querySelector('.obo-totals');
  if (totalsEl) {
    const g = S.grades[st.id];
    totalsEl.innerHTML = `
      <div class="obo-total-item obo-total-ai"><span>AI</span><strong>${g?.aiTotalScore ?? '—'}</strong></div>
      <div class="obo-total-item obo-total-m1"><span>Marco</span><strong>${g?.marcoTotalScore ?? '—'}</strong></div>
      <div class="obo-total-item obo-total-m2"><span>Marlowe</span><strong>${g?.marloweTotalScore ?? '—'}</strong></div>
      <div class="obo-total-item obo-total-final"><span>Final</span><strong>${g?.finalScore ?? '—'}</strong></div>`;
  }
}

function renderAiDetectBox(g) {
  const det = g?.aiDetection;
  if (!det || det.level === 'TOO SHORT') return '';
  const pct = det.pct ?? (det.score * 10);
  const color = pct >= 80 ? 'var(--danger)' : pct >= 50 ? 'var(--warn)' : pct >= 25 ? 'var(--info)' : 'var(--success)';
  const levelLabel = det.level || 'MINIMAL';
  const matched = det.details?.aiPhrases?.matched || [];
  return `<div class="ai-detect-box" style="border-left-color:${color}">
    <div class="ai-detect-header">
      <div class="ai-detect-gauge">
        <div class="ai-detect-pct" style="color:${color}">${pct}%</div>
        <div class="ai-detect-label">AI Likelihood</div>
      </div>
      <div class="ai-detect-meter">
        <div class="ai-detect-meter-track"><div class="ai-detect-meter-fill" style="width:${pct}%;background:${color}"></div></div>
        <span class="ai-badge ai-badge--${levelLabel.toLowerCase()}">${levelLabel}</span>
      </div>
    </div>
    ${matched.length ? `<div class="ai-detect-phrases"><span class="muted" style="font-size:10px;font-weight:700">DETECTED PHRASES:</span> ${matched.map(p => `<span class="ai-detect-phrase">${esc(p)}</span>`).join(' ')}</div>` : ''}
    <div class="muted" style="font-size:11px;margin-top:4px">${esc(det.message || '')}</div>
  </div>`;
}

async function oboRunAiDetect() {
  const students = allStudents();
  const st = students[oboIndex];
  if (!st) return;
  const sub = submissionFor(st.id);
  const text = submissionText(sub);
  if (!text) { toast('No submission text to analyze.', 'warn'); return; }
  toast('Analyzing for AI patterns...');
  try {
    const det = await POST('/api/ai-detect', { text });
    if (!S.grades[st.id]) S.grades[st.id] = buildEmptyGrade(st.id);
    S.grades[st.id].aiDetection = det;
    S.grades[st.id].flagged = det.pct >= 80;
    await saveGrade(st.id);
    refreshOneByOneTab();
    toast(`AI detection: ${det.pct}% likelihood (${det.level})`, det.pct >= 80 ? 'error' : 'success');
  } catch (e) { toast('Detection failed: ' + e.message, 'error'); }
}

async function oboGradeWithAi() {
  const students = allStudents();
  const st = students[oboIndex];
  if (!st || !S.rubric) return;
  if (!S.health?.claude) { toast('Claude not configured.', 'error'); return; }
  const sub = submissionFor(st.id);
  const btn = document.getElementById('obo-grade-ai-btn');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Grading...'; }
  try {
    const res = await POST('/api/grade/single', {
      text: submissionText(sub) || '', rubric: S.rubric,
      studentName: st.name,
      hasAiCitation: sub?._hasAiCitation || false,
      aiInstructions: S.aiInstructions,
      isCaseWriteup: classifyAssignment(S.currentAssignment) === 'Case Discussions',
    });
    applyAiGrade(st.id, res.grade, res.aiDetection, res.flagged);
    await saveGrade(st.id);
    refreshOneByOneTab();
    toast('AI grading complete!', 'success');
  } catch (e) { toast('Grading error: ' + e.message, 'error'); }
  finally { if (btn) { btn.disabled = false; btn.textContent = '✦ Grade with AI'; } }
}

async function oboSaveGrade() {
  const students = allStudents();
  const st = students[oboIndex];
  if (!st) return;
  if (!S.grades[st.id]) S.grades[st.id] = buildEmptyGrade(st.id);
  S.grades[st.id].status = 'reviewed';
  await saveGrade(st.id);
  toast('Grade saved!', 'success');
}

async function oboSaveAndNext() {
  await oboSaveGrade();
  const students = allStudents();
  if (oboIndex < students.length - 1) {
    oboIndex++;
    oboChatMessages = [];
    refreshOneByOneTab();
  } else {
    toast('All students graded!', 'success');
  }
}

function oboSendChat() {
  const input = document.getElementById('obo-chat-input');
  const text = input?.value?.trim();
  if (!text) return;
  const userName = S.me?.username || 'You';
  oboChatMessages.push({ from: userName, text, time: new Date().toLocaleTimeString() });
  input.value = '';
  renderOboChatMessages();
}

function renderOboChatMessages() {
  const container = document.getElementById('obo-chat-messages');
  if (!container) return;
  const userName = S.me?.username || 'You';
  container.innerHTML = oboChatMessages.map(m => {
    const isMe = m.from === userName;
    const bg = isMe ? 'var(--uw-purple)' : 'var(--info)';
    return `<div class="obo-chat-msg ${isMe ? 'obo-chat-right' : 'obo-chat-left'}">
      <div class="obo-chat-avatar" style="background:${bg}">${m.from[0].toUpperCase()}</div>
      <div class="obo-chat-bubble-wrap">
        <div class="obo-chat-author">${esc(m.from)}</div>
        <div class="obo-chat-bubble">${esc(m.text)}</div>
      </div>
    </div>`;
  }).join('');
  container.scrollTop = container.scrollHeight;
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
  // Final priority: Marlowe → Marco → AI → Canvas (imported)
  g.finalScore = g.marloweTotalScore != null ? g.marloweTotalScore
               : g.marcoTotalScore   != null ? g.marcoTotalScore
               : g.aiTotalScore      != null ? g.aiTotalScore
               : g.canvasScore       != null ? g.canvasScore
               : null;
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
      body: JSON.stringify({ submissions, rubric: S.rubric, aiInstructions: S.aiInstructions, isCaseWriteup: classifyAssignment(S.currentAssignment) === 'Case Discussions' }),
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
  document.getElementById('modal-submission-text').innerHTML = renderSubmissionContent(sub);

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
      isCaseWriteup: classifyAssignment(S.currentAssignment) === 'Case Discussions',
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

  // Get all chapters in the bank
  const chapters = [...new Set(qs.map(q => (typeof q === 'object' && q.chapter) ? q.chapter : 'Uncategorized'))].sort();

  // Render bank grouped by chapter
  const bankByChapter = {};
  qs.forEach((q, i) => {
    const ch = (typeof q === 'object' && q.chapter) ? q.chapter : 'Uncategorized';
    if (!bankByChapter[ch]) bankByChapter[ch] = [];
    bankByChapter[ch].push({ q, i });
  });

  const bankHtml = qs.length ? Object.entries(bankByChapter).map(([ch, items]) => `
    <div class="chapter-block">
      <div class="chapter-heading">${esc(ch)} <span class="muted">(${items.length})</span></div>
      ${items.map(({ q, i }) => {
        const text = qText(q); const answer = qAnswer(q); const choices = qChoices(q);
        return `<div class="quiz-q-item">
          <span class="quiz-q-num">${i + 1}.</span>
          <div style="flex:1">
            <div class="quiz-q-text">${esc(text)}</div>
            ${choices.length ? `<div class="quiz-choices">${choices.map(c => `<div class="quiz-choice">${esc(c)}</div>`).join('')}</div>` : ''}
            ${answer ? `
              <button class="btn btn-surf-sec" style="font-size:11px;padding:2px 8px;margin-top:4px" onclick="toggleAnswer(${i})">Show / Hide Answer</button>
              <div id="q-answer-${i}" class="quiz-answer" style="display:none"><strong>Answer:</strong> ${esc(answer)}</div>` : ''}
          </div>
          <button class="btn btn-surf-sec" style="font-size:11px;padding:3px 8px;flex-shrink:0" onclick="deleteQuestion(${i})">✕</button>
        </div>`;
      }).join('')}
    </div>`).join('')
  : '<p class="muted">No questions yet. Upload a test bank file to get started.</p>';

  const chapterOptions = chapters.map(c => `<option value="${esc(c)}">${esc(c)} (${bankByChapter[c]?.length || 0} questions)</option>`).join('');

  root.innerHTML = `
    <div class="page-title">Quiz Question Bank
      <div class="page-actions">
        <button class="btn btn-ghost btn-danger" onclick="clearQuizBank()">Clear Bank</button>
      </div>
    </div>

    <div class="two-col-grid" style="align-items:start">

      <!-- ── Paste Box (Claude parse) ── -->
      <div class="card">
        <div class="card-title">✦ Paste Questions — Claude will parse them</div>
        <div class="field-group">
          <label>Chapter / Label for this batch</label>
          <input id="paste-chapter" type="text" class="input" placeholder="e.g. Chapter 5 or Midterm" />
        </div>
        <div class="field-group">
          <label>Paste your questions below (any format — numbered, Q: style, Word copy-paste…)</label>
          <textarea id="paste-questions-text" class="input" rows="8"
            placeholder="1. What is marketing?&#10;a) Selling products&#10;b) Understanding customer needs&#10;c) Making ads&#10;d) All of the above&#10;Answer: B&#10;&#10;2. What is a value proposition?..."></textarea>
        </div>
        <div style="display:flex;gap:8px;align-items:center;margin-top:8px">
          <button class="btn btn-surf" onclick="parseAndSavePasted()">✦ Parse &amp; Save with Claude</button>
          <span id="paste-status" class="muted" style="font-size:12px"></span>
        </div>
      </div>

      <!-- ── Upload Panel ── -->
      <div class="card">
        <div class="card-title">⬆ Upload File</div>
        <div class="field-group">
          <label>Chapter / Label <span class="muted">(e.g. "Chapter 3" or "Midterm")</span></label>
          <input id="upload-chapter" type="text" class="input" placeholder="Chapter 1" />
        </div>
        <label class="upload-drop-area" id="quiz-drop-zone"
          ondragover="event.preventDefault();this.classList.add('drag-over')"
          ondragleave="this.classList.remove('drag-over')"
          ondrop="event.preventDefault();this.classList.remove('drag-over');handleQuizDrop(event)">
          <div class="upload-drop-icon">📂</div>
          <div>Click or drag &amp; drop files here</div>
          <div class="muted" style="font-size:11px;margin-top:4px">.docx · .doc · .txt · .csv · .json · .md — multiple files OK</div>
          <input id="quiz-file-input" type="file" accept=".txt,.csv,.json,.md,.doc,.docx" multiple style="display:none" onchange="uploadQuizFile(this)" />
        </label>
        <div style="margin-top:10px;font-size:12px;color:var(--text-muted)">
          Bank: <strong>${qs.length}</strong> question${qs.length !== 1 ? 's' : ''}
          across <strong>${chapters.length}</strong> chapter${chapters.length !== 1 ? 's' : ''}
        </div>
      </div>

      <!-- ── Create Quiz on Canvas ── -->
      <div class="card create-quiz-card">
        <div class="card-title">🎓 Create Quiz on Canvas</div>
        <div class="create-quiz-grid">
          <div class="field-group">
            <label>Quiz Title</label>
            <input id="cq-title" type="text" class="input" placeholder="Quiz – Chapters 2–3" />
          </div>
          <div class="field-group">
            <label>Time Limit (min)</label>
            <input id="cq-time" type="number" class="input" min="1" placeholder="none" />
          </div>
          <div class="field-group">
            <label>Attempts</label>
            <input id="cq-attempts" type="number" class="input" value="1" min="1" />
          </div>
          <div class="field-group">
            <label>Pts per question</label>
            <input id="cq-pts" type="number" class="input" value="1" min="1" />
          </div>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px">
          <div class="field-group">
            <label>Chapter(s) to pull from</label>
            <select id="cq-chapter" class="input" onchange="updateCqCount()">
              <option value="__all__">All chapters</option>
              ${chapterOptions}
            </select>
          </div>
          <div class="field-group">
            <label>Number of questions <span id="cq-avail" class="muted"></span></label>
            <input id="cq-count" type="number" class="input" value="5" min="1" oninput="updateCqCount()" />
          </div>
        </div>

        <div class="field-group">
          <label>Description (optional)</label>
          <textarea id="cq-desc" class="input" rows="2" placeholder="Instructions for students…"></textarea>
        </div>

        <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:8px">
          <button class="btn btn-surf" onclick="createCanvasQuiz(false)">Create as Draft</button>
          <button class="btn btn-primary" onclick="createCanvasQuiz(true)">Create &amp; Publish</button>
          <span id="cq-status" class="muted" style="font-size:12px"></span>
        </div>
        <div id="cq-result" style="display:none;margin-top:12px" class="quiz-result-banner"></div>
      </div>
    </div>

    <!-- ── AI Suggest ── -->
    <div class="card" style="margin-bottom:12px">
      <div class="card-title">✦ AI Question Suggestions</div>
      <div style="display:grid;grid-template-columns:1fr 1fr auto auto;gap:12px;align-items:end">
        <div class="field-group" style="margin:0">
          <label>Topic / Focus</label>
          <input id="quiz-topic" type="text" class="input" placeholder="e.g. Customer segmentation" />
        </div>
        <div class="field-group" style="margin:0">
          <label>Context (optional — paste notes)</label>
          <input id="quiz-context" type="text" class="input" placeholder="Paste key topics from lecture…" />
        </div>
        <div class="field-group" style="margin:0">
          <label># Questions</label>
          <input id="quiz-count" type="number" class="input" value="5" min="1" max="20" style="max-width:70px" />
        </div>
        <button class="btn btn-surf" style="white-space:nowrap" onclick="suggestQuizQuestions()">Suggest</button>
      </div>
    </div>

    <div id="quiz-suggestions-wrap" style="display:none" class="card" style="margin-bottom:12px">
      <div class="card-title">AI Suggested Questions</div>
      <div id="quiz-suggestions"></div>
    </div>

    <!-- ── Bank Browser ── -->
    <div class="card">
      <div class="card-title">
        Bank — ${qs.length} question${qs.length !== 1 ? 's' : ''}
        <span class="card-title-hint">${chapters.length} chapter${chapters.length !== 1 ? 's' : ''}</span>
      </div>
      <div style="max-height:520px;overflow-y:auto">${bankHtml}</div>
    </div>`;

  // Set initial available count
  updateCqCount();
}

function updateCqCount() {
  const qs = S.quizBank?.questions || [];
  const chapter = document.getElementById('cq-chapter')?.value;
  const filtered = chapter === '__all__' || !chapter
    ? qs
    : qs.filter(q => (typeof q === 'object' && q.chapter) ? q.chapter === chapter : chapter === 'Uncategorized');
  const avail = document.getElementById('cq-avail');
  if (avail) avail.textContent = `(${filtered.length} available)`;
  const countInput = document.getElementById('cq-count');
  if (countInput) countInput.max = filtered.length;
}

async function createCanvasQuiz(publish) {
  if (!S.course) { toast('Select a course first.', 'warn'); return; }

  const title    = document.getElementById('cq-title')?.value?.trim();
  const desc     = document.getElementById('cq-desc')?.value?.trim();
  const timeLimit = Number(document.getElementById('cq-time')?.value) || null;
  const attempts  = Number(document.getElementById('cq-attempts')?.value) || 1;
  const ptsEach   = Number(document.getElementById('cq-pts')?.value) || 1;
  const chapter   = document.getElementById('cq-chapter')?.value;
  const count     = Number(document.getElementById('cq-count')?.value) || 5;

  if (!title) { toast('Enter a quiz title.', 'warn'); return; }

  const qs = S.quizBank?.questions || [];
  const pool = (chapter === '__all__' || !chapter)
    ? qs
    : qs.filter(q => (typeof q === 'object' && q.chapter) ? q.chapter === chapter : chapter === 'Uncategorized');

  if (!pool.length) { toast('No questions in selected chapter.', 'warn'); return; }

  // Randomly pick `count` questions from pool
  const shuffled = [...pool].sort(() => Math.random() - 0.5);
  const selected = shuffled.slice(0, Math.min(count, shuffled.length))
    .map(q => typeof q === 'string' ? { question: q, answer: '', choices: [], points: ptsEach } : { ...q, points: ptsEach });

  const statusEl = document.getElementById('cq-status');
  const resultEl = document.getElementById('cq-result');
  if (statusEl) statusEl.textContent = `Creating quiz with ${selected.length} questions…`;

  try {
    const res = await POST(`/api/canvas/create-quiz/${S.course.id}`, {
      title, description: desc, timeLimit, allowedAttempts: attempts,
      pointsPossible: selected.length * ptsEach,
      questions: selected, publish,
    });
    if (resultEl) {
      resultEl.style.display = 'block';
      resultEl.className = 'quiz-result-banner quiz-result-success';
      resultEl.innerHTML = `✓ Quiz created with ${res.questionsAdded} questions. ${publish ? '<strong>Published!</strong>' : 'Saved as draft.'}<br>
        <a href="${esc(res.quizUrl)}" target="_blank" class="quiz-result-link">Open in Canvas ↗</a>`;
    }
    if (statusEl) statusEl.textContent = '';
    toast(`Quiz "${title}" created on Canvas!`, 'success');
  } catch (e) {
    if (resultEl) { resultEl.style.display = 'block'; resultEl.className = 'quiz-result-banner quiz-result-error'; resultEl.textContent = 'Error: ' + e.message; }
    toast('Failed: ' + e.message, 'error');
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
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  let current = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Question patterns: "Q:", "Question:", "1.", "1)", "1 " at start of line
    const qMatch = line.match(/^(?:Q\s*:|Question\s*:|\d+[\.\)\s]\s+)\s*(.+)/i);
    // Answer patterns: "A:", "Answer:", "Correct Answer:", "ANSWER:", "Ans:"
    const aMatch = line.match(/^(?:A\s*:|Ans(?:wer)?\s*:|Correct(?:\s+Answer)?\s*:|ANSWER\s*:)\s*(.+)/i);
    // Multiple choice: a) b) c) d)  or  A. B. C. D.
    const choiceMatch = line.match(/^([a-eA-E][\.\)]\s*)(.+)/);
    // Standalone answer indicator: just "A", "B", "C", "D" on its own line after choices
    const singleLetter = line.match(/^([A-Ea-e])\.?\s*$/);

    if (qMatch) {
      if (current) questions.push(current);
      current = { question: qMatch[1].trim(), answer: '', choices: [] };
    } else if (aMatch) {
      if (current) current.answer = aMatch[1].trim();
    } else if (choiceMatch && current) {
      current.choices.push(choiceMatch[1].trim() + choiceMatch[2].trim());
    } else if (singleLetter && current && current.choices.length > 0) {
      // A single letter after choices = the answer
      current.answer = singleLetter[1].toUpperCase();
    } else if (line.length > 10 && !current && !choiceMatch) {
      // Plain paragraph with no prefix = treat as a question (common in Word docs)
      current = { question: line, answer: '', choices: [] };
    } else if (current && !choiceMatch && !aMatch && line.length > 3) {
      // Could be a continuation of the question text
      if (!current.choices.length && !current.answer) {
        current.question += ' ' + line;
      }
    }
  }
  if (current) questions.push(current);
  return questions.filter(q => q.question.length > 3);
}

async function uploadQuizFile(input) {
  const files = Array.from(input.files); if (!files.length) return;
  const chapter = document.getElementById('upload-chapter')?.value?.trim() || 'Uncategorized';
  let totalImported = 0, totalWithAnswers = 0, errors = [], rawTexts = [];
  for (const file of files) {
    const fd = new FormData(); fd.append('file', file);
    try {
      const resp = await fetch('/api/quiz-bank/upload', { method: 'POST', body: fd });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || `Server error ${resp.status}`);
      if (!data.text || !data.text.trim()) throw new Error('File appears empty — no text could be extracted.');
      const parsed = parseQuizFile(data.text).map(q =>
        typeof q === 'string' ? { question: q, answer: '', choices: [], chapter }
                              : { ...q, chapter: q.chapter || chapter }
      );
      if (parsed.length === 0) {
        // Save raw text for display so user can diagnose format issues
        rawTexts.push({ name: file.name, text: data.text });
      } else {
        S.quizBank.questions = [...(S.quizBank.questions || []), ...parsed];
        totalImported += parsed.length;
        totalWithAnswers += parsed.filter(q => q.answer).length;
      }
    } catch (e) { errors.push(`${file.name}: ${e.message}`); }
  }
  if (totalImported) await PUT('/api/quiz-bank', S.quizBank);

  if (errors.length) {
    toast('Upload error: ' + errors.join('; '), 'error');
  } else if (rawTexts.length) {
    // 0 questions parsed — show raw extracted text in the view for diagnosis
    showView('quiz');
    const preview = rawTexts[0].text.slice(0, 600).replace(/</g, '&lt;');
    const el = document.getElementById('view-root');
    if (el) el.insertAdjacentHTML('afterbegin', `
      <div class="card" style="border:2px solid var(--warn);margin-bottom:16px">
        <div class="card-title" style="color:var(--warn)">⚠ 0 questions parsed from "${rawTexts[0].name}"</div>
        <p style="font-size:12px;margin-bottom:8px">The file was uploaded successfully but no questions were recognised.
        The parser looks for lines starting with <code>1.</code> / <code>Q:</code> / <code>Question:</code> and answers starting with <code>A:</code> / <code>Answer:</code> / <code>ANSWER:</code>.</p>
        <div style="font-size:11px;background:var(--bg);border:1px solid var(--border);padding:10px;border-radius:6px;white-space:pre-wrap;max-height:200px;overflow-y:auto">${preview}…</div>
        <p style="font-size:11px;color:var(--text-muted);margin-top:8px">Try reformatting your Word doc so each question starts with a number (e.g. <em>1. What is…</em>) and each answer with <em>Answer: B</em>.</p>
      </div>`);
    return;
  } else {
    toast(`Imported ${totalImported} questions (${totalWithAnswers} with answers) into "${chapter}".`, 'success');
  }
  showView('quiz');
  input.value = '';
}

async function handleQuizDrop(event) {
  const fakeInput = { files: event.dataTransfer.files, value: '' };
  await uploadQuizFile(fakeInput);
}

async function parseAndSavePasted() {
  const text    = document.getElementById('paste-questions-text')?.value?.trim();
  const chapter = document.getElementById('paste-chapter')?.value?.trim() || 'Pasted Questions';
  if (!text) { toast('Paste some questions first.', 'warn'); return; }

  const statusEl = document.getElementById('paste-status');
  if (statusEl) statusEl.textContent = 'Parsing with Claude…';

  try {
    const res  = await POST('/api/quiz-bank/parse-text', { text });
    const qs   = (res.questions || []).map(q => ({ ...q, chapter }));
    if (!qs.length) { toast('Claude found 0 questions in that text.', 'warn'); if (statusEl) statusEl.textContent = ''; return; }

    S.quizBank.questions = [...(S.quizBank.questions || []), ...qs];
    await PUT('/api/quiz-bank', S.quizBank);

    toast(`Saved ${qs.length} questions to "${chapter}".`, 'success');
    if (statusEl) statusEl.textContent = '';
    // Clear the textarea after successful save
    const ta = document.getElementById('paste-questions-text');
    if (ta) ta.value = '';
    showView('quiz');
  } catch (e) {
    toast('Parse failed: ' + e.message, 'error');
    if (statusEl) statusEl.textContent = '';
  }
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

/* ── Assignment Chat / Notes ─────────────────────────────────────────────────── */
let _chatPollTimer = null;
let _chatComments  = [];

function renderChatTabHtml() {
  return `<div class="chat-wrap" id="chat-wrap">
    <div class="chat-messages" id="chat-messages"><p class="muted" style="padding:12px">Loading…</p></div>
    <div class="chat-input-row">
      <input id="chat-input" class="input chat-input" type="text" placeholder="Add a note… (Enter to send)"
        onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();sendComment();}" />
      <button class="btn btn-primary chat-send" onclick="sendComment()">Send</button>
    </div>
  </div>`;
}

function authorColor(name) {
  const n = (name || '').toLowerCase();
  if (n === 'marco')   return '#4B2E83';  // UW purple
  if (n === 'marlowe') return '#16a34a';  // green
  // cycle through a few colors for others
  const colors = ['#2563eb','#d97706','#dc2626','#0891b2'];
  let h = 0; for (let c of name) h = (h * 31 + c.charCodeAt(0)) & 0xffff;
  return colors[h % colors.length];
}

function renderChatMessages(comments) {
  const me = S.me?.username || '';
  if (!comments.length) return '<p class="muted" style="padding:16px;text-align:center">No notes yet. Be the first to add one.</p>';
  return comments.map(c => {
    const isMe = c.author === me;
    const color = authorColor(c.author);
    const time  = new Date(c.ts).toLocaleString('en-US', { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' });
    const initial = (c.author || '?')[0].toUpperCase();
    return `<div class="chat-msg ${isMe ? 'chat-msg-me' : 'chat-msg-them'}">
      ${!isMe ? `<div class="chat-avatar" style="background:${color}" title="${esc(c.author)}">${initial}</div>` : ''}
      <div class="chat-bubble-wrap">
        ${!isMe ? `<div class="chat-author" style="color:${color}">${esc(c.author)}</div>` : ''}
        <div class="chat-bubble ${isMe ? 'chat-bubble-me' : 'chat-bubble-them'}" style="${isMe ? `background:${color}` : ''}">
          ${esc(c.text)}
        </div>
        <div class="chat-time">${time}</div>
      </div>
      ${isMe ? `<div class="chat-avatar chat-avatar-me" style="background:${color}">${initial}</div>` : ''}
    </div>`;
  }).join('');
}

async function loadComments() {
  if (!S.course || !S.currentAssignment) return;
  try {
    _chatComments = await GET(`/api/comments/${S.course.id}/${S.currentAssignment.id}`);
  } catch { _chatComments = []; }
  const el = document.getElementById('chat-messages');
  if (el) {
    el.innerHTML = renderChatMessages(_chatComments);
    el.scrollTop = el.scrollHeight;
  }
  // Poll every 12 seconds
  stopChatPoll();
  _chatPollTimer = setInterval(loadComments, 12000);
}

function stopChatPoll() {
  if (_chatPollTimer) { clearInterval(_chatPollTimer); _chatPollTimer = null; }
}

async function sendComment() {
  const input = document.getElementById('chat-input');
  const text = input?.value?.trim();
  if (!text || !S.course || !S.currentAssignment) return;
  input.value = '';
  input.disabled = true;
  try {
    const comment = await POST(`/api/comments/${S.course.id}/${S.currentAssignment.id}`, { text });
    _chatComments.push(comment);
    const el = document.getElementById('chat-messages');
    if (el) { el.innerHTML = renderChatMessages(_chatComments); el.scrollTop = el.scrollHeight; }
  } catch (e) { toast('Failed to send: ' + e.message, 'error'); input.value = text; }
  input.disabled = false;
  input.focus();
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
      const res = await POST('/api/grade/single', { text, rubric: S.rubric, studentName: name, hasAiCitation, aiInstructions: S.aiInstructions, isCaseWriteup: classifyAssignment(S.currentAssignment) === 'Case Discussions' });
      applyAiGrade(id, res.grade, res.aiDetection, res.flagged);
      await saveGrade(id);
      toast(`${name} graded!`, 'success');
    } catch (e) { toast('Grading failed: ' + e.message, 'error'); }
  }
  renderManualView();
}

/* ── Canvas Grade Sync ───────────────────────────────────────────────────────── */
document.getElementById('btn-sync-canvas').addEventListener('click', () => syncCanvasGrades(false));

async function syncCanvasGrades(silent = false) {
  if (!S.course) return;
  if (!silent) toast('Syncing grades from Canvas…');
  try {
    const canvasScores = await GET(`/api/canvas/course-submissions/${S.course.id}`);
    const cid = S.course.id;

    // Merge into allGrades + persist each assignment's grades to store.json
    const savePromises = [];
    Object.entries(canvasScores).forEach(([aid, students]) => {
      if (!S.allGrades[aid]) S.allGrades[aid] = {};
      let changed = false;
      Object.entries(students).forEach(([uid, score]) => {
        if (score == null) return;
        if (!S.allGrades[aid][uid]) {
          S.allGrades[aid][uid] = { status: 'canvas', canvasScore: score, finalScore: score };
          changed = true;
        } else {
          S.allGrades[aid][uid].canvasScore = score;
          if (S.allGrades[aid][uid].finalScore == null) {
            S.allGrades[aid][uid].finalScore = score;
            changed = true;
          }
        }
      });
      // Persist to server so grades survive page refresh
      if (changed) {
        Object.entries(students).forEach(([uid, score]) => {
          if (score == null) return;
          savePromises.push(
            PUT(`/api/grades/${cid}/${aid}/${uid}`, S.allGrades[aid][uid]).catch(() => {})
          );
        });
      }
    });
    await Promise.all(savePromises);

    const count = Object.values(canvasScores).reduce((n, s) => n + Object.keys(s).length, 0);
    if (!silent) toast(`Canvas sync complete — ${count} scores imported.`, 'success');
    // Refresh current view
    const v = currentView;
    if (v === 'gradebook') renderGradeBook();
    else if (v === 'ledger')  _renderLedgerHtml(document.getElementById('view-root'), canvasScores);
    else if (v === 'teams')   renderTeamsView();
    else if (v === 'overview') renderOverview(document.getElementById('view-root'));
  } catch (e) {
    if (!silent) toast('Sync failed: ' + e.message, 'error');
    else console.warn('Canvas auto-sync failed:', e.message);
  }
}

/* ── Export ─────────────────────────────────────────────────────────────────── */
document.getElementById('btn-export').addEventListener('click', () => {
  if (!S.course || !S.currentAssignment) { toast('Open an assignment first.', 'warn'); return; }
  window.location.href = `/api/grades/${S.course.id}/${S.currentAssignment.id}/export.csv`;
});

/* ── Helpers ─────────────────────────────────────────────────────────────────── */
function allStudents() {
  const canvas = S.students.map(e => ({
    id: String(e.id || e.user_id || e.user?.id),
    name: e.name || e.user?.name || e.user?.sortable_name || `Student ${e.id || e.user_id}`,
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
  // Prioritize extracted text (from attachments), then manual, then body, then url
  return sub._extractedText || sub._manualText || sub.body || sub.url || '';
}

function submissionHasAttachments(sub) {
  return sub?.attachments?.length > 0 || sub?.url;
}

function renderSubmissionContent(sub) {
  if (!sub) return '<p class="muted">(No submission)</p>';
  let html = '';

  // Show URL submission
  if (sub.url) {
    html += `<div class="sub-attachment-item">
      <span class="sub-att-icon">🔗</span>
      <a href="${esc(sub.url)}" target="_blank" class="sub-att-name">${esc(sub.url)}</a>
    </div>`;
  }

  // Show attachments as file badges with auto-extract
  if (sub.attachments?.length) {
    html += '<div class="sub-attachments">';
    sub.attachments.forEach(att => {
      const name = att.display_name || att.filename || 'file';
      const ext = name.split('.').pop().toLowerCase();
      const isImage = ['jpg','jpeg','png','gif','webp','bmp'].includes(ext);
      const proxyUrl = `/api/canvas/file-proxy?url=${encodeURIComponent(att.url)}`;
      const icon = ext === 'pdf' ? '📄' : isImage ? '🖼' : ['doc','docx'].includes(ext) ? '📝' : '📎';
      const hasText = !!sub._extractedText;

      html += `<div class="sub-attachment-item">
        <span class="sub-att-icon">${icon}</span>
        <span class="sub-att-name">${esc(name)}</span>
        <span class="muted" style="font-size:11px">${att.size ? (att.size / 1024).toFixed(0) + ' KB' : ''}</span>
        ${!hasText ? `<button class="btn btn-surf" style="font-size:11px;padding:3px 10px" onclick="extractAttachmentText('${esc(att.url)}','${esc(name)}','${esc(String(sub.user_id))}')">Extract & Show Text</button>` : '<span class="status-badge status--graded">Text Extracted</span>'}
        <a href="${esc(proxyUrl)}" target="_blank" class="btn btn-ghost" style="font-size:11px;padding:2px 8px">Download</a>
      </div>`;

      // Inline preview for images only
      if (isImage) {
        html += `<div class="sub-att-preview"><img src="${esc(proxyUrl)}" alt="${esc(name)}" style="max-width:100%;max-height:300px;border-radius:var(--radius)" /></div>`;
      }
    });
    html += '</div>';

    // If attachments exist but no text extracted yet, show prompt
    if (!sub._extractedText && !sub._manualText && !sub.body) {
      html += '<p class="muted" style="margin-top:8px;font-style:italic">Click "Extract & Show Text" above to pull the document content for viewing and AI grading.</p>';
    }
  }

  // Show body text (extracted or original)
  const bodyText = sub._extractedText || sub._manualText || sub.body || '';
  if (bodyText) {
    html += `<div class="submission-text" style="max-height:500px;margin-top:8px">${esc(bodyText)}</div>`;
  }

  if (!html) html = '<p class="muted">(No submission text or attachments)</p>';
  return html;
}

async function extractAttachmentText(url, filename, studentId) {
  toast('Extracting text from ' + filename + '...');
  try {
    const res = await POST('/api/canvas/extract-text', { url, filename });
    // Store extracted text on the submission
    const sub = S.submissions.find(s => String(s.user_id) === String(studentId));
    if (sub) {
      sub._extractedText = res.text;
    }
    toast('Text extracted! (' + res.text.length + ' chars)', 'success');
    // Refresh current view
    showView('assignment');
  } catch (e) { toast('Extract failed: ' + e.message, 'error'); }
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
