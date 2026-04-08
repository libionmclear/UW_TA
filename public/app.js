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
  _syncing: false,    // true while Canvas sync is running
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

/* ── Student Avatar Helper ─────────────────────────────────────────────────── */
function studentAvatar(st, size = 24) {
  const id = typeof st === 'string' ? st : st?.id;
  const name = typeof st === 'string' ? st : (st?.name || '?');
  const initial = (name[0] || '?').toUpperCase();
  const photoUrl = `/api/student-photo/${esc(id)}`;
  return `<img class="stu-avatar" src="${photoUrl}" alt="" style="width:${size}px;height:${size}px"
    onerror="this.style.display='none';this.nextElementSibling.style.display='grid'" /><span class="stu-avatar-fallback" style="width:${size}px;height:${size}px;font-size:${Math.round(size*0.45)}px;display:none">${initial}</span>`;
}

/* ── Photo Hover Enlarge ───────────────────────────────────────────────────── */
let _hoverTip = null;
document.addEventListener('mouseover', e => {
  const img = e.target.closest('img.stu-avatar, img.notif-photo, img.hdr-user-photo, img.sc-photo-img, img.prof-photo');
  if (!img || !img.src || img.naturalWidth === 0) return;
  if (_hoverTip) return;
  _hoverTip = document.createElement('div');
  _hoverTip.className = 'photo-hover-tip';
  _hoverTip.innerHTML = `<img src="${img.src}" />`;
  document.body.appendChild(_hoverTip);
  const r = img.getBoundingClientRect();
  _hoverTip.style.left = Math.min(r.left, window.innerWidth - 160) + 'px';
  _hoverTip.style.top = (r.bottom + 6) + 'px';
});
document.addEventListener('mouseout', e => {
  const img = e.target.closest('img.stu-avatar, img.notif-photo, img.hdr-user-photo, img.sc-photo-img, img.prof-photo');
  if (img && _hoverTip) { _hoverTip.remove(); _hoverTip = null; }
});

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
  const root = document.getElementById('view-root');
  if (root) root.innerHTML = `<div class="loading-splash"><div class="loading-bounce"></div><div class="loading-text">Grabbing Data<span class="loading-dots"></span></div><div class="muted">Loading course, assignments, students &amp; grades...</div></div>`;
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
  // QUIZZES — only "Quiz" in name, or specific "Chapter X-Y" quiz-style patterns
  { key: 'Quizzes', patterns: [
    /quiz/i,
    /chapter\s*\d{1,2}\s*[-–]\s*\d{1,2}/i,   // "Chapter 15-16"
  ]},
  // PRODUCT OF THE WEEK — spotlight presentations
  { key: 'Product of the Week', patterns: [
    /product of the week/i,
    /potw/i,
    /spotlight/i,
  ]},
  // COURSE EVALUATION — standalone
  { key: 'Course Evaluation', patterns: [
    /course eval/i,
    /submit.*eval/i,
    /evaluation/i,
  ]},
  // PANOPTO / VIDEO VIEWS — "Week X" assignments (video watch requirements)
  { key: 'Panopto Video Views', patterns: [
    /^week \d/i,
    /recorded lecture/i,
    /panopto/i,
    /video view/i,
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
  { key: 'Cases', patterns: [
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
    /crossing the chasm/i,
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
  'Quizzes':              '✎',
  'AI Assignments':       '✦',
  'Cases':     '◆',
  'Activities':           '▣',
  'Group Project':        '◈',
  'Final Exam':           '★',
  'Panopto Video Views':  '▶',
  'Participation':        '●',
  'Course Evaluation':    '✓',
  'Product of the Week':  '◎',
  'Other Assignments':    '○',
};

// Sidebar display order — main grading groups
const GROUP_ORDER = ['Quizzes', 'AI Assignments', 'Cases', 'Activities', 'Group Project', 'Final Exam'];

// Groups that go in the "Other Assignments" sidebar box
const OTHER_GROUPS = ['Panopto Video Views', 'Participation', 'Course Evaluation', 'Product of the Week', 'Other Assignments'];

// All groups start CLOSED — click to expand
const expandedGroups = new Set();

function renderSidebar() {
  const wrap = document.getElementById('sidebar-assignments');
  const otherWrap = document.getElementById('sidebar-other-assignments');
  const otherBox = document.getElementById('sidebar-other-box');
  if (!S.assignments.length) { wrap.innerHTML = ''; if (otherWrap) otherWrap.innerHTML = ''; if (otherBox) otherBox.style.display = 'none'; return; }

  // Split groups into main grading and "other"
  const allKeys = [...GROUP_ORDER.filter(k => S.assignmentGroups[k]), ...Object.keys(S.assignmentGroups).filter(k => !GROUP_ORDER.includes(k) && !OTHER_GROUPS.includes(k))];
  const otherKeys = OTHER_GROUPS.filter(k => S.assignmentGroups[k]);

  function renderGroup(groupName) {
    const assignments = S.assignmentGroups[groupName] || [];
    const isOpen = expandedGroups.has(groupName);
    const icon = GROUP_ICONS[groupName] || '○';
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
    // Add Case/Sim Participation links inside the Participation group
    let extraItems = '';
    if (groupName === 'Participation') {
      extraItems = `
        <hr class="nav-divider" />
        <button class="nav-btn nav-btn-participation ${currentView === 'caseparticipation' ? 'active' : ''}" onclick="showView('caseparticipation')" style="font-size:11px"><span class="nav-icon" style="color:#ff6b00">●</span> Case Participation</button>
        <button class="nav-btn nav-btn-participation ${currentView === 'simparticipation' ? 'active' : ''}" onclick="showView('simparticipation')" style="font-size:11px"><span class="nav-icon" style="color:#ff6b00">●</span> Sim Participation</button>`;
    }
    return `<div class="sidebar-group">
      <button class="sidebar-group-header" onclick="toggleGroup('${esc(groupName)}')">
        <span class="nav-icon">${icon}</span>
        <span class="sidebar-group-name">${esc(groupName)}</span>
        ${badge}
        <span class="sidebar-chevron">${isOpen ? '▾' : '▸'}</span>
      </button>
      <div class="sidebar-group-items ${isOpen ? 'open' : ''}" id="grp-${esc(groupName)}">${items}${extraItems}</div>
    </div>`;
  }

  wrap.innerHTML = allKeys.map(renderGroup).join('');

  // Other Assignments box
  if (otherWrap && otherBox) {
    otherBox.style.display = '';
    otherWrap.innerHTML = otherKeys.map(renderGroup).join('');
  }
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

  // Show loading in the assignment view
  const root = document.getElementById('view-root');
  if (root) {
    const existing = root.querySelector('.loading-splash');
    if (!existing) {
      // Insert loading bar at top of view
      const bar = document.createElement('div');
      bar.className = 'loading-bar-top';
      bar.id = 'assignment-loading-bar';
      bar.innerHTML = '<div class="loading-bar-fill"></div>';
      root.prepend(bar);
    }
  }

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
  if (group === 'Cases') {
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
    case 'panelgrading':  renderPanelGradingView(root); break;
    case 'surveycreator': renderSurveyCreatorView(root); break;
    case 'peereval':     renderPeerEvalView(root); break;
    case 'manual':       renderManualView(root); break;
    case 'rompipalle':   renderRompipalleView(root); break;
    case 'caseparticipation': renderCaseParticipationView(root); break;
    case 'simparticipation': renderSimParticipationView(root); break;
    case 'classpresence': renderClassPresenceView(root); break;
    case 'messages':      renderMessagesView(root); break;
    case 'notifications': renderNotificationsView(root); break;
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
  // Snapshot current canvas scores so we can detect future changes
  const g = S.allGrades[String(aid)] || {};
  Object.values(g).forEach(gr => {
    if (gr.canvasScore != null) gr._dismissedScore = gr.canvasScore;
  });
  // Persist grades with snapshot and dismissed list
  const saves = Object.entries(g).map(([uid, gr]) =>
    PUT(`/api/grades/${S.course.id}/${aid}/${uid}`, gr).catch(() => {})
  );
  saves.push(PUT(`/api/dismissed/${S.course.id}`, [...S.dismissed]).catch(() => {}));
  await Promise.all(saves);
  renderOverview();
  toast('Marked as finalized.', 'success');
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

  // Build needs-attention list — only assignments whose due date has arrived or passed
  const needsGrading = [];
  S.assignments.forEach(a => {
    if (a.due_at && new Date(a.due_at) > now) return; // not due yet — skip
    const aid = String(a.id);
    const g = S.allGrades[aid] || {};
    const gs = Object.values(g);
    if (!gs.length) { needsGrading.push({ a, status: 'no_grades', label: `${allStudents().length} to be graded`, color: 'needs' }); return; }
    const withFinal = gs.filter(gr => gr.finalScore != null);
    const fromCanvas = gs.filter(gr => gr.status === 'canvas');
    const synced = withFinal.filter(gr => gr.canvasScore != null && gr.finalScore === gr.canvasScore);
    const uwOnly = withFinal.filter(gr => gr.canvasScore == null || (gr.finalScore !== gr.canvasScore && gr.status !== 'canvas'));
    // Check for canvas changes after dismissal
    const dismissed = S.dismissed.has(aid);
    if (dismissed) {
      // Check if any canvas scores changed since we dismissed
      const changed = gs.filter(gr => gr._dismissedScore != null && gr.canvasScore != null && gr.canvasScore !== gr._dismissedScore);
      if (changed.length) {
        needsGrading.push({ a, status: 'changed', label: `${changed.length} grade(s) changed`, color: 'warn' });
      }
      return; // dismissed and no changes
    }
    if (fromCanvas.length && !gs.some(gr => gr.status === 'reviewed' || gr.status === 'ai_graded')) {
      needsGrading.push({ a, status: 'canvas_only', label: 'To be finalized', color: 'canvas' });
    } else if (uwOnly.length > 0 && synced.length === 0) {
      needsGrading.push({ a, status: 'local_only', label: 'To be finalized and pushed', color: 'local' });
    } else if (synced.length > 0 && uwOnly.length === 0) {
      needsGrading.push({ a, status: 'synced', label: 'Grades Synced', color: 'synced' });
    } else if (gs.some(gr => gr.status !== 'reviewed')) {
      const pending = gs.filter(gr => gr.status !== 'reviewed').length;
      needsGrading.push({ a, status: 'pending', label: `${pending} to be graded`, color: 'needs' });
    }
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

  // Compute class-wide averages
  const students = S.allStudentsList.length ? S.allStudentsList : allStudents();
  const caseAssignments = S.assignments.filter(a => classifyAssignment(a) === 'Cases');
  const actAssignments = S.assignments.filter(a => classifyAssignment(a) === 'Activities');

  function avgByGroup(groupAssignments) {
    let totalEarned = 0, totalPossible = 0, counted = 0;
    students.forEach(st => {
      let earned = 0, possible = 0;
      groupAssignments.forEach(a => {
        const g = (S.allGrades[String(a.id)] || {})[st.id];
        const score = g?.finalScore ?? g?.canvasScore ?? null;
        if (score != null && a.points_possible) { earned += score; possible += a.points_possible; }
      });
      if (possible > 0) { totalEarned += earned; totalPossible += possible; counted++; }
    });
    return counted ? Math.round((totalEarned / totalPossible) * 100) : null;
  }

  // Average participation % (across all participation assignments)
  const partAssignments = S.assignments.filter(a => classifyAssignment(a) === 'Participation');
  const avgCase = avgByGroup(caseAssignments);
  const avgSim = avgByGroup(actAssignments);
  const avgPart = avgByGroup(partAssignments);

  // Overall GPA: all assignments with grades
  let gpaEarned = 0, gpaPossible = 0;
  students.forEach(st => {
    S.assignments.forEach(a => {
      const g = (S.allGrades[String(a.id)] || {})[st.id];
      const score = g?.finalScore ?? g?.canvasScore ?? null;
      if (score != null && a.points_possible) { gpaEarned += score; gpaPossible += a.points_possible; }
    });
  });
  const gpaPct = gpaPossible ? Math.round((gpaEarned / gpaPossible) * 100) : null;
  const gpaLetter = gpaPct == null ? '—' : gpaPct>=93?'A':gpaPct>=90?'A-':gpaPct>=87?'B+':gpaPct>=83?'B':gpaPct>=80?'B-':gpaPct>=77?'C+':gpaPct>=73?'C':gpaPct>=70?'C-':gpaPct>=67?'D+':gpaPct>=60?'D':'F';
  const gpaNum = gpaPct == null ? '—' : (gpaPct>=93?4.0:gpaPct>=90?3.7:gpaPct>=87?3.3:gpaPct>=83?3.0:gpaPct>=80?2.7:gpaPct>=77?2.3:gpaPct>=73?2.0:gpaPct>=70?1.7:gpaPct>=67?1.3:gpaPct>=60?1.0:0.0).toFixed(1);

  root.innerHTML = `
    <div class="page-title">Overview — ${esc(S.course?.name || 'No course selected')}</div>

    <!-- All stats in one row -->
    <div class="ov-stats-row">
      <div class="ov-stat" style="background:#eff6ff;border-color:#2563eb">
        <div class="ov-stat-val" style="color:#2563eb">${S.assignments.length || '—'}</div>
        <div class="ov-stat-lbl">Assignments</div>
      </div>
      <div class="ov-stat" style="background:#fefce8;border-color:#d97706">
        <div class="ov-stat-val" style="color:#d97706">${needsGrading.length || '0'}</div>
        <div class="ov-stat-lbl">Need Grading</div>
      </div>
      <div class="ov-stat" style="background:#fef2f2;border-color:#dc2626">
        <div class="ov-stat-val" style="color:#dc2626">${allFlags.length || '0'}</div>
        <div class="ov-stat-lbl">AI Flags</div>
      </div>
      <div class="ov-stat" style="background:#dbeafe;border-color:#1d4ed8">
        <div class="ov-stat-val" style="color:#1d4ed8">${avgCase != null ? avgCase + '%' : '—'}</div>
        <div class="ov-stat-lbl">Avg Case</div>
      </div>
      <div class="ov-stat" style="background:#dcfce7;border-color:#16a34a">
        <div class="ov-stat-val" style="color:#16a34a">${avgSim != null ? avgSim + '%' : '—'}</div>
        <div class="ov-stat-lbl">Avg Sim</div>
      </div>
      <div class="ov-stat" style="background:#fff7ed;border-color:#ff6b00">
        <div class="ov-stat-val" style="color:#ff6b00">${avgPart != null ? avgPart + '%' : '—'}</div>
        <div class="ov-stat-lbl">Avg Participation</div>
      </div>
      <div class="ov-stat" style="background:#f5f3ff;border-color:var(--uw-purple)">
        <div class="ov-stat-val" style="color:var(--uw-purple);font-size:16px">${avgHtml}</div>
        <div class="ov-stat-lbl">Last Avg Score</div>
      </div>
      <div class="ov-stat" style="background:#ede9fe;border-color:var(--uw-purple);flex:1.3">
        <div class="ov-stat-val" style="color:var(--uw-purple);font-size:26px">${gpaLetter}</div>
        <div class="ov-stat-lbl">GPA ${gpaNum !== '—' ? gpaNum + ' · ' + (gpaPct||0) + '%' : ''}</div>
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
      <div class="card-title">🔴 Needs Grading ${S._syncing ? '<span class="syncing-badge">Syncing Canvas<span class="loading-dots"></span></span>' : `(${needsGrading.length})`}</div>
      ${S._syncing ? '<div class="syncing-hint"><div class="loading-bar-top" style="margin-bottom:0"><div class="loading-bar-fill"></div></div><p class="muted" style="padding:8px 0;text-align:center">Grabbing latest data from Canvas...</p></div>' : ''}
      ${needsGrading.length ? `<table class="overview-table">
        <thead><tr><th>Assignment</th><th>Type</th><th>Due</th><th>Points</th><th>Grade Source</th><th>Status</th><th></th></tr></thead>
        <tbody>${needsGrading.map(item => {
          const a = item.a;
          const g = S.allGrades[String(a.id)] || {};
          const gs = Object.values(g);
          const due = a.due_at ? new Date(a.due_at).toLocaleDateString() : '—';

          // Grade source badge
          const fromCanvas = gs.filter(gr => gr.status === 'canvas');
          const withFinal = gs.filter(gr => gr.finalScore != null);
          const synced = withFinal.filter(gr => gr.canvasScore != null && gr.finalScore === gr.canvasScore);
          const uwOnly = withFinal.filter(gr => gr.canvasScore == null || (gr.finalScore !== gr.canvasScore && gr.status !== 'canvas'));
          let srcBadge = '';
          if (!withFinal.length && !fromCanvas.length)
            srcBadge = '<span class="grade-sync-badge grade-sync--needs" style="font-size:10px;padding:2px 8px">No Grades</span>';
          else if (fromCanvas.length && !gs.some(gr => gr.status === 'reviewed' || gr.status === 'ai_graded'))
            srcBadge = `<span class="grade-sync-badge grade-sync--canvas" style="font-size:10px;padding:2px 8px">Canvas (${fromCanvas.length})</span>`;
          else if (uwOnly.length === 0 && synced.length > 0)
            srcBadge = `<span class="grade-sync-badge grade-sync--synced" style="font-size:10px;padding:2px 8px">Synced (${synced.length})</span>`;
          else if (uwOnly.length > 0)
            srcBadge = `<span class="grade-sync-badge grade-sync--local" style="font-size:10px;padding:2px 8px">UW-TA Only (${uwOnly.length})</span>`;

          // Status badge
          const statusBadge = `<span class="grade-sync-badge grade-sync--${item.color}" style="font-size:10px;padding:2px 8px">${item.label}</span>`;

          return `<tr>
            <td><button class="link-btn" onclick="selectAssignment('${a.id}')">${esc(a.name)}</button></td>
            <td><span class="type-badge">${esc(classifyAssignment(a))}</span></td>
            <td>${due}</td>
            <td>${a.points_possible || '—'}</td>
            <td>${srcBadge}</td>
            <td>${statusBadge}</td>
            <td style="display:flex;gap:5px">
              <button class="btn btn-surf" style="font-size:11px;padding:4px 10px" onclick="selectAssignment('${a.id}')">Open</button>
              <button class="btn btn-ghost" style="font-size:11px;padding:4px 10px" title="Mark as finalized" onclick="dismissAssignment('${a.id}')">✓ Done</button>
            </td>
          </tr>`;
        }).join('')}</tbody>
      </table>` : '<p class="muted">All assignments finalized! 🎉</p>'}
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
      <td class="gb-name"><span class="stu-avatar-wrap">${studentAvatar(st)}</span>${esc(st.name)}</td>
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
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Upload failed: ' + resp.status);
    toast(`Photo saved for ${studentId}!`, 'success');
    // Force refresh all instances of this student's avatar
    document.querySelectorAll(`img.stu-avatar[src*="student-photo/${studentId}"], img.sc-photo-img[src*="student-photo/${studentId}"]`).forEach(img => {
      img.src = `/api/student-photo/${studentId}?t=${Date.now()}`;
      img.style.display = '';
    });
    document.querySelectorAll(`#sc-photo-${studentId}`).forEach(img => {
      img.src = `/api/student-photo/${studentId}?t=${Date.now()}`;
      img.style.display = '';
    });
  } catch (e) {
    console.error('Photo upload error:', e);
    toast('Photo upload failed: ' + e.message, 'error');
  }
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
        <div class="tm-card-footer">
          <div class="tm-members-bare">
            ${members.map(st => `<span class="tm-badge">${esc(st.name.split(' ')[0])} ${esc(st.name.split(' ').slice(-1)[0])}</span>`).join('')}
          </div>
          <button class="btn btn-ghost tm-notes-btn" onclick="openTeamNotes(${tNum})">📝 Notes</button>
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

/* ── Team Notes ────────────────────────────────────────────────────────────── */
let _teamNotesNum = null;

function openTeamNotes(teamNum) {
  _teamNotesNum = teamNum;
  const meta = S.teamMeta[String(teamNum)] || {};
  const notes = meta.notes || [];
  const userName = displayName(S.me?.username || 'Marco');

  const notesHtml = notes.length ? notes.map(n => {
    const name = displayName(n.author);
    const color = authorColor(name);
    return `<div class="tn-note" style="border-left:3px solid ${color}">
      <div class="tn-note-header"><strong style="color:${color}">(${esc(name)})</strong> <span class="muted">${esc(n.date || '')}</span></div>
      <div class="tn-note-body">${esc(n.text)}</div>
    </div>`;
  }).join('') : '<p class="muted" style="text-align:center;padding:16px">No notes yet. Start the discussion below.</p>';

  const label = meta.name ? `Team ${teamNum} — ${meta.name}` : `Team ${teamNum}`;
  const userColor = authorColor(userName);

  const backdrop = document.getElementById('modal-backdrop');
  const modal = backdrop.querySelector('.modal');
  modal.innerHTML = `
    <div class="modal-header">
      <div>
        <div class="modal-title">📝 ${esc(label)} — Notes</div>
        <div class="modal-subtitle">Progression notes by Marco & Marlowe</div>
      </div>
      <button class="modal-close" onclick="closeTeamNotes()">✕</button>
    </div>
    <div class="modal-body">
      <div class="tn-notes-list" id="tn-notes-list">${notesHtml}</div>
    </div>
    <div class="modal-footer" style="flex-direction:column;gap:6px;align-items:stretch">
      <div style="display:flex;gap:6px;align-items:center">
        <span style="font-size:12px;font-weight:700;color:${userColor}">Writing as: (${esc(userName)})</span>
      </div>
      <div style="display:flex;gap:6px">
        <textarea class="input" id="tn-note-input" rows="2" placeholder="Add a note about this team's progress…" style="flex:1"></textarea>
        <button class="btn btn-surf" onclick="saveTeamNote()" style="align-self:flex-end">Add Note</button>
      </div>
    </div>`;

  backdrop.classList.remove('hidden');
  // Scroll to bottom
  setTimeout(() => { const list = document.getElementById('tn-notes-list'); if (list) list.scrollTop = list.scrollHeight; }, 50);
}

function closeTeamNotes() {
  document.getElementById('modal-backdrop').classList.add('hidden');
  _teamNotesNum = null;
}

async function saveTeamNote() {
  if (_teamNotesNum == null || !S.course) return;
  const input = document.getElementById('tn-note-input');
  const text = input?.value?.trim();
  if (!text) return;

  const userName = displayName(S.me?.username || 'Marco');
  const tKey = String(_teamNotesNum);
  if (!S.teamMeta[tKey]) S.teamMeta[tKey] = {};
  if (!S.teamMeta[tKey].notes) S.teamMeta[tKey].notes = [];
  S.teamMeta[tKey].notes.push({
    author: userName,
    text,
    date: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
  });

  await PUT(`/api/team-meta/${S.course.id}`, S.teamMeta).catch(() => {});
  input.value = '';
  openTeamNotes(_teamNotesNum); // refresh
  toast('Note saved.', 'success');
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

let _ledgerHideNotDue = false;
let _ledgerSortCol = 'name'; // 'name','total','pct','grade', or assignment id
let _ledgerSortDir = 1; // 1=asc, -1=desc
let _ledgerCanvasScores = null; // cache for canvas scores

function ldgSort(col) {
  if (_ledgerSortCol === col) _ledgerSortDir *= -1;
  else { _ledgerSortCol = col; _ledgerSortDir = 1; }
  _renderLedgerHtml(null, _ledgerCanvasScores);
}

function ldgSortArrow(col) {
  if (_ledgerSortCol !== col) return '<span class="ldg-sort">⇅</span>';
  return _ledgerSortDir === 1 ? '<span class="ldg-sort ldg-sort-active">▲</span>' : '<span class="ldg-sort ldg-sort-active">▼</span>';
}

function _renderLedgerHtml(root, canvasScores) {
  root = root || document.getElementById('view-root');
  if (canvasScores) _ledgerCanvasScores = canvasScores;
  const cvs = _ledgerCanvasScores;
  const students = S.allStudentsList;
  const now = new Date();
  const allAssignments = [...S.assignments].sort((a, b) => new Date(a.due_at||0) - new Date(b.due_at||0));
  const assignments = _ledgerHideNotDue
    ? allAssignments.filter(a => !a.due_at || new Date(a.due_at) <= now)
    : allAssignments;
  if (!students.length || !assignments.length) {
    root.innerHTML = '<p class="muted padded">No students or assignments loaded. Select a course first.</p>';
    return;
  }

  // Build header columns (group by category)
  const grouped = {};
  assignments.forEach(a => {
    const g = classifyAssignment(a);
    if (!grouped[g]) grouped[g] = [];
    grouped[g].push(a);
  });
  const orderedGroups = [...GROUP_ORDER.filter(g => grouped[g]), ...Object.keys(grouped).filter(g => !GROUP_ORDER.includes(g))];
  const flatAssignments = orderedGroups.flatMap(g => grouped[g]);

  // Group header row
  const groupHeaderCells = orderedGroups.map(g =>
    `<th class="ldg-group-hdr" colspan="${grouped[g].length}">${esc(g)}</th>`
  ).join('');

  // Assignment header row with sort arrows
  const asgHeaderCells = flatAssignments.map(a =>
    `<th class="ldg-asg-hdr ldg-sortable" title="${esc(a.name)}" onclick="ldgSort('a_${a.id}')">
      ${esc(a.name.length > 18 ? a.name.slice(0,16)+'…' : a.name)}
      <div class="ldg-pts">${a.points_possible || '?'}pt</div>
      ${ldgSortArrow('a_' + a.id)}
    </th>`
  ).join('');

  // Compute per-student data
  function getScore(st, a) {
    const localGrade = (S.allGrades[String(a.id)] || {})[st.id];
    const cvScore = cvs?.[String(a.id)]?.[st.id];
    return localGrade?.finalScore ?? localGrade?.canvasScore ?? cvScore ?? null;
  }

  const studentData = students.map(st => {
    let earned = 0, possible = 0;
    const scores = {};
    flatAssignments.forEach(a => {
      const score = getScore(st, a);
      scores[a.id] = score;
      if (score != null && a.points_possible) { earned += score; possible += a.points_possible; }
    });
    const pct = possible ? Math.round(earned / possible * 100) : null;
    const letter = pct == null ? '—' : pct>=93?'A':pct>=90?'A-':pct>=87?'B+':pct>=83?'B':pct>=80?'B-':pct>=77?'C+':pct>=73?'C':pct>=70?'C-':pct>=67?'D+':pct>=60?'D':'F';
    return { st, earned, possible, pct, letter, scores };
  });

  // Sort
  const letterVal = l => ({ 'A':12,'A-':11,'B+':10,'B':9,'B-':8,'C+':7,'C':6,'C-':5,'D+':4,'D':3,'F':1 }[l] || 0);
  studentData.sort((a, b) => {
    let cmp = 0;
    if (_ledgerSortCol === 'name') cmp = a.st.name.localeCompare(b.st.name);
    else if (_ledgerSortCol === 'total') cmp = (a.earned || 0) - (b.earned || 0);
    else if (_ledgerSortCol === 'pct') cmp = (a.pct || 0) - (b.pct || 0);
    else if (_ledgerSortCol === 'grade') cmp = letterVal(a.letter) - letterVal(b.letter);
    else if (_ledgerSortCol.startsWith('a_')) {
      const aid = _ledgerSortCol.slice(2);
      cmp = (a.scores[aid] ?? -1) - (b.scores[aid] ?? -1);
    }
    return cmp * _ledgerSortDir;
  });

  // Render rows
  const rows = studentData.map(({ st, earned, possible, pct, letter, scores }) => {
    const cells = flatAssignments.map(a => {
      const score = scores[a.id];
      const p = (score != null && a.points_possible) ? score / a.points_possible : null;
      const bg = p == null ? '' : p >= 0.9 ? 'ldg-cell-a' : p >= 0.8 ? 'ldg-cell-b' : p >= 0.7 ? 'ldg-cell-c' : 'ldg-cell-f';
      return `<td class="ldg-cell ${bg}">${score != null ? score : '<span class="ldg-empty">—</span>'}</td>`;
    }).join('');
    return `<tr>
      <td class="ldg-name"><span class="stu-avatar-wrap">${studentAvatar(st, 18)}${esc(st.name)}</span></td>
      <td class="ldg-total">${possible ? `${earned}/${possible}` : '—'}</td>
      <td class="ldg-pct-cell ${pct != null && pct < 70 ? 'grade-low' : ''}">${pct != null ? pct + '%' : '—'}</td>
      <td class="ldg-letter ${pct != null && pct < 70 ? 'grade-low' : ''}">${letter}</td>
      ${cells}
    </tr>`;
  }).join('');

  const hiddenCount = _ledgerHideNotDue ? allAssignments.length - assignments.length : 0;

  root.innerHTML = `
    <div class="page-title">Grade Ledger — ${esc(S.course?.name || '')}
      <div class="page-actions">
        <label class="checkbox-label" style="font-size:12px">
          <input type="checkbox" ${_ledgerHideNotDue ? 'checked' : ''} onchange="_ledgerHideNotDue=this.checked;_renderLedgerHtml()"> Hide Not Due ${hiddenCount ? `(${hiddenCount} hidden)` : ''}
        </label>
        <button class="btn btn-primary" onclick="syncLedgerFromCanvas()">⟳ Sync from Canvas</button>
      </div>
    </div>
    <div class="ldg-wrap">
      <table class="ldg-table">
        <thead>
          <tr>
            <th class="ldg-name-hdr ldg-sortable" rowspan="2" onclick="ldgSort('name')">Student ${ldgSortArrow('name')}</th>
            <th class="ldg-total-hdr ldg-sortable" rowspan="2" onclick="ldgSort('total')">Total ${ldgSortArrow('total')}</th>
            <th class="ldg-pct-hdr ldg-sortable" rowspan="2" onclick="ldgSort('pct')">% ${ldgSortArrow('pct')}</th>
            <th class="ldg-letter-hdr ldg-sortable" rowspan="2" onclick="ldgSort('grade')">Grade ${ldgSortArrow('grade')}</th>
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

  // Per-class pastel colors (rotate through a palette)
  const classPastels = [
    { bg: '#eff6ff', badge: '#2563eb' },  // blue
    { bg: '#f0fdf4', badge: '#16a34a' },  // green
    { bg: '#fefce8', badge: '#a16207' },  // amber
    { bg: '#fdf2f8', badge: '#be185d' },  // pink
    { bg: '#f5f3ff', badge: '#7c3aed' },  // violet
    { bg: '#ecfdf5', badge: '#059669' },  // emerald
    { bg: '#fff7ed', badge: '#c2410c' },  // orange
    { bg: '#f0f9ff', badge: '#0284c7' },  // sky
    { bg: '#fef2f2', badge: '#dc2626' },  // red
    { bg: '#f8fafc', badge: '#475569' },  // slate
    { bg: '#fffbeb', badge: '#b45309' },  // yellow
    { bg: '#f0fdfa', badge: '#0d9488' },  // teal
  ];

  let prevClassNum = null;

  const rowsHtml = rows.map((row, i) => {
    const isCancelled = !!row.isCancelled;
    const classNum    = dateToClassNum[row.date] || '';
    const palette     = classNum ? classPastels[(classNum - 1) % classPastels.length] : { bg: '#fff', badge: '#6b7280' };
    const rowBg       = isCancelled ? '' : `background:${palette.bg}`;
    const rowCls      = isCancelled ? 'syl-row-cancelled' : 'syl-row';

    // Divider between classes
    const divider = (prevClassNum && classNum && classNum !== prevClassNum) ? `<tr class="syl-divider"><td colspan="14"></td></tr>` : '';
    prevClassNum = classNum;

    const actTypeOpts = actTypes.map(t =>
      `<option value="${esc(t)}" ${row.actType === t ? 'selected' : ''}>${esc(t)}</option>`
    ).join('');

    return `${divider}<tr class="${rowCls}" style="${rowBg}" id="syl-row-${i}">
      <td class="syl-session">
        ${classNum ? `<select class="syl-class-badge" style="background:${palette.badge}" onchange="updateSylField(${i},'date',this.value);renderSyllabusView()">
          ${uniqueDates.map((d, di) => `<option value="${d}" ${d === row.date ? 'selected' : ''}>Class ${di + 1}</option>`).join('')}
        </select>` : ''}
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

  // Product of the Week gets its own custom view
  if (group === 'Product of the Week') { renderPotwView(root, a); return; }

  // Group Project gets team-based grading view
  if (group === 'Group Project') { renderGroupProjectView(root, a); return; }

  // Participation gets custom view
  if (group === 'Participation') { renderParticipationAssignmentView(root, a); return; }

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

    <!-- Student Randomizer (for Product of the Week) -->
    ${group === 'Product of the Week' ? `<div class="card potw-randomizer-card">
      <div class="card-title">◎ Student Randomizer — Product of the Week Spotlight</div>
      <div class="potw-body">
        <div class="potw-result" id="potw-result">Click the button to pick a random student</div>
        <div class="potw-actions">
          <button class="btn btn-primary potw-spin-btn" onclick="potwRandomize()">🎲 Pick Random Student</button>
          <button class="btn btn-ghost" onclick="potwRandomize(true)">🔄 Pick Another</button>
        </div>
        <div class="potw-history" id="potw-history"></div>
      </div>
    </div>` : ''}

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
      ${(() => {
        const gs = Object.values(S.grades);
        const withFinal = gs.filter(g => g.finalScore != null);
        const fromCanvas = gs.filter(g => g.status === 'canvas');
        const synced = withFinal.filter(g => g.canvasScore != null && g.finalScore === g.canvasScore);
        const uwOnly = withFinal.filter(g => g.canvasScore == null || g.finalScore !== g.canvasScore);
        if (fromCanvas.length && !withFinal.filter(g => g.status !== 'canvas').length)
          return `<span class="grade-sync-badge grade-sync--canvas">Canvas Grades (${fromCanvas.length})</span>`;
        if (uwOnly.length === 0 && synced.length > 0)
          return `<span class="grade-sync-badge grade-sync--synced">Synced with Canvas (${synced.length})</span>`;
        if (uwOnly.length > 0)
          return `<span class="grade-sync-badge grade-sync--local">UW-TA Only (${uwOnly.length})</span>`;
        return '';
      })()}
      <button class="assign-tab active" data-atab="instructions" onclick="switchAssignTab('instructions')">Instructions & Rubric</button>
      <button class="assign-tab assign-tab--grade" data-atab="oneByOne" onclick="switchAssignTab('oneByOne')">✦ Grade One-by-One</button>
      <button class="assign-tab" data-atab="students" onclick="switchAssignTab('students')">Students (${students.length})</button>
      <button class="assign-tab" data-atab="matrix" onclick="switchAssignTab('matrix')">Grading Matrix</button>
      ${group === 'Cases' ? `<button class="assign-tab" data-atab="participation" onclick="switchAssignTab('participation')">Discussion Participation</button>` : ''}
      ${group === 'Activities' ? `<button class="assign-tab" data-atab="simparticipation" onclick="switchAssignTab('simparticipation')">Simulation Participation</button>` : ''}
      <button class="assign-tab" data-atab="chat" onclick="switchAssignTab('chat')">Notes</button>
      <button class="assign-tab assign-tab--push" onclick="pushAllToCanvas()">⬆ Push Final Grades to Canvas</button>
    </div>

    <div id="atab-instructions" class="atab-content active">${renderInstructionsTab()}</div>
    <div id="atab-oneByOne"     class="atab-content">${renderOneByOneTab()}</div>
    <div id="atab-students"     class="atab-content">${renderStudentsTabHtml()}</div>
    <div id="atab-matrix"       class="atab-content">${renderMatrixTabHtml()}</div>
    ${group === 'Cases' ? `<div id="atab-participation" class="atab-content">${renderParticipationTab()}</div>` : ''}
    ${group === 'Activities' ? `<div id="atab-simparticipation" class="atab-content">${renderSimParticipationTab()}</div>` : ''}
    <div id="atab-chat"         class="atab-content">${renderChatTabHtml()}</div>
  `;
}

/* ── Product of the Week Randomizer ─────────────────────────────────────────── */
let _potwPicked = [];

function renderPotwView(root, a) {
  const students = allStudents();
  const due = a.due_at ? new Date(a.due_at).toLocaleDateString() : 'No due date';
  const graded = Object.values(S.grades).filter(g => g.status !== 'pending');
  const scores = Object.values(S.grades).map(g => g.finalScore).filter(s => s != null);
  const avg = scores.length ? (scores.reduce((x, y) => x + y, 0) / scores.length).toFixed(1) : '—';

  // Grade sync badge
  const gs = Object.values(S.grades);
  const withFinal = gs.filter(g => g.finalScore != null);
  const fromCanvas = gs.filter(g => g.status === 'canvas');
  const synced = withFinal.filter(g => g.canvasScore != null && g.finalScore === g.canvasScore);
  const uwOnly = withFinal.filter(g => g.canvasScore == null || g.finalScore !== g.canvasScore);
  let syncBadge = '';
  if (fromCanvas.length && !withFinal.filter(g => g.status !== 'canvas').length)
    syncBadge = `<span class="grade-sync-badge grade-sync--canvas">Canvas Grades (${fromCanvas.length})</span>`;
  else if (uwOnly.length === 0 && synced.length > 0)
    syncBadge = `<span class="grade-sync-badge grade-sync--synced">Synced (${synced.length})</span>`;
  else if (uwOnly.length > 0)
    syncBadge = `<span class="grade-sync-badge grade-sync--local">UW-TA Only (${uwOnly.length})</span>`;

  // Student rows
  const rows = students.map(st => {
    const g = S.grades[st.id] || {};
    const potw = g.potwData || {};
    const type = potw.type || '';
    const date = potw.date || '';
    const desc = potw.description || '';
    const pts = g.finalScore != null ? g.finalScore : '';
    return `<tr>
      <td style="font-weight:600">${esc(st.name)}</td>
      <td style="text-align:center">
        <label class="potw-check-label"><input type="radio" name="potw-type-${esc(st.id)}" value="volunteered" ${type === 'volunteered' ? 'checked' : ''}
          onchange="potwUpdateStudent('${esc(st.id)}','type','volunteered')"> Vol</label>
        <label class="potw-check-label"><input type="radio" name="potw-type-${esc(st.id)}" value="called" ${type === 'called' ? 'checked' : ''}
          onchange="potwUpdateStudent('${esc(st.id)}','type','called')"> Called</label>
      </td>
      <td><input type="date" class="input potw-date-input" value="${esc(date)}"
        onchange="potwUpdateStudent('${esc(st.id)}','date',this.value)" /></td>
      <td><input type="text" class="input" placeholder="Brief description…" value="${esc(desc)}"
        onchange="potwUpdateStudent('${esc(st.id)}','description',this.value)" style="font-size:12px" /></td>
      <td><input type="number" class="input potw-pts-input" min="0" max="${a.points_possible || 10}" value="${pts}"
        onchange="potwUpdateScore('${esc(st.id)}',this.value,${a.points_possible || 10})" placeholder="—" /></td>
    </tr>`;
  }).join('');

  root.innerHTML = `
    <div class="page-title">
      ${esc(a.name)}
      <span class="type-badge" style="font-size:13px">Product of the Week</span>
      <div class="page-actions">
        <button class="btn btn-ghost" onclick="selectAssignment('${a.id}')">⟳ Refresh</button>
      </div>
    </div>

    <!-- Stat cards -->
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
    </div>

    <!-- Randomizer -->
    <div class="card potw-randomizer-card">
      <div class="card-title">◎ Student Randomizer</div>
      <div class="potw-body">
        <div class="potw-result" id="potw-result">Click to pick a random student</div>
        <div class="potw-actions">
          <button class="btn btn-primary potw-spin-btn" onclick="potwRandomize()">🎲 Pick Random Student</button>
          <button class="btn btn-ghost" onclick="potwRandomize()">🔄 Pick Another</button>
        </div>
        <div class="potw-history" id="potw-history"></div>
      </div>
    </div>

    <!-- Sync badge + Push button -->
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">
      ${syncBadge}
      <div style="margin-left:auto">
        <button class="btn assign-tab--push" style="border-radius:var(--radius);padding:8px 16px" onclick="pushAllToCanvas()">⬆ Push Final Grades to Canvas</button>
      </div>
    </div>

    <!-- Student list -->
    <div class="card">
      <div class="card-title">Students — Product of the Week Tracker</div>
      <div class="table-wrap">
        <table>
          <thead><tr>
            <th>Student</th>
            <th style="text-align:center">Volunteered / Called</th>
            <th>Date</th>
            <th>Brief Description</th>
            <th style="text-align:center">Points (/${a.points_possible || 10})</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>`;
}

function potwUpdateStudent(studentId, field, value) {
  if (!S.grades[studentId]) S.grades[studentId] = buildEmptyGrade(studentId);
  if (!S.grades[studentId].potwData) S.grades[studentId].potwData = {};
  S.grades[studentId].potwData[field] = value;
  S.grades[studentId].status = 'reviewed';
  saveGrade(studentId);
}

function potwUpdateScore(studentId, value, max) {
  let pts = value.trim() === '' ? null : Number(value);
  if (pts !== null) pts = Math.max(0, Math.min(max, pts));
  if (!S.grades[studentId]) S.grades[studentId] = buildEmptyGrade(studentId);
  S.grades[studentId].finalScore = pts;
  S.grades[studentId].status = 'reviewed';
  saveGrade(studentId);
}

/* ── Group Project View — Team-based grading ──────────────────────────────── */
function renderGroupProjectView(root, a) {
  const students = allStudents();
  const due = a.due_at ? new Date(a.due_at).toLocaleDateString() : 'No due date';
  const graded = Object.values(S.grades).filter(g => g.status !== 'pending');
  const scores = Object.values(S.grades).map(g => g.finalScore).filter(s => s != null);
  const avg = scores.length ? (scores.reduce((x, y) => x + y, 0) / scores.length).toFixed(1) : '—';
  const maxPts = a.points_possible || 10;

  // Grade sync badge
  const gs = Object.values(S.grades);
  const withFinal = gs.filter(g => g.finalScore != null);
  const fromCanvas = gs.filter(g => g.status === 'canvas');
  const synced = withFinal.filter(g => g.canvasScore != null && g.finalScore === g.canvasScore);
  const uwOnly = withFinal.filter(g => g.canvasScore == null || g.finalScore !== g.canvasScore);
  let syncBadge = '';
  if (fromCanvas.length && !withFinal.filter(g => g.status !== 'canvas').length)
    syncBadge = `<span class="grade-sync-badge grade-sync--canvas">Canvas Grades (${fromCanvas.length})</span>`;
  else if (uwOnly.length === 0 && synced.length > 0)
    syncBadge = `<span class="grade-sync-badge grade-sync--synced">Synced (${synced.length})</span>`;
  else if (uwOnly.length > 0)
    syncBadge = `<span class="grade-sync-badge grade-sync--local">UW-TA Only (${uwOnly.length})</span>`;

  // Build team cards
  const teamStudents = {};
  students.forEach(st => {
    const t = S.teams[st.id]?.team;
    const tNum = t || 0; // 0 = unassigned
    if (!teamStudents[tNum]) teamStudents[tNum] = [];
    teamStudents[tNum].push(st);
  });

  const teamNums = Object.keys(S.teamMeta).map(Number).sort((a, b) => a - b);
  // Add unassigned group if any
  if (teamStudents[0]?.length) teamNums.push(0);

  const teamCards = teamNums.map(tNum => {
    const meta = S.teamMeta[String(tNum)] || {};
    const members = teamStudents[tNum] || [];
    if (!members.length) return '';
    const label = tNum === 0 ? 'Unassigned Students' : (meta.name ? `Team ${tNum} — ${meta.name}` : `Team ${tNum}`);

    // Current team grade (from first member who has one, or empty)
    const firstGraded = members.find(st => S.grades[st.id]?.finalScore != null);
    const teamScore = firstGraded ? S.grades[firstGraded.id].finalScore : '';

    const memberList = members.map(st => {
      const g = S.grades[st.id];
      const score = g?.finalScore != null ? g.finalScore : '—';
      const canv = g?.canvasScore != null ? `<span class="muted" style="font-size:10px">(Canvas: ${g.canvasScore})</span>` : '';
      return `<div class="gp-member">
        <span class="gp-member-name">${esc(st.name)}</span>
        <span class="gp-member-score">${score} / ${maxPts} ${canv}</span>
      </div>`;
    }).join('');

    return `<div class="card gp-team-card">
      <div class="gp-team-header">
        <span class="tm-num">${tNum === 0 ? '?' : 'Team ' + tNum}</span>
        <span class="gp-team-name">${esc(tNum === 0 ? '' : (meta.name || ''))}</span>
        <span class="muted" style="font-size:11px">${members.length} members</span>
        <div class="gp-grade-input-wrap">
          <label style="font-size:11px;font-weight:700;color:var(--uw-purple)">Team Grade:</label>
          <input type="number" class="input gp-grade-input" min="0" max="${maxPts}" value="${teamScore}"
            placeholder="—" onchange="gpSetTeamGrade(${tNum}, this.value, ${maxPts})" />
          <span class="muted" style="font-size:11px">/ ${maxPts}</span>
        </div>
      </div>
      <div class="gp-members">${memberList}</div>
    </div>`;
  }).join('');

  root.innerHTML = `
    <div class="page-title">
      ${esc(a.name)}
      <span class="type-badge" style="font-size:13px">Group Project</span>
      <div class="page-actions">
        <button class="btn btn-ghost" onclick="selectAssignment('${a.id}')">⟳ Refresh</button>
      </div>
    </div>

    <!-- Stat cards -->
    <div class="asgn-stat-cards">
      <div class="asgn-stat-card asgn-stat--due">
        <div class="asgn-stat-icon">📅</div>
        <div class="asgn-stat-value">${due}</div>
        <div class="asgn-stat-label">Due Date</div>
      </div>
      <div class="asgn-stat-card asgn-stat--points">
        <div class="asgn-stat-icon">⭐</div>
        <div class="asgn-stat-value">${maxPts}</div>
        <div class="asgn-stat-label">Points</div>
      </div>
      <div class="asgn-stat-card asgn-stat--students">
        <div class="asgn-stat-icon">👥</div>
        <div class="asgn-stat-value">${students.length}</div>
        <div class="asgn-stat-label">Students</div>
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
    </div>

    <!-- Sync badge + Push -->
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:14px">
      ${syncBadge}
      <div style="margin-left:auto">
        <button class="btn assign-tab--push" style="border-radius:var(--radius);padding:8px 16px" onclick="pushAllToCanvas()">⬆ Push Final Grades to Canvas</button>
      </div>
    </div>

    <!-- Team grading cards -->
    <div class="gp-info" style="margin-bottom:10px">
      <span class="muted" style="font-size:12px">Enter a grade per team — it will be applied to all team members automatically.</span>
    </div>
    ${teamCards}`;
}

async function gpSetTeamGrade(teamNum, value, max) {
  let pts = value.trim() === '' ? null : Number(value);
  if (pts !== null) pts = Math.max(0, Math.min(max, pts));

  // Find all students on this team
  const students = allStudents();
  const members = students.filter(st => {
    if (teamNum === 0) return !S.teams[st.id]?.team;
    return S.teams[st.id]?.team === teamNum;
  });

  // Apply grade to ALL members
  const saves = [];
  for (const st of members) {
    if (!S.grades[st.id]) S.grades[st.id] = buildEmptyGrade(st.id);
    S.grades[st.id].finalScore = pts;
    S.grades[st.id].status = 'reviewed';
    saves.push(saveGrade(st.id));
  }
  await Promise.all(saves);
  toast(`Grade ${pts != null ? pts : '—'} applied to ${members.length} team members.`, 'success');

  // Refresh to show updated scores
  renderAssignmentView();
}

/* ── Participation Assignment View ─────────────────────────────────────────── */
async function renderParticipationAssignmentView(root, a) {
  const students = allStudents();
  const due = a.due_at ? new Date(a.due_at).toLocaleDateString() : 'No due date';
  const maxPts = a.points_possible || 10;

  // Load presence data
  try { _presenceData = await GET(`/api/presence/${S.course.id}`); } catch { _presenceData = {}; }

  // Case & Activity assignments for participation %
  const caseAssignments = S.assignments.filter(x => classifyAssignment(x) === 'Cases').sort((x, y) => new Date(x.due_at || 0) - new Date(y.due_at || 0));
  const actAssignments = S.assignments.filter(x => classifyAssignment(x) === 'Activities').sort((x, y) => new Date(x.due_at || 0) - new Date(y.due_at || 0));

  const rows = students.map(st => {
    const g = S.grades[st.id] || {};

    // Case participation %
    let casePts = 0, caseMax = 0;
    caseAssignments.forEach(ca => {
      const cg = (S.allGrades[String(ca.id)] || {})[st.id];
      if (cg?.participation != null) { casePts += cg.participation; caseMax += 3; }
    });
    const casePct = caseMax ? Math.round((casePts / caseMax) * 100) : null;

    // Simulation participation %
    let simPts = 0, simMax = 0;
    actAssignments.forEach(aa => {
      const ag = (S.allGrades[String(aa.id)] || {})[st.id];
      if (ag?.simParticipation != null) { simPts += ag.simParticipation; simMax += 3; }
    });
    const simPct = simMax ? Math.round((simPts / simMax) * 100) : null;

    // Class presence %
    const presPct = getPresencePct(st.id);

    const panopto = g.panoptoScore != null ? g.panoptoScore : '';
    const behavior = g.behaviorScore != null ? g.behaviorScore : '';

    // Average all available percentages for Total %
    const pcts = [casePct, simPct, presPct].filter(p => p != null);
    const avgPct = pcts.length ? Math.round(pcts.reduce((a, b) => a + b, 0) / pcts.length) : null;

    // Score out of 40 based on average %
    const score40 = avgPct != null ? Math.round(avgPct / 100 * 40) : '';
    const total = g.finalScore != null ? g.finalScore : score40;

    return `<tr>
      <td><span class="stu-avatar-wrap">${studentAvatar(st, 20)}<strong>${esc(st.name)}</strong></span></td>
      <td style="text-align:center;font-weight:700;color:${casePct != null && casePct < 50 ? 'var(--danger)' : 'var(--success)'}">${casePct != null ? casePct + '%' : '—'}</td>
      <td style="text-align:center;font-weight:700;color:${simPct != null && simPct < 50 ? 'var(--danger)' : 'var(--success)'}">${simPct != null ? simPct + '%' : '—'}</td>
      <td style="text-align:center;font-weight:700;color:${presPct != null && presPct < 50 ? 'var(--danger)' : 'var(--success)'}">${presPct != null ? presPct + '%' : '—'}</td>
      <td style="text-align:center">
        <input type="number" class="input" style="width:50px;text-align:center;font-size:12px;padding:3px" min="0" max="40"
          value="${panopto}" placeholder="—" onchange="partFieldSave('${esc(st.id)}','panoptoScore',this.value,40)" />
      </td>
      <td style="text-align:center">
        <input type="number" class="input" style="width:50px;text-align:center;font-size:12px;padding:3px" min="0" max="40"
          value="${behavior}" placeholder="—" onchange="partFieldSave('${esc(st.id)}','behaviorScore',this.value,40)" />
      </td>
      <td style="text-align:center;font-weight:800;color:var(--uw-purple);font-size:15px">${avgPct != null ? avgPct + '%' : '—'}</td>
      <td style="text-align:center">
        <input type="number" class="input gp-grade-input" style="width:60px" min="0" max="40"
          value="${total}" placeholder="—" onchange="partFinalSave('${esc(st.id)}',this.value,40)" />
      </td>
    </tr>`;
  }).join('');

  // Sync badge
  const gs = Object.values(S.grades);
  const withFinal = gs.filter(g => g.finalScore != null);
  const fromCanvas = gs.filter(g => g.status === 'canvas');
  const synced = withFinal.filter(g => g.canvasScore != null && g.finalScore === g.canvasScore);
  const uwOnly = withFinal.filter(g => g.canvasScore == null || g.finalScore !== g.canvasScore);
  let syncBadge = '';
  if (fromCanvas.length && !withFinal.filter(g => g.status !== 'canvas').length)
    syncBadge = `<span class="grade-sync-badge grade-sync--canvas">Canvas Grades (${fromCanvas.length})</span>`;
  else if (uwOnly.length === 0 && synced.length > 0)
    syncBadge = `<span class="grade-sync-badge grade-sync--synced">Synced (${synced.length})</span>`;
  else if (uwOnly.length > 0)
    syncBadge = `<span class="grade-sync-badge grade-sync--local">UW-TA Only (${uwOnly.length})</span>`;

  root.innerHTML = `
    <div class="page-title">
      ${esc(a.name)}
      <span class="type-badge" style="font-size:13px">Total Participation</span>
      <div class="page-actions">
        <button class="btn btn-ghost" onclick="selectAssignment('${a.id}')">⟳ Refresh</button>
      </div>
    </div>

    <div class="asgn-stat-cards">
      <div class="asgn-stat-card asgn-stat--due"><div class="asgn-stat-icon">📅</div><div class="asgn-stat-value">${due}</div><div class="asgn-stat-label">Due Date</div></div>
      <div class="asgn-stat-card asgn-stat--points"><div class="asgn-stat-icon">⭐</div><div class="asgn-stat-value">${maxPts}</div><div class="asgn-stat-label">Points</div></div>
      <div class="asgn-stat-card asgn-stat--students"><div class="asgn-stat-icon">👥</div><div class="asgn-stat-value">${students.length}</div><div class="asgn-stat-label">Students</div></div>
      <div class="asgn-stat-card asgn-stat--graded"><div class="asgn-stat-icon">✅</div><div class="asgn-stat-value">${withFinal.length}</div><div class="asgn-stat-label">Graded</div></div>
    </div>

    <div style="display:flex;align-items:center;gap:8px;margin-bottom:14px">
      ${syncBadge}
      <div style="margin-left:auto">
        <button class="btn assign-tab--push" style="border-radius:var(--radius);padding:8px 16px" onclick="pushAllToCanvas()">⬆ Push Final Grades to Canvas</button>
      </div>
    </div>

    <div class="card">
      <div class="card-title">Total Participation — ${esc(a.name)}</div>
      <p class="muted" style="margin-bottom:10px">Case, Sim & Presence % are auto-calculated. Panopto and Behavior are manual. Total % averages the three columns. Score /40 is the final grade pushed to Canvas.</p>
      <div class="table-wrap">
        <table>
          <thead><tr>
            <th>Student</th>
            <th style="text-align:center">Case Part. %</th>
            <th style="text-align:center">Sim Part. %</th>
            <th style="text-align:center">Class Presence %</th>
            <th style="text-align:center">Panopto</th>
            <th style="text-align:center">Behavior</th>
            <th style="text-align:center;background:var(--uw-gold);color:var(--uw-purple)">Total %</th>
            <th style="text-align:center">Score /40</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>`;
}

async function partFieldSave(studentId, field, value, max) {
  let v = value.trim() === '' ? null : Number(value);
  if (v !== null) v = Math.max(0, Math.min(max, v));
  if (!S.grades[studentId]) S.grades[studentId] = buildEmptyGrade(studentId);
  S.grades[studentId][field] = v;
  S.grades[studentId].status = 'reviewed';
  await saveGrade(studentId);
}

async function partFinalSave(studentId, value, max) {
  let v = value.trim() === '' ? null : Number(value);
  if (v !== null) v = Math.max(0, Math.min(max, v));
  if (!S.grades[studentId]) S.grades[studentId] = buildEmptyGrade(studentId);
  S.grades[studentId].finalScore = v;
  S.grades[studentId].status = 'reviewed';
  await saveGrade(studentId);
}

function potwRandomize() {
  const students = allStudents();
  if (!students.length) { toast('No students loaded.', 'warn'); return; }

  // Filter out already-picked students (unless we've exhausted the list)
  let pool = students.filter(s => !_potwPicked.includes(s.id));
  if (!pool.length) {
    _potwPicked = [];
    pool = students;
  }

  // Pick random
  const pick = pool[Math.floor(Math.random() * pool.length)];
  _potwPicked.push(pick.id);

  // Animate the result
  const resultEl = document.getElementById('potw-result');
  if (resultEl) {
    resultEl.classList.add('potw-spinning');
    let flashes = 0;
    const interval = setInterval(() => {
      const rnd = students[Math.floor(Math.random() * students.length)];
      resultEl.textContent = rnd.name;
      flashes++;
      if (flashes >= 12) {
        clearInterval(interval);
        resultEl.textContent = pick.name;
        resultEl.classList.remove('potw-spinning');
        resultEl.classList.add('potw-picked');
        setTimeout(() => resultEl.classList.remove('potw-picked'), 600);
      }
    }, 80);
  }

  // Update history
  const histEl = document.getElementById('potw-history');
  if (histEl) {
    const items = _potwPicked.map((id, i) => {
      const st = students.find(s => s.id === id);
      return `<span class="potw-history-item">${i + 1}. ${esc(st?.name || id)}</span>`;
    }).join('');
    histEl.innerHTML = `<div class="muted" style="font-size:10px;margin-top:8px;font-weight:700">PICKED SO FAR:</div>${items}`;
  }
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

        <!-- What — Example / Expected Submission -->
        <div class="card">
          <div class="card-title">What — Assignment Description
            <span class="card-title-hint">What students need to submit — paste the assignment prompt or example</span>
          </div>
          <textarea id="assignment-text-input" class="input" rows="6"
            placeholder="Paste the full assignment description, prompt, or example of what a good submission looks like…"
            onchange="autoSaveInstructions()" oninput="debounceSaveInstructions()"
          >${esc(S.assignmentText)}</textarea>
        </div>

        <!-- How — AI Grading Instructions -->
        <div class="card">
          <div class="card-title">How — AI Grading Instructions
            <span class="card-title-hint">Tell the AI how to grade — what to look for, what to penalize</span>
          </div>
          <textarea id="ai-instructions-text" class="input" rows="5"
            placeholder="Explain to the AI how to grade this assignment…

Example: 'This is a case write-up. Students MUST have an executive summary with recommendations, supporting points, and a conclusion with alternatives. Penalize missing sections heavily.'"
            onchange="autoSaveInstructions()" oninput="debounceSaveInstructions()"
          >${esc(S.aiInstructions)}</textarea>
          <div style="display:flex;gap:8px;margin-top:8px;align-items:center;flex-wrap:wrap">
            <button class="btn btn-surf" onclick="saveAiInstructions()">Save</button>
            <span id="ai-instr-status" class="muted" style="font-size:12px"></span>
          </div>
          <div class="case-reminder">
            <strong>Case Write-up Format:</strong>
            ① Executive Summary + Recommendations &nbsp;·&nbsp;
            ② Supporting Points &amp; Evidence &nbsp;·&nbsp;
            ③ Conclusion / Alternatives / Other Thoughts
          </div>

          <!-- AI Rubric Assistant -->
          <div class="ai-rubric-assist" style="margin-top:12px">
            <div style="font-size:11px;font-weight:700;color:var(--uw-purple);margin-bottom:4px">✦ ASK AI TO BUILD OR MODIFY THE RUBRIC</div>
            <div class="ai-rubric-input-row">
              <input class="input" id="ai-rubric-prompt" placeholder="e.g. 'Suggest a rubric for a case write-up worth 15 points' or 'Add a criterion for grammar'"
                onkeydown="if(event.key==='Enter')aiSuggestRubric()" />
              <button class="btn btn-surf" onclick="aiSuggestRubric()" id="ai-rubric-btn">✦ Ask AI</button>
            </div>
            <div id="ai-rubric-response" style="display:none"></div>
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
              oninput="if(S.rubric){S.rubric.totalPoints=Number(this.value);clearTimeout(_rubricSaveTimer);_rubricSaveTimer=setTimeout(()=>saveAssignmentRubric(true),2000)}" />
          </div>
          <div class="field-group" style="flex:1">
            <label>Description (for AI generation)</label>
            <input id="rubric-desc" type="text" class="input" placeholder="Describe the assignment…"
              value="${esc(rubric.description || '')}"
              oninput="if(S.rubric){S.rubric.description=this.value;clearTimeout(_rubricSaveTimer);_rubricSaveTimer=setTimeout(()=>saveAssignmentRubric(true),2000)}" />
          </div>
        </div>
        <div id="rubric-criteria-list">${criteriaHtml}</div>
        <button class="btn btn-ghost btn-add-row" onclick="addCriterion()">+ Add Criterion</button>
      </div>

    </div>`;
}

let _rubricSaveTimer = null;
function updateCriterion(id, field, value) {
  if (!S.rubric) return;
  const c = S.rubric.criteria.find(x => x.id === id);
  if (c) c[field] = value;
  if (field === 'autoGrant') document.getElementById(`cr-${id}`)?.classList.toggle('auto-grant', value);
  // Auto-save rubric with debounce
  clearTimeout(_rubricSaveTimer);
  _rubricSaveTimer = setTimeout(() => saveAssignmentRubric(true), 2000);
}

function deleteCriterion(id) {
  if (!S.rubric) return;
  S.rubric.criteria = S.rubric.criteria.filter(c => c.id !== id);
  refreshInstructionsTab();
  saveAssignmentRubric(true);
}

function addCriterion() {
  if (!S.rubric) S.rubric = defaultRubricForAssignment(S.currentAssignment);
  S.rubric.criteria.push({ id: 'c' + Date.now(), name: '', maxPoints: 3, description: '', autoGrant: false });
  refreshInstructionsTab();
  saveAssignmentRubric(true);
}

function refreshInstructionsTab() {
  const el = document.getElementById('atab-instructions');
  if (el) el.innerHTML = renderInstructionsTab();
}

let _instrSaveTimer = null;
function debounceSaveInstructions() {
  clearTimeout(_instrSaveTimer);
  _instrSaveTimer = setTimeout(autoSaveInstructions, 2000);
}
async function autoSaveInstructions() {
  clearTimeout(_instrSaveTimer);
  await saveAiInstructions(true);
}

async function saveAiInstructions(silent = false) {
  if (!S.course || !S.currentAssignment) { if (!silent) toast('No assignment selected.', 'warn'); return; }
  S.aiInstructions = document.getElementById('ai-instructions-text')?.value?.trim() || '';
  S.assignmentText = document.getElementById('assignment-text-input')?.value?.trim() || '';
  try {
    await PUT(`/api/assignment-settings/${S.course.id}/${S.currentAssignment.id}`, {
      aiInstructions: S.aiInstructions,
      assignmentText: S.assignmentText,
    });
    const el = document.getElementById('ai-instr-status');
    if (el) { el.textContent = '✓ Auto-saved'; setTimeout(() => { el.textContent = ''; }, 2000); }
    if (!silent) toast('Instructions saved.', 'success');
  } catch (e) { if (!silent) toast('Save failed: ' + e.message, 'error'); }
}

async function saveAssignmentRubric(silent = false) {
  if (!S.course || !S.currentAssignment || !S.rubric) { if (!silent) toast('No rubric to save.', 'warn'); return; }
  try {
    await PUT(`/api/assignment-rubric/${S.course.id}/${S.currentAssignment.id}`, S.rubric);
    if (!silent) toast('Rubric saved.', 'success');
  } catch (e) { if (!silent) toast('Save failed: ' + e.message, 'error'); }
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

async function aiSuggestRubric() {
  const prompt = document.getElementById('ai-rubric-prompt')?.value?.trim();
  if (!prompt) { toast('Type a request for the AI.', 'warn'); return; }
  if (!S.health?.claude) { toast('Claude not configured.', 'error'); return; }

  const btn = document.getElementById('ai-rubric-btn');
  const respBox = document.getElementById('ai-rubric-response');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Thinking...'; }
  if (respBox) { respBox.style.display = 'block'; respBox.innerHTML = '<p class="muted">AI is working...</p>'; }

  try {
    const currentRubric = S.rubric || defaultRubricForAssignment(S.currentAssignment);
    const currentCriteria = (currentRubric.criteria || []).map(c => `${c.name} (${c.maxPoints}pts): ${c.description}`).join('\n');
    const assignmentText = document.getElementById('assignment-text-input')?.value || S.currentAssignment?.name || '';
    const aiInstructions = document.getElementById('ai-instructions-text')?.value || '';

    const res = await POST('/api/rubric/ai-assist', {
      prompt,
      assignmentName: S.currentAssignment?.name || '',
      assignmentText,
      aiInstructions,
      currentCriteria,
      totalPoints: currentRubric.totalPoints || 15,
    });

    if (res.rubric) {
      // AI returned a full rubric — show preview and apply button
      const preview = res.rubric.criteria.map(c =>
        `<div class="ai-rubric-crit-preview">
          <strong>${esc(c.name)}</strong> (${c.maxPoints}pts)
          <div class="muted" style="font-size:11px">${esc(c.description)}</div>
        </div>`
      ).join('');
      respBox.innerHTML = `
        <div style="margin-bottom:8px;font-size:12px;color:var(--text)">${esc(res.message || 'AI suggested the following rubric:')}</div>
        ${preview}
        <div style="display:flex;gap:8px;margin-top:8px">
          <button class="btn btn-primary" onclick="applyAiRubricSuggestion()">Apply This Rubric</button>
          <button class="btn btn-ghost" onclick="document.getElementById('ai-rubric-response').style.display='none'">Dismiss</button>
        </div>`;
      // Store for applying
      S._aiSuggestedRubric = res.rubric;
    } else {
      respBox.innerHTML = `<div style="font-size:12px;line-height:1.5">${esc(res.message || 'Done.')}</div>`;
    }
  } catch (e) {
    if (respBox) respBox.innerHTML = `<p style="color:var(--danger);font-size:12px">Error: ${esc(e.message)}</p>`;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '✦ Ask AI'; }
  }
}

function applyAiRubricSuggestion() {
  if (!S._aiSuggestedRubric) return;
  S.rubric = { ...S._aiSuggestedRubric, id: S.rubric?.id };
  refreshInstructionsTab();
  toast('Rubric applied! Save it when ready.', 'success');
}

/* ── Students Tab ────────────────────────────────────────────────────────────── */
let _stuSort = 'name', _stuDir = 1;
function stuSort(col) { if (_stuSort === col) _stuDir *= -1; else { _stuSort = col; _stuDir = 1; } showView('assignment'); }
function stuArrow(col) { return _stuSort !== col ? '<span class="ldg-sort">⇅</span>' : _stuDir === 1 ? '<span class="ldg-sort ldg-sort-active">▲</span>' : '<span class="ldg-sort ldg-sort-active">▼</span>'; }

function renderStudentsTabHtml() {
  const students = allStudents().map(st => {
    const g = S.grades[st.id];
    return { ...st, score: g?.finalScore ?? null, status: g?.status || 'pending', flagged: g?.flagged };
  });
  if (!students.length) return '<p class="muted padded">No students loaded yet. Data loads automatically.</p>';

  students.sort((a, b) => {
    let c = 0;
    if (_stuSort === 'name') c = a.name.localeCompare(b.name);
    else if (_stuSort === 'score') c = (a.score ?? -1) - (b.score ?? -1);
    else if (_stuSort === 'status') c = a.status.localeCompare(b.status);
    return c * _stuDir;
  });

  const rows = students.map(st => {
    const sub = submissionFor(st.id);
    const g = S.grades[st.id];
    const submitted = sub && sub.workflow_state !== 'unsubmitted' ? '✓' : '—';
    const late = sub?.late ? '<span class="status-badge status--late">LATE</span>' : '';
    const statusBadge = g
      ? `<span class="status-badge status--${g.status === 'reviewed' ? 'reviewed' : 'graded'}">${g.status === 'reviewed' ? 'Reviewed' : 'AI Graded'}</span>`
      : '<span class="status-badge status--pending">Pending</span>';
    const flag = g?.flagged ? '<span class="ai-badge ai-badge--flagged">⚑ AI</span>' : '';
    const final = g?.finalScore != null ? `<strong>${g.finalScore}</strong>` : '—';

    return `<tr>
      <td><span class="stu-avatar-wrap">${studentAvatar(st)}<button class="link-btn" onclick="openStudent('${esc(st.id)}')">${esc(st.name)}</button></span></td>
      <td style="text-align:center">${submitted}</td>
      <td>${late}</td>
      <td>${statusBadge} ${flag}</td>
      <td style="text-align:center">${final} ${S.rubric ? '/ ' + S.rubric.totalPoints : ''}</td>
      <td><button class="btn btn-surf-sec" style="font-size:11px;padding:4px 8px" onclick="openStudent('${esc(st.id)}')">View/Grade</button></td>
    </tr>`;
  }).join('');

  return `<table>
    <thead><tr>
      <th class="ldg-sortable" onclick="stuSort('name')">Student ${stuArrow('name')}</th>
      <th>Submitted</th><th>Status</th>
      <th class="ldg-sortable" onclick="stuSort('status')">Grade Status ${stuArrow('status')}</th>
      <th class="ldg-sortable" onclick="stuSort('score')">Score ${stuArrow('score')}</th>
      <th></th>
    </tr></thead>
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
      <td class="col-sticky"><span class="stu-avatar-wrap">${studentAvatar(st, 20)}<button class="link-btn" onclick="openStudent('${esc(st.id)}')">${esc(st.name)}</button></span></td>
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

/* ── Case Discussion Participation Tab ──────────────────────────────────────── */
const PART_BUCKETS = [
  { key: 0, label: 'Did Not Participate', color: '#dc2626', bg: '#fef2f2' },
  { key: 1, label: 'Low Participation',   color: '#d97706', bg: '#fffbeb' },
  { key: 2, label: 'Participated',         color: '#2563eb', bg: '#eff6ff' },
  { key: 3, label: 'Excellent',            color: '#16a34a', bg: '#f0fdf4' },
];

function renderParticipationTab() {
  const students = allStudents();
  if (!students.length) return '<p class="muted padded">No students loaded.</p>';

  // Get participation data from grades
  const buckets = { 0: [], 1: [], 2: [], 3: [] };
  const assigned = new Set();
  students.forEach(st => {
    const g = S.grades[st.id];
    const p = g?.participation;
    if (p != null && p >= 0 && p <= 3) {
      buckets[p].push(st);
      assigned.add(st.id);
    }
  });
  // Unassigned students go to a pool
  const unassigned = students.filter(st => !assigned.has(st.id));

  const poolHtml = unassigned.map(st =>
    `<div class="part-student" draggable="true" ondragstart="partDragStart(event,'${esc(st.id)}')" id="part-${esc(st.id)}">${studentAvatar(st, 18)}${esc(st.name)}</div>`
  ).join('');

  const bucketsHtml = PART_BUCKETS.map(b => {
    const items = buckets[b.key].map(st =>
      `<div class="part-student" draggable="true" ondragstart="partDragStart(event,'${esc(st.id)}')" id="part-${esc(st.id)}">${studentAvatar(st, 18)}${esc(st.name)}</div>`
    ).join('');
    return `<div class="part-bucket" style="border-top:3px solid ${b.color};background:${b.bg}"
      ondragover="event.preventDefault();this.classList.add('part-bucket-over')"
      ondragleave="this.classList.remove('part-bucket-over')"
      ondrop="partDrop(event,${b.key});this.classList.remove('part-bucket-over')">
      <div class="part-bucket-hdr" style="color:${b.color}">${b.label} <span class="part-bucket-score">(${b.key} pts)</span></div>
      <div class="part-bucket-count">${buckets[b.key].length}</div>
      <div class="part-bucket-items" id="part-bucket-${b.key}">${items}</div>
    </div>`;
  }).join('');

  return `
    <div class="part-container">
      <div class="part-pool">
        <div class="part-pool-hdr">Unassigned Students (${unassigned.length})</div>
        <div class="part-pool-items" id="part-pool"
          ondragover="event.preventDefault();this.classList.add('part-bucket-over')"
          ondragleave="this.classList.remove('part-bucket-over')"
          ondrop="partDrop(event,-1);this.classList.remove('part-bucket-over')">
          ${poolHtml || '<p class="muted" style="font-size:11px;text-align:center;padding:8px">All students assigned</p>'}
        </div>
      </div>
      <div class="part-buckets">${bucketsHtml}</div>
      <div style="margin-top:10px;display:flex;gap:8px">
        <button class="btn btn-surf" onclick="saveAllParticipation()">Save Participation Scores</button>
        <button class="btn btn-ghost" onclick="resetParticipation()">Reset All</button>
      </div>
    </div>`;
}

let _partDragId = null;
function partDragStart(e, studentId) {
  _partDragId = studentId;
  e.dataTransfer.effectAllowed = 'move';
}

async function partDrop(e, bucketKey) {
  e.preventDefault();
  if (!_partDragId) return;
  const studentId = _partDragId;
  _partDragId = null;

  if (!S.grades[studentId]) S.grades[studentId] = buildEmptyGrade(studentId);
  if (bucketKey === -1) {
    delete S.grades[studentId].participation;
  } else {
    S.grades[studentId].participation = bucketKey;
  }
  S.grades[studentId].status = 'reviewed';
  // Auto-save immediately
  await saveGrade(studentId);
  // Re-render participation tab
  const el = document.getElementById('atab-participation');
  if (el) el.innerHTML = renderParticipationTab();
}

async function saveAllParticipation() {
  const students = allStudents();
  const saves = [];
  for (const st of students) {
    if (S.grades[st.id]?.participation != null) {
      S.grades[st.id].status = 'reviewed';
      saves.push(saveGrade(st.id));
    }
  }
  await Promise.all(saves);
  toast(`Saved participation for ${saves.length} students.`, 'success');
}

function resetParticipation() {
  if (!confirm('Reset all participation for this assignment?')) return;
  allStudents().forEach(st => {
    if (S.grades[st.id]) delete S.grades[st.id].participation;
  });
  const el = document.getElementById('atab-participation');
  if (el) el.innerHTML = renderParticipationTab();
  toast('Participation reset.', 'success');
}

/* ── Simulation Participation Tab (drag-drop, same as Case) ────────────────── */
function renderSimParticipationTab() {
  const students = allStudents();
  if (!students.length) return '<p class="muted padded">No students loaded.</p>';

  const buckets = { 0: [], 1: [], 2: [], 3: [] };
  const assigned = new Set();
  students.forEach(st => {
    const g = S.grades[st.id];
    const p = g?.simParticipation;
    if (p != null && p >= 0 && p <= 3) { buckets[p].push(st); assigned.add(st.id); }
  });
  const unassigned = students.filter(st => !assigned.has(st.id));

  const poolHtml = unassigned.map(st =>
    `<div class="part-student" draggable="true" ondragstart="simPartDragStart(event,'${esc(st.id)}')" id="simpart-${esc(st.id)}">${studentAvatar(st, 18)}${esc(st.name)}</div>`
  ).join('');

  const bucketsHtml = PART_BUCKETS.map(b => {
    const items = buckets[b.key].map(st =>
      `<div class="part-student" draggable="true" ondragstart="simPartDragStart(event,'${esc(st.id)}')" id="simpart-${esc(st.id)}">${studentAvatar(st, 18)}${esc(st.name)}</div>`
    ).join('');
    return `<div class="part-bucket" style="border-top:3px solid ${b.color};background:${b.bg}"
      ondragover="event.preventDefault();this.classList.add('part-bucket-over')"
      ondragleave="this.classList.remove('part-bucket-over')"
      ondrop="simPartDrop(event,${b.key});this.classList.remove('part-bucket-over')">
      <div class="part-bucket-hdr" style="color:${b.color}">${b.label} <span class="part-bucket-score">(${b.key} pts)</span></div>
      <div class="part-bucket-count">${buckets[b.key].length}</div>
      <div class="part-bucket-items" id="simpart-bucket-${b.key}">${items}</div>
    </div>`;
  }).join('');

  return `<div class="part-container">
    <div class="part-pool">
      <div class="part-pool-hdr">Unassigned Students (${unassigned.length})</div>
      <div class="part-pool-items" id="simpart-pool"
        ondragover="event.preventDefault();this.classList.add('part-bucket-over')"
        ondragleave="this.classList.remove('part-bucket-over')"
        ondrop="simPartDrop(event,-1);this.classList.remove('part-bucket-over')">
        ${poolHtml || '<p class="muted" style="font-size:11px;text-align:center;padding:8px">All students assigned</p>'}
      </div>
    </div>
    <div class="part-buckets">${bucketsHtml}</div>
    <div style="margin-top:10px;display:flex;gap:8px">
      <button class="btn btn-surf" onclick="saveAllSimParticipation()">Save Simulation Participation</button>
      <button class="btn btn-ghost" onclick="resetSimParticipation()">Reset All</button>
    </div>
  </div>`;
}

let _simPartDragId = null;
function simPartDragStart(e, studentId) { _simPartDragId = studentId; e.dataTransfer.effectAllowed = 'move'; }

async function simPartDrop(e, bucketKey) {
  e.preventDefault();
  if (!_simPartDragId) return;
  const studentId = _simPartDragId; _simPartDragId = null;
  if (!S.grades[studentId]) S.grades[studentId] = buildEmptyGrade(studentId);
  if (bucketKey === -1) delete S.grades[studentId].simParticipation;
  else S.grades[studentId].simParticipation = bucketKey;
  S.grades[studentId].status = 'reviewed';
  await saveGrade(studentId);
  const el = document.getElementById('atab-simparticipation');
  if (el) el.innerHTML = renderSimParticipationTab();
}

async function saveAllSimParticipation() {
  const saves = [];
  allStudents().forEach(st => {
    if (S.grades[st.id]?.simParticipation != null) { S.grades[st.id].status = 'reviewed'; saves.push(saveGrade(st.id)); }
  });
  await Promise.all(saves);
  toast(`Saved simulation participation for ${saves.length} students.`, 'success');
}

function resetSimParticipation() {
  if (!confirm('Reset all simulation participation for this assignment?')) return;
  allStudents().forEach(st => { if (S.grades[st.id]) delete S.grades[st.id].simParticipation; });
  const el = document.getElementById('atab-simparticipation');
  if (el) el.innerHTML = renderSimParticipationTab();
  toast('Simulation participation reset.', 'success');
}

/* ── Simulation Participation View (Instructor Tool) ───────────────────────── */
function renderSimParticipationView(root) {
  root = root || document.getElementById('view-root');
  const students = S.allStudentsList.length ? S.allStudentsList : allStudents();
  const actAssignments = S.assignments
    .filter(a => classifyAssignment(a) === 'Activities')
    .sort((a, b) => new Date(a.due_at || 0) - new Date(b.due_at || 0));

  if (!actAssignments.length) {
    root.innerHTML = '<div class="page-title">Simulation Participation</div><p class="muted padded">No activity/simulation assignments found.</p>';
    return;
  }

  const partLabels = ['—', 'Low', 'Part.', 'Exc.'];
  const partColors = ['var(--danger)', 'var(--warn)', 'var(--info)', 'var(--success)'];

  const rows = students.map(st => {
    let totalPts = 0, totalMax = 0;
    const cells = actAssignments.map(a => {
      const g = (S.allGrades[String(a.id)] || {})[st.id];
      const p = g?.simParticipation;
      totalMax += 3;
      if (p != null) totalPts += p;
      if (p == null) return '<td class="ldg-cell ldg-empty" style="text-align:center">—</td>';
      return `<td class="ldg-cell" style="text-align:center;font-weight:700;color:${partColors[p]}">${p} <span style="font-size:9px;font-weight:400">${partLabels[p]}</span></td>`;
    }).join('');
    const pct = totalMax ? Math.round((totalPts / totalMax) * 100) : null;
    return `<tr>
      <td class="ldg-name"><span class="stu-avatar-wrap">${studentAvatar(st, 18)}${esc(st.name)}</span></td>
      <td style="text-align:center;font-weight:700;color:var(--uw-purple)">${totalPts}</td>
      <td style="text-align:center;font-weight:700">${totalMax}</td>
      <td style="text-align:center;font-weight:700;color:${pct != null && pct < 50 ? 'var(--danger)' : 'var(--success)'}">${pct != null ? pct + '%' : '—'}</td>
      ${cells}
    </tr>`;
  }).join('');

  const headers = actAssignments.map(a =>
    `<th style="text-align:center;font-size:10px;padding:5px 8px;min-width:70px;white-space:normal;line-height:1.3" title="${esc(a.name)}">
      <button class="link-btn" style="font-size:10px" onclick="selectAssignment('${a.id}')">${esc(a.name)}</button>
    </th>`
  ).join('');

  root.innerHTML = `
    <div class="page-title">Simulation Participation — ${esc(S.course?.name || '')}
      <div class="page-actions"><button class="btn btn-ghost" onclick="renderSimParticipationView()">⟳ Refresh</button></div>
    </div>
    <div class="muted" style="margin-bottom:10px">Scores: 0 = Did Not Participate, 1 = Low, 2 = Participated, 3 = Excellent. Click an activity name to open and grade.</div>
    <div class="ldg-wrap"><table class="ldg-table">
      <thead><tr>
        <th class="ldg-name-hdr">Student</th>
        <th style="text-align:center;background:var(--uw-purple);color:#fff;min-width:50px">Total</th>
        <th style="text-align:center;background:var(--uw-purple);color:#fff;min-width:50px">Max</th>
        <th style="text-align:center;background:var(--uw-purple);color:#fff;min-width:50px">%</th>
        ${headers}
      </tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
}

/* ── Class Presence & Participation ─────────────────────────────────────────── */
let _presenceData = {}; // cached presence data for course
let _presenceDate = null; // selected class date

const PRESENCE_BUCKETS = [
  { key: 0, label: 'Absent',     color: '#dc2626', bg: '#fef2f2' },
  { key: 1, label: 'Tuned Out',  color: '#d97706', bg: '#fffbeb' },
  { key: 2, label: 'Attentive',  color: '#2563eb', bg: '#eff6ff' },
  { key: 3, label: 'Engaged',    color: '#16a34a', bg: '#f0fdf4' },
];

function getLastClassDate() {
  // Find the most recent class date from syllabus that's before 5:30 PM PST today
  const now = new Date();
  const cutoff = new Date(now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  cutoff.setHours(17, 30, 0, 0);
  const nowPST = new Date(now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));

  const dates = (S.syllabus || [])
    .filter(r => r.date && !r.isCancelled)
    .map(r => r.date)
    .filter((d, i, a) => a.indexOf(d) === i)
    .sort();

  // If current time is past 5:30 PM, today's class is done — include today
  // Otherwise, exclude today
  const todayStr = nowPST.toISOString().slice(0, 10);
  const pastDates = dates.filter(d => {
    if (d < todayStr) return true;
    if (d === todayStr && nowPST >= cutoff) return true;
    return false;
  });
  return pastDates.length ? pastDates[pastDates.length - 1] : dates[0] || todayStr;
}

function getClassDates() {
  return (S.syllabus || [])
    .filter(r => r.date && !r.isCancelled)
    .map(r => r.date)
    .filter((d, i, a) => a.indexOf(d) === i)
    .sort();
}

async function renderClassPresenceView(root) {
  root = root || document.getElementById('view-root');
  if (!S.course) { root.innerHTML = '<p class="muted padded">Select a course first.</p>'; return; }

  // Load presence data
  try { _presenceData = await GET(`/api/presence/${S.course.id}`); } catch { _presenceData = {}; }
  if (!_presenceDate) _presenceDate = getLastClassDate();

  _renderPresenceUI(root);
}

function _renderPresenceUI(root) {
  root = root || document.getElementById('view-root');
  const students = S.allStudentsList.length ? S.allStudentsList : allStudents();
  const classDates = getClassDates();
  const dateData = _presenceData[_presenceDate] || {};

  // Date dropdown
  const dateOptions = classDates.map(d => {
    const label = new Date(d + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    return `<option value="${d}" ${d === _presenceDate ? 'selected' : ''}>${label}</option>`;
  }).join('');

  // Build buckets
  const buckets = { 0: [], 1: [], 2: [], 3: [] };
  const assigned = new Set();
  students.forEach(st => {
    const p = dateData[st.id];
    if (p != null && p >= 0 && p <= 3) { buckets[p].push(st); assigned.add(st.id); }
  });
  const unassigned = students.filter(st => !assigned.has(st.id));

  const poolHtml = unassigned.map(st =>
    `<div class="part-student" draggable="true" ondragstart="presDragStart(event,'${esc(st.id)}')">${studentAvatar(st, 18)}${esc(st.name)}</div>`
  ).join('');

  const bucketsHtml = PRESENCE_BUCKETS.map(b => {
    const items = buckets[b.key].map(st =>
      `<div class="part-student" draggable="true" ondragstart="presDragStart(event,'${esc(st.id)}')">${studentAvatar(st, 18)}${esc(st.name)}</div>`
    ).join('');
    return `<div class="part-bucket" style="border-top:3px solid ${b.color};background:${b.bg}"
      ondragover="event.preventDefault();this.classList.add('part-bucket-over')"
      ondragleave="this.classList.remove('part-bucket-over')"
      ondrop="presDrop(event,${b.key});this.classList.remove('part-bucket-over')">
      <div class="part-bucket-hdr" style="color:${b.color}">${b.label} <span class="part-bucket-score">(${b.key} pts)</span></div>
      <div class="part-bucket-count">${buckets[b.key].length}</div>
      <div class="part-bucket-items">${items}</div>
    </div>`;
  }).join('');

  // Summary table — all dates
  const allDates = classDates.filter(d => _presenceData[d] && Object.keys(_presenceData[d]).length > 0);
  let summaryHtml = '';
  if (allDates.length) {
    const presLabels = ['Abs', 'Out', 'Att', 'Eng'];
    const presColors = ['var(--danger)', 'var(--warn)', 'var(--info)', 'var(--success)'];
    const sRows = students.map(st => {
      let pts = 0, maxPts = 0;
      const cells = allDates.map(d => {
        const p = _presenceData[d]?.[st.id];
        if (p == null) return '<td class="ldg-cell ldg-empty" style="text-align:center">—</td>';
        pts += p; maxPts += 3;
        return `<td class="ldg-cell" style="text-align:center;font-weight:700;color:${presColors[p]}">${p}<span style="font-size:9px;font-weight:400"> ${presLabels[p]}</span></td>`;
      }).join('');
      const pct = maxPts ? Math.round((pts / maxPts) * 100) : null;
      return `<tr>
        <td class="ldg-name"><span class="stu-avatar-wrap">${studentAvatar(st, 18)}${esc(st.name)}</span></td>
        <td style="text-align:center;font-weight:700;color:var(--uw-purple)">${pts}</td>
        <td style="text-align:center">${maxPts}</td>
        <td style="text-align:center;font-weight:700;color:${pct != null && pct < 50 ? 'var(--danger)' : 'var(--success)'}">${pct != null ? pct + '%' : '—'}</td>
        ${cells}
      </tr>`;
    }).join('');
    const dateHeaders = allDates.map(d => {
      const lbl = new Date(d + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      return `<th style="text-align:center;font-size:10px;padding:5px 6px;white-space:nowrap">${lbl}</th>`;
    }).join('');
    summaryHtml = `<div class="card" style="margin-top:16px">
      <div class="card-title">Presence Summary — All Classes</div>
      <div class="ldg-wrap"><table class="ldg-table"><thead><tr>
        <th class="ldg-name-hdr">Student</th>
        <th style="text-align:center;background:var(--uw-purple);color:#fff;min-width:40px">Pts</th>
        <th style="text-align:center;background:var(--uw-purple);color:#fff;min-width:40px">Max</th>
        <th style="text-align:center;background:var(--uw-purple);color:#fff;min-width:40px">%</th>
        ${dateHeaders}
      </tr></thead><tbody>${sRows}</tbody></table></div>
    </div>`;
  }

  const sessionLabel = _presenceDate ? new Date(_presenceDate + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }) : '—';

  root.innerHTML = `
    <div class="page-title">Class Presence & Participation
      <div class="page-actions"><button class="btn btn-ghost" onclick="renderClassPresenceView()">⟳ Refresh</button></div>
    </div>

    <div style="display:flex;gap:12px;align-items:center;margin-bottom:14px;flex-wrap:wrap">
      <label style="font-size:13px;font-weight:700;color:var(--uw-purple)">Class Date:</label>
      <select class="input" style="width:220px" onchange="_presenceDate=this.value;_renderPresenceUI()">${dateOptions}</select>
      <span style="font-size:14px;font-weight:600">${sessionLabel}</span>
    </div>

    <div class="part-container">
      <div class="part-pool">
        <div class="part-pool-hdr">Not Scored — ${unassigned.length} students (won't count toward %)</div>
        <div class="part-pool-items" id="pres-pool"
          ondragover="event.preventDefault();this.classList.add('part-bucket-over')"
          ondragleave="this.classList.remove('part-bucket-over')"
          ondrop="presDrop(event,-1);this.classList.remove('part-bucket-over')">
          ${poolHtml || '<p class="muted" style="font-size:11px;text-align:center;padding:8px">All students scored</p>'}
        </div>
      </div>
      <div class="part-buckets">${bucketsHtml}</div>
      <div style="margin-top:10px;display:flex;gap:8px">
        <button class="btn btn-surf" onclick="savePresence()">Save Presence for ${esc(sessionLabel)}</button>
        <button class="btn btn-ghost" onclick="resetPresence()">Reset This Date</button>
      </div>
    </div>

    ${summaryHtml}`;
}

let _presDragId = null;
function presDragStart(e, id) { _presDragId = id; e.dataTransfer.effectAllowed = 'move'; }

async function presDrop(e, bucketKey) {
  e.preventDefault();
  if (!_presDragId) return;
  const sid = _presDragId; _presDragId = null;
  if (!_presenceData[_presenceDate]) _presenceData[_presenceDate] = {};
  if (bucketKey === -1) delete _presenceData[_presenceDate][sid];
  else _presenceData[_presenceDate][sid] = bucketKey;
  _renderPresenceUI();
  // Auto-save immediately
  if (S.course) await PUT(`/api/presence/${S.course.id}/${_presenceDate}`, _presenceData[_presenceDate] || {});
}

async function savePresence() {
  if (!S.course || !_presenceDate) return;
  await PUT(`/api/presence/${S.course.id}/${_presenceDate}`, _presenceData[_presenceDate] || {});
  toast(`Presence saved for ${_presenceDate}.`, 'success');
}

function resetPresence() {
  if (!confirm('Reset presence for this date?')) return;
  _presenceData[_presenceDate] = {};
  _renderPresenceUI();
}

function getPresencePct(studentId) {
  let pts = 0, maxPts = 0;
  Object.values(_presenceData).forEach(dateData => {
    const p = dateData[studentId];
    if (p != null) { pts += p; maxPts += 3; }
  });
  return maxPts ? Math.round((pts / maxPts) * 100) : null;
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
  const userName = displayName(S.me?.username || 'You');
  const chatHtml = oboChatMessages.map(m => {
    const name = displayName(m.from);
    const isMe = name === userName;
    const bg = authorColor(name);
    return `<div class="obo-chat-msg ${isMe ? 'obo-chat-right' : 'obo-chat-left'}">
      <div class="obo-chat-avatar" style="background:${bg}">${name[0].toUpperCase()}</div>
      <div class="obo-chat-bubble-wrap">
        <div class="obo-chat-author" style="color:${bg}">${esc(name)}</div>
        <div class="obo-chat-bubble" style="background:${isMe ? bg : ''};color:${isMe ? '#fff' : ''};border-color:${bg}">${esc(m.text)}</div>
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
          <button class="btn btn-grade-ai" id="obo-grade-ai-btn" onclick="oboGradeWithAi()">✦ Grade with AI</button>
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

          <!-- AI Student Feedback -->
          <div class="card obo-student-feedback-card">
            <div class="card-title">Student Feedback
              <span class="card-title-hint">One paragraph explaining the grade — shared with student</span>
              <button class="btn btn-ghost" style="font-size:11px;padding:3px 8px;margin-left:auto" onclick="oboGenerateFeedback()">✦ AI Generate</button>
            </div>
            <textarea class="input" id="obo-student-feedback" rows="3"
              placeholder="Write or generate a paragraph explaining this grade to the student…"
              onchange="oboSaveFeedbackField()" oninput="clearTimeout(S._fbTimer);S._fbTimer=setTimeout(oboSaveFeedbackField,2000)">${esc(g?.studentFeedback || '')}</textarea>
          </div>

          <!-- Marco & Marlowe Discussion -->
          <div class="obo-chat-card card">
            <div class="card-title">Marco & Marlowe — Grading Discussion & Private Notes</div>
            <div class="obo-chat-messages" id="obo-chat-messages">${chatHtml || '<p class="muted" style="text-align:center;padding:12px">Discuss this grade privately...</p>'}</div>
            <div class="obo-chat-input-row">
              <input class="input obo-chat-input" id="obo-chat-input" placeholder="Type a note..." onkeydown="if(event.key==='Enter')oboSendChat()" />
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
    if (sub.attachments?.length) {
      // Extract ALL attachments (concatenate text from each)
      subsToExtract.push({ sub, attachments: sub.attachments, studentId: st.id, studentName: st.name });
    } else if (sub.body) {
      // Has inline body — check it's not empty HTML
      const clean = sub.body.replace(/<[^>]*>/g, '').trim();
      if (!clean) subsToExtract.push({ sub, attachments: [], studentId: st.id, studentName: st.name, emptyBody: true });
    }
  });

  // Show loading overlay in the tab
  const el = document.getElementById('atab-oneByOne');
  if (!el) return;
  const total = students.length;
  const toExtract = subsToExtract.filter(s => s.attachments.length > 0).length;
  el.innerHTML = `<div class="obo-loading">
    <div class="obo-loading-spinner"></div>
    <div class="obo-loading-text">Loading ${total} students, extracting ${toExtract} file submissions...</div>
    <div class="obo-loading-sub" id="obo-loading-progress">Extracting documents... 0 / ${toExtract}</div>
    <div class="obo-loading-detail muted" id="obo-loading-detail" style="font-size:11px;margin-top:4px"></div>
  </div>`;

  if (!toExtract && !subsToExtract.length) {
    refreshOneByOneTab();
    return;
  }

  let done = 0;
  let errors = 0;
  for (const item of subsToExtract) {
    if (!item.attachments.length) continue;
    const detailEl = document.getElementById('obo-loading-detail');
    if (detailEl) detailEl.textContent = item.studentName + ' — ' + (item.attachments[0].display_name || item.attachments[0].filename || 'file');
    try {
      // Extract all attachments and concatenate
      let allText = '';
      for (const att of item.attachments) {
        try {
          const res = await POST('/api/canvas/extract-text', { url: att.url, filename: att.display_name || att.filename });
          if (res.text) allText += (allText ? '\n\n--- Next File ---\n\n' : '') + res.text;
        } catch (e) {
          console.warn('Extract failed for', att.display_name || att.filename, e.message);
          errors++;
        }
      }
      if (allText) item.sub._extractedText = allText;
    } catch (e) {
      console.warn('Extract batch error for', item.studentName, e.message);
      errors++;
    }
    done++;
    const prog = document.getElementById('obo-loading-progress');
    if (prog) prog.textContent = `Extracting documents... ${done} / ${toExtract}`;
  }

  // Now run AI detection on all submissions that have text
  const progEl = document.getElementById('obo-loading-progress');
  if (progEl) progEl.textContent = 'Running AI detection on submissions...';
  const detailEl2 = document.getElementById('obo-loading-detail');

  let aiDone = 0;
  for (const st of students) {
    const text = submissionText(submissionFor(st.id));
    if (!text || S.grades[st.id]?.aiDetection) continue;
    if (detailEl2) detailEl2.textContent = st.name;
    try {
      const det = await POST('/api/ai-detect', { text });
      if (!S.grades[st.id]) S.grades[st.id] = buildEmptyGrade(st.id);
      S.grades[st.id].aiDetection = det;
      S.grades[st.id].flagged = det.pct >= 80;
      aiDone++;
    } catch { /* skip */ }
  }

  // Re-render
  refreshOneByOneTab();
  toast(`Extracted ${done} submissions${errors ? ` (${errors} errors)` : ''}, AI detection on ${aiDone} students.`, 'success');
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
      isCaseWriteup: classifyAssignment(S.currentAssignment) === 'Cases',
    });
    applyAiGrade(st.id, res.grade, res.aiDetection, res.flagged);
    await saveGrade(st.id);
    refreshOneByOneTab();
    toast('AI grading complete!', 'success');
  } catch (e) { toast('Grading error: ' + e.message, 'error'); }
  finally { if (btn) { btn.disabled = false; btn.textContent = '✦ Grade with AI'; } }
}

async function oboGenerateFeedback() {
  const students = allStudents();
  const st = students[oboIndex];
  if (!st) return;
  const g = S.grades[st.id];
  if (!g || !S.rubric) { toast('Grade the student first.', 'warn'); return; }
  if (!S.health?.claude) { toast('Claude not configured.', 'error'); return; }

  const btn = document.querySelector('[onclick="oboGenerateFeedback()"]');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Generating...'; }

  try {
    // Build context from criteria scores and justifications
    const criteriaContext = S.rubric.criteria.map(c => {
      const cd = g.criteria?.[c.id] || {};
      const score = cd.aiScore ?? cd.marcoScore ?? cd.marlowScore ?? '—';
      return `${c.name}: ${score}/${c.maxPoints}${cd.aiJustification ? ' — ' + cd.aiJustification : ''}`;
    }).join('\n');

    const res = await POST('/api/grade/feedback', {
      studentName: st.name,
      assignmentName: S.currentAssignment?.name || 'Assignment',
      totalScore: g.finalScore ?? '—',
      totalPossible: S.rubric.totalPoints,
      criteriaContext,
      overallFeedback: g.aiOverallFeedback || '',
    });

    const fb = document.getElementById('obo-student-feedback');
    if (fb) fb.value = res.feedback;
    if (!S.grades[st.id]) S.grades[st.id] = buildEmptyGrade(st.id);
    S.grades[st.id].studentFeedback = res.feedback;
    await saveGrade(st.id);
    toast('Feedback generated!', 'success');
  } catch (e) { toast('Feedback generation failed: ' + e.message, 'error'); }
  finally { if (btn) { btn.disabled = false; btn.textContent = '✦ AI Generate'; } }
}

function oboSaveFeedbackField() {
  const students = allStudents();
  const st = students[oboIndex];
  if (!st) return;
  const fb = document.getElementById('obo-student-feedback')?.value || '';
  if (!S.grades[st.id]) S.grades[st.id] = buildEmptyGrade(st.id);
  S.grades[st.id].studentFeedback = fb;
  saveGrade(st.id);
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
  const userName = displayName(S.me?.username || 'You');
  oboChatMessages.push({ from: userName, text, time: new Date().toLocaleTimeString() });
  input.value = '';
  renderOboChatMessages();
}

function renderOboChatMessages() {
  const container = document.getElementById('obo-chat-messages');
  if (!container) return;
  const userName = displayName(S.me?.username || 'You');
  container.innerHTML = oboChatMessages.map(m => {
    const name = displayName(m.from);
    const isMe = name === userName;
    const bg = authorColor(name);
    return `<div class="obo-chat-msg ${isMe ? 'obo-chat-right' : 'obo-chat-left'}">
      <div class="obo-chat-avatar" style="background:${bg}">${name[0].toUpperCase()}</div>
      <div class="obo-chat-bubble-wrap">
        <div class="obo-chat-author" style="color:${bg}">${esc(name)}</div>
        <div class="obo-chat-bubble" style="background:${isMe ? bg : ''};color:${isMe ? '#fff' : ''};border-color:${bg}">${esc(m.text)}</div>
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
  let aiT = 0, marT = 0, mrlT = 0, hasMarco = false, hasMarlow = false, finalT = 0;
  S.rubric.criteria.forEach(c => {
    const cd = g.criteria?.[c.id] || {};
    // AI total
    if (cd.aiScore != null) aiT += cd.aiScore;
    // Marco total (fills from AI where Marco didn't score)
    if (cd.marcoScore != null) { marT += cd.marcoScore; hasMarco = true; }
    else if (cd.aiScore != null) marT += cd.aiScore;
    // Marlowe total (fills from Marco then AI where Marlowe didn't score)
    if (cd.marlowScore != null) { mrlT += cd.marlowScore; hasMarlow = true; }
    else if (cd.marcoScore != null) mrlT += cd.marcoScore;
    else if (cd.aiScore != null) mrlT += cd.aiScore;

    // Per-criterion final: if both Marco & Marlowe scored, average (round up).
    // If only one scored, use that. Otherwise AI.
    const mScore = cd.marcoScore;
    const wScore = cd.marlowScore;
    if (mScore != null && wScore != null) {
      finalT += Math.ceil((mScore + wScore) / 2);
    } else if (wScore != null) {
      finalT += wScore;
    } else if (mScore != null) {
      finalT += mScore;
    } else if (cd.aiScore != null) {
      finalT += cd.aiScore;
    }
  });
  g.aiTotalScore      = aiT;
  g.marcoTotalScore   = hasMarco  ? marT : null;
  g.marloweTotalScore = hasMarlow ? mrlT : null;
  // Final: per-criterion merge (Marco/Marlowe override AI, both→average rounded up)
  // Fall back to canvas if nothing else
  g.finalScore = (hasMarco || hasMarlow || aiT > 0) ? finalT
               : g.canvasScore != null ? g.canvasScore
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
      body: JSON.stringify({ submissions, rubric: S.rubric, aiInstructions: S.aiInstructions, isCaseWriteup: classifyAssignment(S.currentAssignment) === 'Cases' }),
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
      isCaseWriteup: classifyAssignment(S.currentAssignment) === 'Cases',
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

function displayName(name) {
  const n = (name || '').toLowerCase();
  if (n === 'marco') return 'Marco';
  if (n === 'marlowe') return 'Marlowe';
  return name || '';
}

function authorColor(name) {
  const n = (name || '').toLowerCase();
  if (n === 'marco')   return '#2563eb';  // blue
  if (n === 'marlowe') return '#16a34a';  // green
  const colors = ['#7c3aed','#d97706','#dc2626','#0891b2'];
  let h = 0; for (let c of name) h = (h * 31 + c.charCodeAt(0)) & 0xffff;
  return colors[h % colors.length];
}

function renderChatMessages(comments) {
  const me = displayName(S.me?.username || '');
  if (!comments.length) return '<p class="muted" style="padding:16px;text-align:center">No notes yet. Be the first to add one.</p>';
  return comments.map(c => {
    const name = displayName(c.author);
    const isMe = name.toLowerCase() === me.toLowerCase();
    const color = authorColor(name);
    const time  = new Date(c.ts).toLocaleString('en-US', { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' });
    const initial = (name || '?')[0].toUpperCase();
    return `<div class="chat-msg ${isMe ? 'chat-msg-me' : 'chat-msg-them'}">
      ${!isMe ? `<div class="chat-avatar" style="background:${color}" title="${esc(name)}">${initial}</div>` : ''}
      <div class="chat-bubble-wrap">
        ${!isMe ? `<div class="chat-author" style="color:${color}">${esc(name)}</div>` : ''}
        <div class="chat-bubble ${isMe ? 'chat-bubble-me' : 'chat-bubble-them'}" style="${isMe ? `background:${color}` : `border-color:${color}`}">
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

    <!-- Harvard Business Publishing -->
    <div class="card">
      <div class="card-title">📚 Harvard Business Publishing — Course Pack</div>
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <a href="https://hbsp.harvard.edu/import/1403560" target="_blank" class="btn btn-surf" style="font-size:13px;padding:8px 16px">Open HBS Course Pack ↗</a>
        <span class="muted" style="font-size:12px">Cases, simulations, and readings for B BUS 464</span>
      </div>
    </div>

    <!-- Textbook for AI -->
    <div class="card">
      <div class="card-title">📖 Textbook (for AI grading context)
        <span class="card-title-hint">Upload textbook content so AI can reference it when grading</span>
      </div>
      <div id="textbook-status"></div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:8px">
        <input type="file" id="textbook-file" accept=".pdf,.docx,.doc,.txt,.md" style="font-size:12px" />
        <button class="btn btn-surf" onclick="uploadTextbook()">Upload Textbook</button>
        <button class="btn btn-ghost btn-danger" onclick="deleteTextbook()">Remove</button>
      </div>
    </div>

    <!-- Canvas Analytics -->
    <div class="card">
      <div class="card-title">📊 Canvas Student Analytics
        <div style="margin-left:auto"><button class="btn btn-surf" style="font-size:12px" onclick="loadCanvasAnalytics()">Load Analytics</button></div>
      </div>
      <div id="canvas-analytics"><p class="muted">Click Load Analytics to pull student engagement data from Canvas.</p></div>
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

  // Load textbook status
  loadTextbookStatus();
}

function togglePanopto() {
  const container = document.getElementById('panopto-container');
  const hint      = document.getElementById('panopto-closed');
  if (!container) return;
  const isOpen = container.style.display !== 'none';
  container.style.display = isOpen ? 'none' : 'block';
  if (hint) hint.style.display = isOpen ? 'block' : 'none';
}

async function loadTextbookStatus() {
  const el = document.getElementById('textbook-status');
  if (!el) return;
  try {
    const tb = await GET('/api/textbook');
    if (tb.text) {
      el.innerHTML = `<div style="font-size:12px;color:var(--success);font-weight:600">✓ Textbook loaded: ${esc(tb.filename)} (${(tb.text.length / 1000).toFixed(0)}K chars)</div>`;
    } else {
      el.innerHTML = '<div class="muted" style="font-size:12px">No textbook uploaded yet.</div>';
    }
  } catch { if (el) el.innerHTML = '<div class="muted" style="font-size:12px">No textbook uploaded yet.</div>'; }
}

async function uploadTextbook() {
  const file = document.getElementById('textbook-file')?.files?.[0];
  if (!file) { toast('Select a file.', 'warn'); return; }
  toast('Uploading and extracting text...');
  const form = new FormData();
  form.append('file', file);
  try {
    const resp = await fetch('/api/textbook', { method: 'POST', body: form });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error);
    toast(`Textbook uploaded! ${data.chars} chars extracted.`, 'success');
    loadTextbookStatus();
  } catch (e) { toast('Upload failed: ' + e.message, 'error'); }
}

async function deleteTextbook() {
  if (!confirm('Remove the textbook?')) return;
  await DEL('/api/textbook');
  toast('Textbook removed.', 'success');
  loadTextbookStatus();
}

async function loadCanvasAnalytics() {
  if (!S.course) { toast('Select a course first.', 'warn'); return; }
  const el = document.getElementById('canvas-analytics');
  if (!el) return;
  el.innerHTML = '<div class="loading-splash" style="padding:30px"><div class="loading-bounce"></div><div class="loading-text">Loading analytics<span class="loading-dots"></span></div></div>';
  try {
    const data = await GET(`/api/analytics/${S.course.id}/students`);
    if (!data.length) { el.innerHTML = '<p class="muted">No analytics data available.</p>'; return; }

    // Sort by page views descending
    data.sort((a, b) => (b.page_views || 0) - (a.page_views || 0));

    const maxViews = Math.max(1, ...data.map(s => s.page_views || 0));
    const rows = data.map(s => {
      const name = s.name || `User ${s.id}`;
      const views = s.page_views || 0;
      const parts = s.participations || 0;
      const viewsPct = Math.round((views / maxViews) * 100);
      const tardiness = s.tardiness_breakdown || {};
      return `<tr>
        <td style="font-weight:600;font-size:12px">${esc(name)}</td>
        <td style="text-align:center">${views}</td>
        <td style="min-width:100px"><div class="dist-bar-track"><div class="dist-bar-fill" style="width:${viewsPct}%;background:var(--uw-purple)"></div></div></td>
        <td style="text-align:center">${parts}</td>
        <td style="text-align:center;font-size:11px;color:var(--success)">${tardiness.on_time || 0}</td>
        <td style="text-align:center;font-size:11px;color:var(--warn)">${tardiness.late || 0}</td>
        <td style="text-align:center;font-size:11px;color:var(--danger)">${tardiness.missing || 0}</td>
      </tr>`;
    }).join('');

    el.innerHTML = `<div class="table-wrap"><table>
      <thead><tr><th>Student</th><th>Page Views</th><th></th><th>Participations</th><th>On Time</th><th>Late</th><th>Missing</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
  } catch (e) { el.innerHTML = `<p class="muted">Analytics error: ${esc(e.message)}</p>`; }
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
  const students = S.allStudentsList.length ? S.allStudentsList : allStudents();

  const rows = students.map(st => {
    const teamData = S.teams[st.id];
    const teamNum = teamData?.team || '';
    const teamMeta = teamNum ? (S.teamMeta[String(teamNum)] || {}) : {};
    const teamLabel = teamNum ? (teamMeta.name ? `Team ${teamNum} — ${teamMeta.name}` : `Team ${teamNum}`) : '';
    return `<tr>
      <td>
        <span class="stu-avatar-wrap">
          <span class="manage-photo-wrap">
            ${studentAvatar(st, 28)}
            <button class="manage-photo-btn" title="Upload photo" onclick="document.getElementById('stu-photo-${esc(st.id)}').click()">+</button>
            <input type="file" id="stu-photo-${esc(st.id)}" accept="image/*" style="display:none"
              onchange="uploadStudentPhoto('${esc(st.id)}', this.files[0])" />
          </span>
          <strong>${esc(st.name)}</strong>
        </span>
      </td>
      <td class="muted" style="font-size:11px">${esc(st.email || '')}</td>
      <td style="font-size:12px">${esc(st.id)}</td>
      <td>
        <div style="display:flex;gap:4px;align-items:center">
          <input type="number" class="input" style="width:50px;text-align:center;font-size:12px;padding:3px" min="1" max="99"
            value="${teamNum}" placeholder="—" onchange="manageStudentTeam('${esc(st.id)}',this.value)" />
          <span class="muted" style="font-size:10px">${esc(teamLabel)}</span>
        </div>
      </td>
      <td><button class="btn btn-ghost btn-danger" style="font-size:11px;padding:2px 8px" onclick="removeStudent('${esc(st.id)}')">✕</button></td>
    </tr>`;
  }).join('');

  root.innerHTML = `
    <div class="page-title">Manage Students
      <div class="page-actions">
        <button class="btn btn-ghost" onclick="renderManualView()">⟳ Refresh</button>
        <button class="btn btn-surf" onclick="pushTeamsToCanvas()">⬆ Push Teams to Canvas</button>
      </div>
    </div>

    <!-- Add student -->
    <div class="card" style="margin-bottom:14px">
      <div class="card-title">Add Student</div>
      <div style="display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap">
        <div class="field-group" style="flex:1;min-width:160px;margin-bottom:0"><label>Name</label><input id="manual-name" class="input" placeholder="First Last" /></div>
        <div class="field-group" style="width:120px;margin-bottom:0"><label>ID (optional)</label><input id="manual-id" class="input" placeholder="e.g. 2034567" /></div>
        <div class="field-group" style="width:60px;margin-bottom:0"><label>Team</label><input id="manual-team" class="input" type="number" min="1" max="99" placeholder="—" /></div>
        <button class="btn btn-primary" onclick="addManualStudent()">+ Add</button>
      </div>
    </div>

    <!-- Student roster -->
    <div class="card">
      <div class="card-title">Student Roster (${students.length})</div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Name</th><th>Email</th><th>ID</th><th>Team</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>`;
}

async function addManualStudent() {
  const name = document.getElementById('manual-name')?.value?.trim();
  const id   = document.getElementById('manual-id')?.value?.trim() || `manual_${Date.now()}`;
  const team = Number(document.getElementById('manual-team')?.value) || null;
  if (!name) { toast('Enter a student name.', 'warn'); return; }
  S.manualStudents.push({ id, name });
  if (team) { S.teams[id] = { team }; await PUT(`/api/teams/${S.course.id}`, S.teams).catch(() => {}); }
  toast(`Added ${name}.`, 'success');
  renderManualView();
}

function removeStudent(studentId) {
  if (!confirm('Remove this student from the local roster?')) return;
  S.manualStudents = S.manualStudents.filter(s => s.id !== studentId);
  toast('Student removed from local roster.', 'success');
  renderManualView();
}

async function manageStudentTeam(studentId, value) {
  const num = parseInt(value) || null;
  if (num) S.teams[studentId] = { team: num };
  else delete S.teams[studentId];
  await PUT(`/api/teams/${S.course.id}`, S.teams).catch(() => {});
  renderManualView();
}

async function pushTeamsToCanvas() {
  toast('Team push to Canvas is not directly supported via API. Teams are managed locally.', 'warn');
}

/* ── Case Participation View (Instructor Tool) ─────────────────────────────── */
function renderCaseParticipationView(root) {
  root = root || document.getElementById('view-root');
  const students = S.allStudentsList.length ? S.allStudentsList : allStudents();
  const caseAssignments = S.assignments
    .filter(a => classifyAssignment(a) === 'Cases')
    .sort((a, b) => new Date(a.due_at || 0) - new Date(b.due_at || 0));

  if (!caseAssignments.length) {
    root.innerHTML = '<div class="page-title">Case Participation</div><p class="muted padded">No case assignments found.</p>';
    return;
  }

  const partLabels = ['—', 'Low', 'Part.', 'Exc.'];
  const partColors = ['var(--danger)', 'var(--warn)', 'var(--info)', 'var(--success)'];

  // Build per-student row
  const rows = students.map(st => {
    let totalPts = 0, totalMax = 0;
    const cells = caseAssignments.map(a => {
      const g = (S.allGrades[String(a.id)] || {})[st.id];
      const p = g?.participation;
      totalMax += 3;
      if (p != null) totalPts += p;
      if (p == null) return '<td class="ldg-cell ldg-empty" style="text-align:center">—</td>';
      const color = partColors[p] || 'var(--text-muted)';
      return `<td class="ldg-cell" style="text-align:center;font-weight:700;color:${color}">${p} <span style="font-size:9px;font-weight:400">${partLabels[p]}</span></td>`;
    }).join('');
    const pct = totalMax ? Math.round((totalPts / totalMax) * 100) : null;
    return `<tr>
      <td class="ldg-name"><span class="stu-avatar-wrap">${studentAvatar(st, 18)}${esc(st.name)}</span></td>
      <td style="text-align:center;font-weight:700;color:var(--uw-purple)">${totalPts}</td>
      <td style="text-align:center;font-weight:700">${totalMax}</td>
      <td style="text-align:center;font-weight:700;color:${pct != null && pct < 50 ? 'var(--danger)' : 'var(--success)'}">${pct != null ? pct + '%' : '—'}</td>
      ${cells}
    </tr>`;
  }).join('');

  const caseHeaders = caseAssignments.map(a =>
    `<th style="text-align:center;font-size:10px;padding:5px 8px;min-width:70px;white-space:normal;line-height:1.3" title="${esc(a.name)}">
      <button class="link-btn" style="font-size:10px" onclick="selectAssignment('${a.id}')">${esc(a.name)}</button>
    </th>`
  ).join('');

  root.innerHTML = `
    <div class="page-title">Case Participation — ${esc(S.course?.name || '')}
      <div class="page-actions">
        <button class="btn btn-ghost" onclick="renderCaseParticipationView()">⟳ Refresh</button>
      </div>
    </div>
    <div class="muted" style="margin-bottom:10px">Scores: 0 = Did Not Participate, 1 = Low, 2 = Participated, 3 = Excellent. Click a case name to open and grade participation.</div>
    <div class="ldg-wrap">
      <table class="ldg-table">
        <thead>
          <tr>
            <th class="ldg-name-hdr">Student</th>
            <th style="text-align:center;background:var(--uw-purple);color:#fff;min-width:50px">Total</th>
            <th style="text-align:center;background:var(--uw-purple);color:#fff;min-width:50px">Max</th>
            <th style="text-align:center;background:var(--uw-purple);color:#fff;min-width:50px">%</th>
            ${caseHeaders}
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

/* ── Survey Creator (BETA) ──────────────────────────────────────────────────── */
let _surveys = [];

async function renderSurveyCreatorView(root) {
  root = root || document.getElementById('view-root');
  try { _surveys = await GET('/api/surveys'); } catch { _surveys = []; }

  const surveyCards = _surveys.map(s => {
    const responded = Object.keys(s.responses || {}).length;
    const total = Object.keys(s.tokens || {}).length;
    return `<div class="card" style="margin-bottom:10px">
      <div class="card-title">${esc(s.title)} ${s.isQuiz ? '<span class="status-badge status--reviewed">Quiz</span>' : ''} ${s.forPoints ? '<span class="status-badge status--graded">For Points</span>' : '<span class="status-badge status--pending">Info Only</span>'}
        <div style="margin-left:auto;display:flex;gap:6px">
          <button class="btn btn-ghost" style="font-size:11px;padding:3px 8px" onclick="viewSurveyResults('${esc(s.id)}')">Results (${responded}/${total})</button>
          <button class="btn btn-ghost" style="font-size:11px;padding:3px 8px" onclick="viewSurveyLinks('${esc(s.id)}')">Links</button>
          <button class="btn btn-surf" style="font-size:11px;padding:3px 8px" onclick="sendSurveyLinksViaCanvas('${esc(s.id)}')">✉ Send via Canvas</button>
          <button class="btn btn-ghost btn-danger" style="font-size:11px;padding:3px 8px" onclick="deleteSurvey('${esc(s.id)}')">✕</button>
        </div>
      </div>
      <div class="muted" style="font-size:11px">${(s.questions || []).length} questions · Created ${new Date(s.createdAt).toLocaleDateString()}</div>
      ${s.description ? `<div style="font-size:12px;margin-top:4px">${esc(s.description)}</div>` : ''}
    </div>`;
  }).join('');

  root.innerHTML = `
    <div class="page-title">Surveys & Quizzes <span style="font-size:11px;background:#d97706;color:#fff;padding:2px 8px;border-radius:6px;margin-left:6px">BETA</span></div>

    <!-- Existing surveys -->
    ${surveyCards || '<p class="muted" style="margin-bottom:14px">No surveys created yet.</p>'}

    <!-- Create new survey/quiz -->
    <div class="card">
      <div class="card-title">Create New Survey or Quiz</div>
      <div class="field-group"><label>Title</label><input id="srv-title" class="input" placeholder="e.g. Course Feedback Survey or Pop Quiz" /></div>
      <div class="field-group"><label>Description (optional)</label><input id="srv-desc" class="input" placeholder="Brief description shown to students" /></div>
      <div class="field-row">
        <label class="checkbox-label"><input id="srv-mode" type="checkbox" onchange="document.getElementById('srv-quiz-hint').style.display=this.checked?'':'none'"> <strong>Quiz Mode</strong> (auto-graded: requires correct answers & points per question)</label>
        <label class="checkbox-label"><input id="srv-points" type="checkbox" /> For points</label>
      </div>
      <div id="srv-quiz-hint" class="muted" style="display:none;font-size:11px;margin-bottom:8px;color:var(--warn)">Quiz mode: each question needs a correct answer and point value. Students see their score after submitting.</div>

      <div style="font-size:12px;font-weight:700;color:var(--uw-purple);margin:12px 0 6px">Questions</div>
      <div id="srv-questions"></div>
      <button class="btn btn-ghost btn-add-row" onclick="addSurveyQuestion()">+ Add Question</button>

      <div class="card-actions" style="margin-top:14px">
        <button class="btn btn-primary" onclick="createSurvey()">Create & Generate Links</button>
      </div>
    </div>

    <!-- Results viewer -->
    <div id="srv-results-area"></div>`;

  // Add first question
  if (!document.querySelector('.srv-q-row')) addSurveyQuestion();
}

let _srvQCount = 0;
function addSurveyQuestion() {
  _srvQCount++;
  const wrap = document.getElementById('srv-questions');
  if (!wrap) return;
  const div = document.createElement('div');
  div.className = 'srv-q-row';
  div.innerHTML = `
    <div style="display:flex;gap:6px;align-items:flex-start;margin-bottom:10px;padding:8px;background:var(--bg);border-radius:var(--radius)">
      <span style="font-weight:700;color:var(--uw-purple);min-width:20px">Q${_srvQCount}</span>
      <div style="flex:1">
        <input class="input srv-q-text" placeholder="Question text" style="margin-bottom:4px" />
        <div style="display:flex;gap:8px;align-items:center;margin-bottom:4px">
          <select class="input srv-q-type" style="width:140px;font-size:11px" onchange="srvTypeChanged(this)">
            <option value="text">Short Answer</option>
            <option value="textarea">Long Answer</option>
            <option value="rating">Rating (1-5)</option>
            <option value="yesno">Yes / No</option>
            <option value="truefalse">True / False</option>
            <option value="choice">Multiple Choice</option>
          </select>
          <input class="input srv-q-choices" placeholder="Choices (comma separated)" style="flex:1;font-size:11px" />
        </div>
        <div class="srv-q-mc-correct" style="display:none;margin-bottom:4px"></div>
        <div class="srv-q-quiz-fields" style="display:flex;gap:8px;align-items:center">
          <input class="input srv-q-answer" placeholder="Correct answer (for quiz, text/rating)" style="flex:1;font-size:11px" />
          <input class="input srv-q-points" type="number" min="0" placeholder="Pts" style="width:55px;font-size:11px;text-align:center" />
        </div>
      </div>
      <button class="btn btn-ghost btn-danger" style="font-size:11px;padding:2px 6px" onclick="this.closest('.srv-q-row').remove()">✕</button>
    </div>`;
  wrap.appendChild(div);
}

function srvTypeChanged(select) {
  const row = select.closest('.srv-q-row');
  const type = select.value;
  const mcCorrect = row.querySelector('.srv-q-mc-correct');
  const choicesInput = row.querySelector('.srv-q-choices');
  const answerInput = row.querySelector('.srv-q-answer');

  if (type === 'truefalse') {
    mcCorrect.style.display = 'block';
    mcCorrect.innerHTML = `<span style="font-size:11px;font-weight:600;color:var(--uw-purple)">Correct answer:</span>
      <label style="font-size:11px;margin-left:8px"><input type="radio" name="mc_${Date.now()}" class="srv-mc-correct" value="True" /> True</label>
      <label style="font-size:11px;margin-left:6px"><input type="radio" name="mc_${Date.now()}" class="srv-mc-correct" value="False" /> False</label>`;
    answerInput.style.display = 'none';
    choicesInput.style.display = 'none';
  } else if (type === 'choice') {
    // Show choices input, and when they type choices, show radio buttons for correct
    mcCorrect.style.display = 'block';
    mcCorrect.innerHTML = '<span class="muted" style="font-size:10px">Type choices above, then select the correct one here</span>';
    answerInput.style.display = 'none';
    choicesInput.style.display = '';
    choicesInput.oninput = () => {
      const choices = choicesInput.value.split(',').map(c => c.trim()).filter(Boolean);
      if (choices.length) {
        const radioName = 'mc_' + Date.now();
        mcCorrect.innerHTML = `<span style="font-size:11px;font-weight:600;color:var(--uw-purple)">Correct:</span> ` +
          choices.map(c => `<label style="font-size:11px;margin-left:6px"><input type="radio" name="${radioName}" class="srv-mc-correct" value="${esc(c)}" /> ${esc(c)}</label>`).join('');
      }
    };
  } else if (type === 'yesno') {
    mcCorrect.style.display = 'block';
    mcCorrect.innerHTML = `<span style="font-size:11px;font-weight:600;color:var(--uw-purple)">Correct answer:</span>
      <label style="font-size:11px;margin-left:8px"><input type="radio" name="mc_${Date.now()}" class="srv-mc-correct" value="Yes" /> Yes</label>
      <label style="font-size:11px;margin-left:6px"><input type="radio" name="mc_${Date.now()}" class="srv-mc-correct" value="No" /> No</label>`;
    answerInput.style.display = 'none';
    choicesInput.style.display = 'none';
  } else {
    mcCorrect.style.display = 'none';
    mcCorrect.innerHTML = '';
    answerInput.style.display = '';
    choicesInput.style.display = type === 'text' || type === 'textarea' ? 'none' : '';
  }
}

async function createSurvey() {
  const title = document.getElementById('srv-title')?.value?.trim();
  if (!title) { toast('Enter a title.', 'warn'); return; }
  const description = document.getElementById('srv-desc')?.value?.trim() || '';
  const forPoints = document.getElementById('srv-points')?.checked || false;
  const isQuiz = document.getElementById('srv-mode')?.checked || false;

  // Collect questions
  const qRows = document.querySelectorAll('.srv-q-row');
  const questions = [];
  qRows.forEach(row => {
    const text = row.querySelector('.srv-q-text')?.value?.trim();
    const type = row.querySelector('.srv-q-type')?.value || 'text';
    const choices = row.querySelector('.srv-q-choices')?.value?.trim();
    // Get correct answer: from MC/TF radio or from text input
    const mcChecked = row.querySelector('.srv-mc-correct:checked');
    const answerText = row.querySelector('.srv-q-answer')?.value?.trim() || '';
    const answer = mcChecked ? mcChecked.value : answerText;
    const points = Number(row.querySelector('.srv-q-points')?.value) || 0;
    const qChoices = type === 'choice' ? choices.split(',').map(c => c.trim()).filter(Boolean)
                   : type === 'truefalse' ? ['True', 'False']
                   : type === 'yesno' ? ['Yes', 'No'] : [];
    if (text) questions.push({
      text, type: type === 'truefalse' ? 'choice' : type,
      choices: qChoices,
      correctAnswer: isQuiz ? answer : '',
      points: isQuiz ? points : 0,
    });
  });
  if (!questions.length) { toast('Add at least one question.', 'warn'); return; }

  // Get student IDs and names
  const students = S.allStudentsList.length ? S.allStudentsList : allStudents();
  const studentIds = students.map(s => s.id);
  const studentNames = {};
  students.forEach(s => { studentNames[s.id] = s.name; });

  toast('Creating survey...');
  try {
    await POST('/api/surveys', { title, description, forPoints, isQuiz, questions, studentIds, studentNames });
    toast('Survey created with links for all students!', 'success');
    renderSurveyCreatorView();
  } catch (e) { toast('Create failed: ' + e.message, 'error'); }
}

async function sendSurveyLinksViaCanvas(id) {
  const survey = _surveys.find(s => s.id === id);
  if (!survey) return;
  const pending = Object.keys(survey.tokens || {}).length - Object.keys(survey.responses || {}).length;
  if (!confirm(`Send ${survey.isQuiz ? 'quiz' : 'survey'} links to ${pending} students who haven't responded yet via Canvas Messages?`)) return;
  toast('Sending links via Canvas...');
  try {
    const res = await POST(`/api/surveys/${id}/send-links`, { baseUrl: location.origin });
    toast(`Sent ${res.sent} messages via Canvas!${res.errors ? ` (${res.errors} failed)` : ''}`, 'success');
  } catch (e) { toast('Send failed: ' + e.message, 'error'); }
}

async function deleteSurvey(id) {
  if (!confirm('Delete this survey and all responses?')) return;
  await DEL(`/api/surveys/${id}`);
  toast('Survey deleted.', 'success');
  renderSurveyCreatorView();
}

function viewSurveyLinks(id) {
  const survey = _surveys.find(s => s.id === id);
  if (!survey) return;
  const area = document.getElementById('srv-results-area');
  const links = Object.entries(survey.tokens || {}).map(([token, t]) => {
    const link = `${location.origin}/survey.html?s=${survey.id}&t=${token}`;
    const responded = !!survey.responses?.[t.studentId];
    return `<div style="display:flex;gap:6px;align-items:center;font-size:11px;margin-bottom:3px">
      <span style="min-width:140px">${esc(t.studentName)}</span>
      ${responded ? '<span class="status-badge status--graded" style="font-size:9px">Done</span>' : '<span class="status-badge status--pending" style="font-size:9px">Pending</span>'}
      <input class="input" style="font-size:10px;flex:1;padding:2px 4px" readonly value="${link}" onclick="this.select();navigator.clipboard.writeText(this.value);toast('Copied!','success')" />
    </div>`;
  }).join('');
  area.innerHTML = `<div class="card" style="margin-top:12px">
    <div class="card-title">Links — ${esc(survey.title)}</div>
    ${links}
  </div>`;
}

function viewSurveyResults(id) {
  const survey = _surveys.find(s => s.id === id);
  if (!survey) return;
  const area = document.getElementById('srv-results-area');
  const responses = survey.responses || {};
  const questions = survey.questions || [];
  const tokens = survey.tokens || {};
  const allStudents = Object.values(tokens);

  // Build results table
  const isQuiz = survey.isQuiz;
  const totalPossible = isQuiz ? questions.reduce((s, q) => s + (q.points || 0), 0) : 0;
  const headerCols = questions.map((q, i) => `<th style="font-size:10px;max-width:120px;white-space:normal;line-height:1.2">Q${i + 1}: ${esc(q.text.substring(0, 30))}${isQuiz ? ` (${q.points || 0}pt)` : ''}</th>`).join('');

  const rows = allStudents.map(t => {
    const r = responses[t.studentId];
    let earned = 0;
    const cells = questions.map((q, i) => {
      const ans = r?.answers?.[i];
      if (ans == null) return '<td class="ldg-cell ldg-empty">—</td>';
      if (isQuiz && q.correctAnswer) {
        const correct = String(ans).trim().toLowerCase() === String(q.correctAnswer).trim().toLowerCase();
        if (correct) earned += (q.points || 0);
        return `<td class="ldg-cell" style="text-align:center;font-weight:700;color:${correct ? 'var(--success)' : 'var(--danger)'}">${esc(String(ans))} ${correct ? '✓' : '✗'}</td>`;
      }
      if (q.type === 'rating') return `<td class="ldg-cell" style="text-align:center;font-weight:700;color:var(--uw-purple)">${ans}/5</td>`;
      return `<td class="ldg-cell" style="font-size:11px">${esc(String(ans).substring(0, 60))}</td>`;
    }).join('');
    return `<tr>
      <td style="font-weight:600;font-size:12px">${esc(t.studentName)}</td>
      <td>${r ? '<span class="status-badge status--graded">Yes</span>' : '<span class="status-badge status--pending">No</span>'}</td>
      ${cells}
      ${isQuiz ? `<td style="text-align:center;font-weight:800;color:var(--uw-purple);font-size:14px">${r ? earned + '/' + totalPossible : '—'}</td>` : ''}
    </tr>`;
  }).join('');

  // Averages for rating questions
  const avgRow = questions.map((q, i) => {
    if (q.type !== 'rating') return '<td></td>';
    const vals = Object.values(responses).map(r => r.answers?.[i]).filter(v => v != null);
    const avg = vals.length ? (vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1) : '—';
    return `<td style="text-align:center;font-weight:800;color:var(--uw-purple)">${avg}</td>`;
  }).join('');

  area.innerHTML = `<div class="card" style="margin-top:12px">
    <div class="card-title">Results — ${esc(survey.title)} (${Object.keys(responses).length}/${allStudents.length} responded)</div>
    <div class="table-wrap"><table style="font-size:12px">
      <thead><tr><th>Student</th><th>Submitted</th>${headerCols}${isQuiz ? `<th style="text-align:center;background:var(--uw-gold);color:var(--uw-purple)">Score /${totalPossible}</th>` : ''}</tr></thead>
      <tbody>${rows}
        <tr style="background:var(--bg);font-weight:700"><td>Average</td><td></td>${avgRow}</tr>
      </tbody>
    </table></div>
  </div>`;
}

/* ── Panel Grading (BETA) ───────────────────────────────────────────────────── */
const PANEL_RUBRIC = [
  { id: 'pr1', name: 'Understanding of buyer and why', maxPoints: 10 },
  { id: 'pr2', name: 'Solid launch strategy', maxPoints: 10 },
  { id: 'pr3', name: 'Promotional plan appropriate', maxPoints: 10 },
  { id: 'pr4', name: 'Financial projections reasonable', maxPoints: 10 },
  { id: 'pr5', name: 'Overall Structure & Demeanor', maxPoints: 5 },
  { id: 'pr6', name: 'Executive Summary concise', maxPoints: 5 },
  { id: 'pr7', name: 'Idea Generation process', maxPoints: 5 },
  { id: 'pr8', name: 'Market Analysis', maxPoints: 5 },
  { id: 'pr9', name: 'Gating & Success metrics', maxPoints: 5 },
];
const PANEL_TOTAL = PANEL_RUBRIC.reduce((s, c) => s + c.maxPoints, 0);

let _panelData = null;
let _panelTeam = 'all';

async function renderPanelGradingView(root) {
  root = root || document.getElementById('view-root');
  try { _panelData = await GET('/api/panel-grading'); } catch { _panelData = { panelists: [], scores: {} }; }
  if (!_panelData.rubric) _panelData.rubric = PANEL_RUBRIC;
  _renderPanelUI(root);
}

function _renderPanelUI(root) {
  root = root || document.getElementById('view-root');
  const pg = _panelData;
  const panelists = pg.panelists || [];
  const teamNums = Object.keys(S.teamMeta).map(Number).sort((a, b) => a - b);

  // Team selector
  const teamOpts = `<option value="all" ${_panelTeam === 'all' ? 'selected' : ''}>All Teams</option>` +
    teamNums.map(t => `<option value="${t}" ${String(_panelTeam) === String(t) ? 'selected' : ''}>Team ${t} — ${esc(S.teamMeta[String(t)]?.name || '')}</option>`).join('');

  // Panelist management
  const panelistRows = panelists.map((p, i) => {
    const link = `${location.origin}/panel.html?token=${p.token}`;
    return `<div class="panel-member">
      <span style="font-weight:700">${esc(p.name)}</span>
      <input class="input" style="font-size:10px;width:200px;padding:2px 4px" readonly value="${link}" onclick="this.select();navigator.clipboard.writeText(this.value);toast('Link copied!','success')" />
      <button class="btn btn-ghost btn-danger" style="font-size:10px;padding:2px 6px" onclick="removePanelist(${i})">✕</button>
    </div>`;
  }).join('');

  // Scoring table — show teams
  const teamsToShow = _panelTeam === 'all' ? teamNums : [Number(_panelTeam)];
  const students = S.allStudentsList.length ? S.allStudentsList : allStudents();

  const teamBlocks = teamsToShow.map(tNum => {
    const meta = S.teamMeta[String(tNum)] || {};
    const members = students.filter(st => S.teams[st.id]?.team === tNum);

    // Per-panelist columns
    const headerCols = panelists.map(p => `<th style="text-align:center;font-size:10px;min-width:60px">${esc(p.name)}</th>`).join('');

    const rubricRows = PANEL_RUBRIC.map(cr => {
      const pScores = panelists.map(p => {
        const score = pg.scores?.[p.id]?.[`t${tNum}`]?.[cr.id];
        return `<td style="text-align:center">
          <input class="input" type="number" min="0" max="${cr.maxPoints}" style="width:45px;text-align:center;font-size:11px;padding:2px"
            value="${score != null ? score : ''}" placeholder="—"
            onchange="panelScoreChange('${p.id}',${tNum},'${cr.id}',this.value,${cr.maxPoints})" />
        </td>`;
      }).join('');
      // Average
      const vals = panelists.map(p => pg.scores?.[p.id]?.[`t${tNum}`]?.[cr.id]).filter(v => v != null);
      const avg = vals.length ? (vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1) : '—';
      return `<tr>
        <td style="font-size:11px;font-weight:600">${esc(cr.name)}</td>
        <td style="text-align:center;font-size:10px;color:var(--text-muted)">/${cr.maxPoints}</td>
        ${pScores}
        <td style="text-align:center;font-weight:700;color:var(--uw-purple)">${avg}</td>
      </tr>`;
    }).join('');

    // Total row
    const totalCols = panelists.map(p => {
      const total = PANEL_RUBRIC.reduce((s, cr) => s + (pg.scores?.[p.id]?.[`t${tNum}`]?.[cr.id] || 0), 0);
      return `<td style="text-align:center;font-weight:800;color:var(--uw-purple)">${total}</td>`;
    }).join('');
    const allTotals = panelists.map(p => PANEL_RUBRIC.reduce((s, cr) => s + (pg.scores?.[p.id]?.[`t${tNum}`]?.[cr.id] || 0), 0));
    const grandAvg = allTotals.length ? (allTotals.reduce((a, b) => a + b, 0) / allTotals.length).toFixed(1) : '—';

    return `<div class="card" style="margin-bottom:12px">
      <div class="card-title">Team ${tNum} — ${esc(meta.name || '')}
        <span class="muted" style="font-size:11px;margin-left:8px">${members.map(m => m.name?.split(' ')[0]).join(', ')}</span>
      </div>
      <div class="table-wrap"><table style="font-size:12px">
        <thead><tr><th>Criterion</th><th>Max</th>${headerCols}<th style="text-align:center;background:var(--uw-gold);color:var(--uw-purple)">Avg</th></tr></thead>
        <tbody>${rubricRows}
          <tr style="background:var(--bg);font-weight:800"><td>TOTAL</td><td>/${PANEL_TOTAL}</td>${totalCols}<td style="text-align:center;font-size:15px;color:var(--uw-purple)">${grandAvg}</td></tr>
        </tbody>
      </table></div>
    </div>`;
  }).join('');

  root.innerHTML = `
    <div class="page-title">Panel Grading <span style="font-size:11px;background:#d97706;color:#fff;padding:2px 8px;border-radius:6px;margin-left:6px">BETA</span></div>

    <div style="display:flex;gap:12px;align-items:center;margin-bottom:14px;flex-wrap:wrap">
      <label style="font-weight:700;color:var(--uw-purple)">Team:</label>
      <select class="input" style="width:240px" onchange="_panelTeam=this.value;_renderPanelUI()">${teamOpts}</select>
    </div>

    <!-- Panelists -->
    <div class="card" style="margin-bottom:14px">
      <div class="card-title">Panel Members (up to 8)</div>
      <div class="panel-members">${panelistRows || '<p class="muted">No panelists added yet.</p>'}</div>
      <div style="display:flex;gap:6px;margin-top:8px;align-items:center">
        <input class="input" id="panel-new-name" placeholder="Panelist name" style="width:160px" />
        <button class="btn btn-surf" onclick="addPanelist()">+ Add Panelist</button>
        <button class="btn btn-ghost" onclick="savePanelData()">Save All Scores</button>
      </div>
    </div>

    ${teamBlocks}`;
}

async function addPanelist() {
  const name = document.getElementById('panel-new-name')?.value?.trim();
  if (!name) { toast('Enter a name.', 'warn'); return; }
  if (_panelData.panelists.length >= 8) { toast('Max 8 panelists.', 'warn'); return; }
  const token = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  _panelData.panelists.push({ id: 'p_' + token.slice(0, 6), name, token });
  await savePanelData();
  _renderPanelUI();
}

async function removePanelist(idx) {
  if (!confirm('Remove this panelist?')) return;
  _panelData.panelists.splice(idx, 1);
  await savePanelData();
  _renderPanelUI();
}

async function panelScoreChange(panelistId, teamNum, criterionId, value, max) {
  let v = value.trim() === '' ? null : Math.max(0, Math.min(max, Number(value)));
  if (!_panelData.scores) _panelData.scores = {};
  if (!_panelData.scores[panelistId]) _panelData.scores[panelistId] = {};
  if (!_panelData.scores[panelistId][`t${teamNum}`]) _panelData.scores[panelistId][`t${teamNum}`] = {};
  if (v === null) delete _panelData.scores[panelistId][`t${teamNum}`][criterionId];
  else _panelData.scores[panelistId][`t${teamNum}`][criterionId] = v;
  await savePanelData();
}

async function savePanelData() {
  try { await PUT('/api/panel-grading', _panelData); } catch (e) { toast('Save failed: ' + e.message, 'error'); }
}

/* ── Peer Evaluation (BETA) ────────────────────────────────────────────────── */
let _peerData = null;

async function renderPeerEvalView(root) {
  root = root || document.getElementById('view-root');
  try { _peerData = await GET('/api/peer-eval'); } catch { _peerData = { responses: {}, tokens: {} }; }
  _renderPeerUI(root);
}

function _renderPeerUI(root) {
  root = root || document.getElementById('view-root');
  const students = S.allStudentsList.length ? S.allStudentsList : allStudents();
  const teamNums = Object.keys(S.teamMeta).map(Number).sort((a, b) => a - b);
  const responses = _peerData.responses || {};
  const tokens = _peerData.tokens || {};

  // Generate tokens if not exists
  let needsSave = false;
  teamNums.forEach(tNum => {
    const members = students.filter(st => S.teams[st.id]?.team === tNum);
    members.forEach(st => {
      if (!Object.values(tokens).find(t => t.studentId === st.id)) {
        const token = Date.now().toString(36) + Math.random().toString(36).slice(2, 8) + st.id;
        tokens[token] = {
          studentId: st.id, studentName: st.name, teamNum: tNum,
          teamMembers: members.map(m => ({ id: m.id, name: m.name })),
        };
        needsSave = true;
      }
    });
  });
  if (needsSave) { _peerData.tokens = tokens; savePeerData(); }

  // Results table
  const rows = students.map(st => {
    const teamNum = S.teams[st.id]?.team || 0;
    const teamMembers = students.filter(m => S.teams[m.id]?.team === teamNum && m.id !== st.id);
    const groupSize = teamMembers.length + 1;

    // Gather ratings from teammates
    const ratings = [];
    let mostWorkVotes = 0, leastWorkVotes = 0;
    teamMembers.forEach(tm => {
      const r = responses[tm.id];
      if (!r) return;
      const rating = r.ratings?.[st.id];
      if (rating != null) ratings.push(rating);
      if (r.mostWork === st.id) mostWorkVotes++;
      if (r.leastWork === st.id) leastWorkVotes++;
    });

    const avgRating = ratings.length ? (ratings.reduce((a, b) => a + b, 0) / ratings.length) : null;
    const submitted = !!responses[st.id];

    // Formula
    const basePts = 2;
    const ratingComponent = avgRating != null ? ((avgRating - 1) / 4) * 6 : 0;
    const mostWorkBonus = groupSize > 1 ? (mostWorkVotes / (groupSize - 1)) * 2 : 0;
    const leastWorkPenalty = (leastWorkVotes >= 2 && groupSize > 1) ? -((leastWorkVotes / (groupSize - 1)) * 2) : 0;
    const submissionPenalty = submitted ? 0 : -1;
    const rawScore = basePts + ratingComponent + mostWorkBonus + leastWorkPenalty + submissionPenalty;
    const finalScore = Math.max(0, Math.min(10, rawScore));
    const scaledScore = avgRating != null ? (finalScore / 10 * 20).toFixed(1) : '—';

    return `<tr>
      <td><span class="stu-avatar-wrap">${studentAvatar(st, 18)}<strong>${esc(st.name)}</strong></span></td>
      <td style="text-align:center">Team ${teamNum}</td>
      <td style="text-align:center;font-weight:700">${avgRating != null ? avgRating.toFixed(2) : '—'}</td>
      <td style="text-align:center">${avgRating != null ? (ratingComponent).toFixed(1) : '—'}</td>
      <td style="text-align:center">${mostWorkVotes}</td>
      <td style="text-align:center;color:var(--success)">${mostWorkBonus.toFixed(1)}</td>
      <td style="text-align:center">${leastWorkVotes}</td>
      <td style="text-align:center;color:${leastWorkPenalty < 0 ? 'var(--danger)' : 'var(--text-muted)'}">${leastWorkPenalty.toFixed(1)}</td>
      <td style="text-align:center">${submitted ? '<span class="status-badge status--graded">Yes</span>' : '<span class="status-badge status--late">NO</span>'}</td>
      <td style="text-align:center;color:${submissionPenalty < 0 ? 'var(--danger)' : ''}">${submissionPenalty}</td>
      <td style="text-align:center;font-weight:800;color:var(--uw-purple)">${avgRating != null ? finalScore.toFixed(2) : '—'}</td>
      <td style="text-align:center;font-weight:800;font-size:14px;color:var(--uw-purple)">${scaledScore}</td>
    </tr>`;
  }).join('');

  // Count responses
  const totalStudents = students.length;
  const responded = Object.keys(responses).length;

  // Links list
  const linksList = Object.entries(tokens).slice(0, 5).map(([token, t]) => {
    const link = `${location.origin}/peer-eval.html?token=${token}`;
    return `<div style="display:flex;gap:6px;align-items:center;font-size:11px;margin-bottom:3px">
      <span style="min-width:120px">${esc(t.studentName)}</span>
      <input class="input" style="font-size:10px;flex:1;padding:2px 4px" readonly value="${link}" onclick="this.select();navigator.clipboard.writeText(this.value);toast('Copied!','success')" />
    </div>`;
  }).join('');

  root.innerHTML = `
    <div class="page-title">Peer Evaluation <span style="font-size:11px;background:#d97706;color:#fff;padding:2px 8px;border-radius:6px;margin-left:6px">BETA</span></div>

    <div class="asgn-stat-cards" style="margin-bottom:14px">
      <div class="asgn-stat-card" style="border-left-color:var(--uw-purple)"><div class="asgn-stat-value">${totalStudents}</div><div class="asgn-stat-label">Students</div></div>
      <div class="asgn-stat-card" style="border-left-color:var(--success)"><div class="asgn-stat-value">${responded}</div><div class="asgn-stat-label">Responded</div></div>
      <div class="asgn-stat-card" style="border-left-color:var(--danger)"><div class="asgn-stat-value">${totalStudents - responded}</div><div class="asgn-stat-label">Pending</div></div>
    </div>

    <!-- Student Links -->
    <div class="card" style="margin-bottom:14px">
      <div class="card-title">Student Evaluation Links
        <span class="card-title-hint">Each student gets a unique link — click to copy</span>
        <button class="btn btn-surf" style="font-size:11px;padding:3px 10px;margin-left:auto" onclick="sendPeerEvalViaCanvas()">✉ Send All via Canvas</button>
      </div>
      ${linksList}
      ${Object.keys(tokens).length > 5 ? `<p class="muted" style="font-size:11px">…and ${Object.keys(tokens).length - 5} more. <button class="link-btn" onclick="showAllPeerLinks()">Show all</button></p>` : ''}
    </div>

    <!-- Results -->
    <div class="card">
      <div class="card-title">Peer Evaluation Results</div>
      <p class="muted" style="margin-bottom:8px;font-size:11px">Base (2) + Rating Component (0-6) + Most Work Bonus (0-2) + Least Work Penalty (0 to -2) + Submission Penalty (0 or -1)</p>
      <div class="table-wrap"><table style="font-size:11px">
        <thead><tr>
          <th>Student</th><th>Team</th><th>Avg Rating</th><th>Rating Pts</th>
          <th>Most Votes</th><th>Bonus</th><th>Least Votes</th><th>Penalty</th>
          <th>Submitted</th><th>Sub Pen.</th><th>Raw /10</th><th>Scaled /20</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
    </div>`;
}

function showAllPeerLinks() {
  const tokens = _peerData.tokens || {};
  const all = Object.entries(tokens).map(([token, t]) => {
    const link = `${location.origin}/peer-eval.html?token=${token}`;
    return `${t.studentName}: ${link}`;
  }).join('\n');
  const w = window.open('', '_blank');
  w.document.write(`<pre style="font-size:12px;padding:20px">${esc(all)}</pre>`);
}

async function sendPeerEvalViaCanvas() {
  const pending = Object.keys(_peerData.tokens || {}).length - Object.keys(_peerData.responses || {}).length;
  if (!confirm(`Send peer evaluation links to ${pending} students who haven't responded yet via Canvas Messages?`)) return;
  toast('Sending peer eval links via Canvas...');
  try {
    const res = await POST('/api/peer-eval/send-links', { baseUrl: location.origin });
    toast(`Sent ${res.sent} messages!${res.errors ? ` (${res.errors} failed)` : ''}`, 'success');
  } catch (e) { toast('Send failed: ' + e.message, 'error'); }
}

async function savePeerData() {
  try { await PUT('/api/peer-eval', _peerData); } catch (e) { toast('Save failed: ' + e.message, 'error'); }
}

/* ── Rompipalle Competition ─────────────────────────────────────────────────── */
let _rompiData = {};

async function renderRompipalleView(root) {
  root = root || document.getElementById('view-root');
  try { _rompiData = await GET('/api/rompipalle'); } catch { _rompiData = {}; }
  _renderRompiUI(root);
}

function _renderRompiUI(root) {
  root = root || document.getElementById('view-root');
  const students = S.allStudentsList.length ? S.allStudentsList : allStudents();

  // Sort by votes descending for podium
  const ranked = students.map(st => ({ ...st, votes: _rompiData[st.id] || 0 })).sort((a, b) => b.votes - a.votes);
  const first = ranked[0];
  const second = ranked[1];
  const third = ranked[2];

  // Podium
  const podiumHtml = `
    <div class="rompi-podium">
      <div class="rompi-podium-spot rompi-2nd">
        <div class="rompi-podium-photo">${second ? studentAvatar(second, 50) : ''}</div>
        <div class="rompi-podium-name">${second ? esc(second.name.split(' ')[0]) : '—'}</div>
        <div class="rompi-podium-votes">${second ? second.votes : 0} pts</div>
        <div class="rompi-pedestal rompi-pedestal-2">2nd</div>
        <div class="rompi-prize">📦💥</div>
      </div>
      <div class="rompi-podium-spot rompi-1st">
        <div class="rompi-podium-photo">${first ? studentAvatar(first, 60) : ''}</div>
        <div class="rompi-podium-name">${first ? esc(first.name.split(' ')[0]) : '—'}</div>
        <div class="rompi-podium-votes">${first ? first.votes : 0} pts</div>
        <div class="rompi-pedestal rompi-pedestal-1">1st</div>
        <div class="rompi-prize">🥎🏆🥎</div>
      </div>
      <div class="rompi-podium-spot rompi-3rd">
        <div class="rompi-podium-photo">${third ? studentAvatar(third, 45) : ''}</div>
        <div class="rompi-podium-name">${third ? esc(third.name.split(' ')[0]) : '—'}</div>
        <div class="rompi-podium-votes">${third ? third.votes : 0} pts</div>
        <div class="rompi-pedestal rompi-pedestal-3">3rd</div>
        <div class="rompi-prize">🥱😴</div>
      </div>
    </div>`;

  // Student roster grid
  const rosterHtml = ranked.map(st => `
    <div class="rompi-student">
      <div class="rompi-student-photo">${studentAvatar(st, 56)}</div>
      <div class="rompi-student-name">${esc(st.name.split(' ')[0])}<br>${esc(st.name.split(' ').slice(1).join(' '))}</div>
      <div class="rompi-student-votes">${st.votes} pts</div>
      <div class="rompi-btns">
        <button class="rompi-btn rompi-btn-minus" onclick="event.stopPropagation();rompiVote('${esc(st.id)}',-1)">−</button>
        <button class="rompi-btn rompi-btn-plus" onclick="event.stopPropagation();rompiVote('${esc(st.id)}',1)">+</button>
      </div>
    </div>`).join('');

  root.innerHTML = `
    <div class="page-title">🏆 Rompipalle Competition
      <div class="page-actions">
        <button class="btn btn-ghost" onclick="renderRompipalleView()">⟳ Refresh</button>
        <button class="btn btn-ghost btn-danger" onclick="rompiReset()">Reset All Votes</button>
      </div>
    </div>
    ${podiumHtml}
    <div class="card">
      <div class="card-title">Roster — Click a student to give them a point!</div>
      <div class="rompi-roster">${rosterHtml}</div>
    </div>`;
}

async function rompiVote(studentId, delta = 1) {
  if (!_rompiData[studentId]) _rompiData[studentId] = 0;
  _rompiData[studentId] = Math.max(0, _rompiData[studentId] + delta);
  await PUT('/api/rompipalle', _rompiData);
  _renderRompiUI();
  toast(delta > 0 ? '+1 point!' : '−1 point', delta > 0 ? 'success' : 'warn');
}

async function rompiReset() {
  if (!confirm('Reset all Rompipalle votes to zero?')) return;
  _rompiData = {};
  await PUT('/api/rompipalle', _rompiData);
  _renderRompiUI();
  toast('All votes reset.', 'success');
}

/* ── Canvas Grade Sync ───────────────────────────────────────────────────────── */
document.getElementById('btn-sync-canvas').addEventListener('click', () => syncCanvasGrades(false));

async function syncCanvasGrades(silent = false) {
  if (!S.course) return;
  S._syncing = true;
  if (!silent) toast('Syncing grades from Canvas…');
  // Update overview if visible
  if (currentView === 'overview') renderOverview();
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
    S._syncing = false;
    if (!silent) toast(`Canvas sync complete — ${count} scores imported.`, 'success');
    // Refresh current view
    const v = currentView;
    if (v === 'gradebook') renderGradeBook();
    else if (v === 'ledger')  _renderLedgerHtml(document.getElementById('view-root'), canvasScores);
    else if (v === 'teams')   renderTeamsView();
    else if (v === 'overview') renderOverview(document.getElementById('view-root'));
  } catch (e) {
    S._syncing = false;
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
    const sub = S.submissions.find(s => String(s.user_id) === String(studentId));
    if (sub) sub._extractedText = res.text;
    toast(`Text extracted! (${res.text.length} chars)`, 'success');
    showView('assignment');
  } catch (e) {
    console.error('Extract failed:', e.message, '| url:', url?.substring(0, 100));
    toast('Extract failed: ' + e.message, 'error');
  }
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
    const dn = displayName(me.username);
    const hdrBtn = document.getElementById('hdr-username');
    const photoUrl = `/api/user-photo/${encodeURIComponent(me.username.toLowerCase())}`;
    hdrBtn.innerHTML = `<img class="hdr-user-photo" src="${photoUrl}" onerror="this.style.display='none'" />${esc(dn)}`;
    hdrBtn.style.color = '#fff';
    hdrBtn.style.background = authorColor(dn);
    hdrBtn.style.borderColor = authorColor(dn);
  } catch { window.location.href = '/login.html'; }
}

/* ── Messages View (Canvas Inbox) ──────────────────────────────────────────── */
async function renderMessagesView(root) {
  root = root || document.getElementById('view-root');
  root.innerHTML = '<div class="loading-splash"><div class="loading-bounce"></div><div class="loading-text">Loading messages<span class="loading-dots"></span></div></div>';
  try {
    const convos = await GET('/api/messages');
    const rows = convos.map(c => {
      const participants = (c.participants || []).map(p => p.name).join(', ');
      const date = new Date(c.last_message_at || c.created_at).toLocaleString('en-US', { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' });
      const unread = c.workflow_state === 'unread';
      return `<div class="msg-item ${unread ? 'msg-unread' : ''}" onclick="openMessage('${c.id}')">
        <div class="msg-item-left">
          <div class="msg-subject ${unread ? 'msg-subject-unread' : ''}">${esc(c.subject || '(no subject)')}</div>
          <div class="msg-participants">${esc(participants)}</div>
          <div class="msg-preview">${esc((c.last_message || '').substring(0, 100))}</div>
        </div>
        <div class="msg-item-right">
          <span class="msg-date">${date}</span>
          ${unread ? '<span class="msg-unread-dot"></span>' : ''}
        </div>
      </div>`;
    }).join('');

    root.innerHTML = `
      <div class="page-title">✉ Messages — Canvas Inbox
        <div class="page-actions">
          <button class="btn btn-ghost" onclick="renderMessagesView()">⟳ Refresh</button>
        </div>
      </div>
      <div class="card">
        <div class="msg-list" id="msg-list">${rows || '<p class="muted" style="padding:16px;text-align:center">No messages.</p>'}</div>
      </div>
      <div id="msg-detail-card"></div>`;
  } catch (e) {
    root.innerHTML = `<p class="muted padded">Failed to load messages: ${esc(e.message)}</p>`;
  }
}

let _msgConvoCache = null;

async function openMessage(id) {
  // Use the modal for message popup
  const backdrop = document.getElementById('modal-backdrop');
  const modal = backdrop.querySelector('.modal');
  modal.innerHTML = `<div class="modal-header"><div><div class="modal-title">Loading...</div></div><button class="modal-close" onclick="closeModal()">✕</button></div><div class="modal-body"><p class="muted" style="text-align:center;padding:20px">Loading conversation...</p></div>`;
  backdrop.classList.remove('hidden');

  try {
    const convo = await GET(`/api/messages/${id}`);
    _msgConvoCache = convo;

    // Find the sender (not us) to reply only to them
    const myId = convo.participants?.find(p => p.name?.toLowerCase() === (S.me?.username || '').toLowerCase())?.id;
    const senderIds = (convo.participants || []).filter(p => p.id !== myId).map(p => p.id);
    const senderNames = (convo.participants || []).filter(p => p.id !== myId).map(p => p.name).join(', ');

    const msgs = (convo.messages || []).reverse().map(m => {
      const participant = convo.participants?.find(p => p.id === m.author_id);
      const isMe = m.author_id === myId;
      const name = isMe ? displayName(S.me?.username || 'You') : (participant?.name || 'Student');
      const color = isMe ? authorColor(displayName(S.me?.username)) : '#6b7280';
      const date = new Date(m.created_at).toLocaleString('en-US', { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' });
      return `<div class="msg-modal-bubble ${isMe ? 'msg-modal-me' : 'msg-modal-them'}">
        <div class="msg-bubble-author" style="color:${color}"><strong>${esc(name)}</strong> <span class="muted">${date}</span></div>
        <div class="msg-bubble-body">${m.body || ''}</div>
      </div>`;
    }).join('');

    modal.innerHTML = `
      <div class="modal-header">
        <div>
          <div class="modal-title">${esc(convo.subject || '(no subject)')}</div>
          <div class="modal-subtitle">With: ${esc(senderNames)}</div>
        </div>
        <button class="modal-close" onclick="closeModal()">✕</button>
      </div>
      <div class="modal-body">
        <div class="msg-modal-thread">${msgs}</div>
      </div>
      <div class="modal-footer" style="flex-direction:column;align-items:stretch;gap:6px">
        <div class="muted" style="font-size:11px">Replying to: <strong>${esc(senderNames)}</strong> only (not the whole class)</div>
        <textarea class="input" id="msg-reply-input" rows="2" placeholder="Type your reply..."></textarea>
        <button class="btn btn-primary" onclick="sendMessageReply('${id}', [${senderIds.map(i => i).join(',')}])">Send Reply to ${esc(senderNames.split(',')[0])}</button>
      </div>`;

    // Scroll to bottom of thread
    const thread = modal.querySelector('.msg-modal-thread');
    if (thread) thread.scrollTop = thread.scrollHeight;

  } catch (e) {
    modal.innerHTML = `<div class="modal-header"><div><div class="modal-title">Error</div></div><button class="modal-close" onclick="closeModal()">✕</button></div><div class="modal-body"><p class="muted">Failed: ${esc(e.message)}</p></div>`;
  }
}

async function sendMessageReply(id, recipientIds) {
  const input = document.getElementById('msg-reply-input');
  const body = input?.value?.trim();
  if (!body) { toast('Type a reply.', 'warn'); return; }
  try {
    await POST(`/api/messages/${id}/reply`, { body, recipientIds });
    toast('Reply sent to Canvas!', 'success');
    openMessage(id); // refresh the conversation
  } catch (e) { toast('Send failed: ' + e.message, 'error'); }
}

/* ── Profile Side Card ─────────────────────────────────────────────────────── */
function toggleProfileCard() {
  const card = document.getElementById('profile-card');
  if (!card) return;
  if (card.classList.contains('hidden')) {
    renderProfileCard();
    card.classList.remove('hidden');
  } else {
    card.classList.add('hidden');
  }
}

function renderProfileCard() {
  const inner = document.getElementById('profile-card-inner');
  if (!inner) return;
  const name = displayName(S.me?.username || 'User');
  const color = authorColor(name);
  const photoUrl = `/api/user-photo/${encodeURIComponent((S.me?.username || '').toLowerCase())}`;

  inner.innerHTML = `
    <div class="prof-header">
      <div class="prof-photo-wrap">
        <img class="prof-photo" id="prof-photo-img" src="${photoUrl}" alt="${esc(name)}"
          onerror="this.style.display='none';this.nextElementSibling.style.display='grid'" />
        <div class="prof-avatar" style="display:none;background:${color}">${name[0]}</div>
        <button class="prof-photo-btn" onclick="document.getElementById('prof-photo-input').click()">+</button>
        <input type="file" id="prof-photo-input" accept="image/*" style="display:none"
          onchange="uploadProfilePhoto(this.files[0])" />
      </div>
      <div>
        <div class="prof-name" style="color:${color}">${esc(name)}</div>
        <div class="muted" style="font-size:11px">${esc(S.me?.role || 'Instructor')}</div>
      </div>
      <button class="prof-close" onclick="toggleProfileCard()">✕</button>
    </div>

    <div class="prof-links">
      <button class="btn btn-ghost" style="width:100%;justify-content:flex-start" onclick="showView('notifications');toggleProfileCard()">🔔 Notifications</button>
      <button class="btn btn-ghost" style="width:100%;justify-content:flex-start" onclick="showView('messages');toggleProfileCard()">✉ Messages</button>
    </div>

    <div class="prof-section">
      <div class="prof-section-title">Change Password</div>
      <input class="input" id="prof-old-pw" type="password" placeholder="Current password" style="margin-bottom:6px" />
      <input class="input" id="prof-new-pw" type="password" placeholder="New password" style="margin-bottom:6px" />
      <input class="input" id="prof-new-pw2" type="password" placeholder="Confirm new password" style="margin-bottom:6px" />
      <button class="btn btn-surf" onclick="changePassword()">Update Password</button>
      <div id="prof-pw-status" class="muted" style="font-size:11px;margin-top:4px"></div>
    </div>

    <div class="prof-section">
      <div class="prof-section-title">Recent Activity</div>
      <div id="prof-activity" class="prof-activity">Loading...</div>
    </div>`;

  // Load activity
  loadProfileActivity();
}

let store_notifications_cache = [];

async function loadProfileActivity() {
  try {
    const notifs = await GET('/api/notifications');
    store_notifications_cache = notifs;
    const el = document.getElementById('prof-activity');
    if (!el) return;
    // Show last 8 activities from either user
    const recent = notifs.slice(-8).reverse();
    el.innerHTML = recent.length ? recent.map(n => {
      const name = displayName(n.user);
      const color = authorColor(name);
      const time = new Date(n.time).toLocaleString('en-US', { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' });
      return `<div class="prof-activity-item">
        <span style="color:${color};font-weight:700;font-size:11px">${esc(name)}</span>
        <span class="muted" style="font-size:10px">${time}</span>
        <div style="font-size:11px">${esc(n.detail?.substring(0, 60) || '')}</div>
      </div>`;
    }).join('') : '<p class="muted" style="font-size:11px">No recent activity.</p>';
  } catch { const el = document.getElementById('prof-activity'); if (el) el.innerHTML = '<p class="muted" style="font-size:11px">Could not load.</p>'; }
}

async function uploadProfilePhoto(file) {
  if (!file) return;
  const form = new FormData();
  form.append('photo', file);
  try {
    await fetch(`/api/user-photo/${encodeURIComponent((S.me?.username || '').toLowerCase())}`, { method: 'POST', body: form });
    toast('Photo uploaded!', 'success');
    renderProfileCard();
  } catch (e) { toast('Upload failed: ' + e.message, 'error'); }
}

async function changePassword() {
  const old = document.getElementById('prof-old-pw')?.value;
  const pw1 = document.getElementById('prof-new-pw')?.value;
  const pw2 = document.getElementById('prof-new-pw2')?.value;
  const status = document.getElementById('prof-pw-status');
  if (!old || !pw1 || !pw2) { if (status) status.textContent = 'Fill in all fields.'; return; }
  if (pw1 !== pw2) { if (status) status.textContent = 'New passwords do not match.'; return; }
  if (pw1.length < 4) { if (status) status.textContent = 'Password too short (min 4).'; return; }
  try {
    await POST('/api/change-password', { oldPassword: old, newPassword: pw1 });
    if (status) { status.style.color = 'var(--success)'; status.textContent = 'Password updated!'; }
    document.getElementById('prof-old-pw').value = '';
    document.getElementById('prof-new-pw').value = '';
    document.getElementById('prof-new-pw2').value = '';
  } catch (e) { if (status) { status.style.color = 'var(--danger)'; status.textContent = e.message; } }
}

/* ── Notifications ─────────────────────────────────────────────────────────── */
let _notifPollTimer = null;

async function pollNotifications() {
  try {
    const { count } = await GET('/api/notifications/unread-count');
    const badge = document.getElementById('notif-badge');
    if (badge) {
      badge.textContent = count;
      badge.style.display = count > 0 ? '' : 'none';
    }
  } catch { /* silent */ }
}

function startNotifPoll() {
  pollNotifications();
  _notifPollTimer = setInterval(pollNotifications, 30000); // every 30s
}

async function renderNotificationsView(root) {
  root = root || document.getElementById('view-root');
  root.innerHTML = '<div class="loading-splash"><div class="loading-bounce"></div><div class="loading-text">Loading notifications<span class="loading-dots"></span></div></div>';

  try {
    const notifications = await GET('/api/notifications');

    // Mark all as read
    await POST('/api/notifications/mark-read', {});
    pollNotifications(); // update badge

    const unread = notifications.filter(n => !n.read);

    function renderList(items) {
      if (!items.length) return '<p class="muted" style="padding:10px 0">No notifications.</p>';
      return items.map(n => {
        const icon = n.action === 'grade_changed' ? '📝' : n.action === 'comment' ? '💬' : n.action === 'team_note' ? '👥' : n.action === 'rubric_changed' ? '📋' : '🔔';
        const time = new Date(n.time).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
        const uName = displayName(n.user);
        const uColor = authorColor(uName);
        const photoUrl = `/api/user-photo/${encodeURIComponent(n.user.toLowerCase())}`;
        // Build link
        let linkHtml = '';
        if (n.link) {
          const parts = n.link.split(':');
          if (parts[0] === 'assignment') {
            const tab = parts[2] || '';
            linkHtml = `<button class="link-btn" style="font-size:11px" onclick="selectAssignment('${esc(parts[1])}')${tab ? ";setTimeout(()=>switchAssignTab('" + esc(tab) + "'),200)" : ''}">View →</button>`;
          } else if (parts[0] === 'teams') {
            linkHtml = `<button class="link-btn" style="font-size:11px" onclick="showView('teams')">View Teams →</button>`;
          }
        }
        return `<div class="notif-item ${n.read ? 'notif-read' : 'notif-unread'}">
          <img class="notif-photo" src="${photoUrl}" onerror="this.style.display='none';this.nextElementSibling.style.display='grid'" />
          <span class="notif-avatar-fallback" style="display:none;background:${uColor}">${uName[0]}</span>
          <div class="notif-content">
            <div class="notif-user" style="color:${uColor}">${esc(uName)}</div>
            <div class="notif-detail">${esc(n.detail)}</div>
            ${linkHtml}
          </div>
          <span class="notif-time">${time}</span>
          <button class="notif-delete" onclick="deleteNotification('${esc(n.id)}')" title="Delete">✕</button>
        </div>`;
      }).join('');
    }

    root.innerHTML = `
      <div class="page-title">🔔 Notifications
        <div class="page-actions">
          <button class="btn btn-ghost" onclick="renderNotificationsView()">⟳ Refresh</button>
        </div>
      </div>
      ${unread.length ? `<div class="card" style="margin-bottom:12px">
        <div class="card-title">New (${unread.length})</div>
        <div class="notif-list">${renderList(unread)}</div>
      </div>` : ''}
      <div class="card">
        <div class="card-title">All Activity (${notifications.length})</div>
        <div class="notif-list">${renderList(notifications)}</div>
      </div>`;
  } catch (e) {
    root.innerHTML = `<p class="muted padded">Failed to load notifications: ${esc(e.message)}</p>`;
  }
}

async function deleteNotification(id) {
  try {
    await DEL(`/api/notifications/${encodeURIComponent(id)}`);
    renderNotificationsView();
  } catch (e) { toast('Delete failed: ' + e.message, 'error'); }
}

/* ── Boot ────────────────────────────────────────────────────────────────────── */
loadCurrentUser().then(() => { init(); startNotifPoll(); }).catch(console.error);
