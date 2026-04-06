require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const canvas = require('./canvas-client');
const { analyzeText, stripHtml } = require('./ai-detector');
const grader = require('./grader');

const app = express();
const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || 'ta-companion-secret-change-me';

app.use(express.json({ limit: '50mb' }));

// ── Sessions ──────────────────────────────────────────────────────────────────
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, maxAge: 8 * 60 * 60 * 1000 },
}));

// ── Users ──────────────────────────────────────────────────────────────────────
const USERS_FILE = path.join(__dirname, '../data/users.json');
let USERS = [];
try {
  if (fs.existsSync(USERS_FILE)) USERS = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
} catch { }
if (!USERS.length && process.env.USERS_JSON) {
  try { USERS = JSON.parse(process.env.USERS_JSON); } catch { }
}
if (!USERS.length) {
  USERS = [{ username: process.env.TA_USERNAME || 'admin', password: process.env.TA_PASSWORD || 'changeme', role: 'admin' }];
}

// ── Auth ──────────────────────────────────────────────────────────────────────
app.post('/auth/login', (req, res) => {
  const { username, password } = req.body;
  const user = USERS.find(u => u.username === username && u.password === password);
  if (user) {
    req.session.authenticated = true;
    req.session.username = username;
    req.session.role = user.role || 'admin';
    return res.json({ ok: true });
  }
  res.status(401).json({ error: 'Invalid credentials' });
});

app.post('/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/auth/me', (req, res) => {
  res.json({ authenticated: !!req.session.authenticated, username: req.session.username, role: req.session.role });
});

// ── Auth guard ────────────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (req.session.authenticated) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not authenticated' });
  res.redirect('/login.html');
}

app.use((req, res, next) => {
  if (req.path === '/login.html' || req.path.startsWith('/auth/')) return next();
  requireAuth(req, res, next);
});

app.use(express.static(path.join(__dirname, '../public')));

// ── Persistence ──────────────────────────────────────────────────────────────
const DATA_FILE = path.join(__dirname, '../data/store.json');
const store = { rubrics: {}, grades: {}, assignmentSettings: {}, assignmentRubrics: {}, quizBank: { questions: [] } };

try {
  if (fs.existsSync(DATA_FILE)) {
    const saved = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    Object.assign(store, saved);
    if (!store.assignmentSettings) store.assignmentSettings = {};
    if (!store.quizBank) store.quizBank = { questions: [] };
    if (!store.assignmentRubrics) store.assignmentRubrics = {};
  }
} catch { }

function save() {
  try {
    const dir = path.dirname(DATA_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2));
  } catch (e) { console.error('Save failed:', e.message); }
}

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// ── Helpers ───────────────────────────────────────────────────────────────────
const gradesKey  = (cid, aid) => `${cid}__${aid}`;
function ok(res, data)   { res.json(data); }
function fail(res, e, code = 500) { res.status(code).json({ error: e.message || e }); }

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
  ok(res, {
    canvas: !!(process.env.CANVAS_API_TOKEN && process.env.CANVAS_BASE_URL),
    claude: !!process.env.ANTHROPIC_API_KEY,
  });
});

// ── Canvas ────────────────────────────────────────────────────────────────────
app.get('/api/courses', async (_req, res) => {
  try { ok(res, await canvas.getCourses()); } catch (e) { fail(res, e); }
});

app.get('/api/courses/:cid', async (req, res) => {
  try { ok(res, await canvas.getCourse(req.params.cid)); } catch (e) { fail(res, e); }
});

app.get('/api/courses/:cid/students', async (req, res) => {
  try { ok(res, await canvas.getStudents(req.params.cid)); } catch (e) { fail(res, e); }
});

app.get('/api/courses/:cid/assignments', async (req, res) => {
  try { ok(res, await canvas.getAssignments(req.params.cid)); } catch (e) { fail(res, e); }
});

app.get('/api/courses/:cid/assignments/:aid/submissions', async (req, res) => {
  try { ok(res, await canvas.getSubmissions(req.params.cid, req.params.aid)); } catch (e) { fail(res, e); }
});

app.get('/api/courses/:cid/modules', async (req, res) => {
  try {
    const modules = await canvas.getModules(req.params.cid);
    const withItems = await Promise.all(modules.map(async m => {
      try { return { ...m, items: await canvas.getModuleItems(req.params.cid, m.id) }; }
      catch { return { ...m, items: [] }; }
    }));
    ok(res, withItems);
  } catch (e) { fail(res, e); }
});

app.get('/api/courses/:cid/pages', async (req, res) => {
  try { ok(res, await canvas.getPages(req.params.cid)); } catch (e) { fail(res, e); }
});

app.get('/api/courses/:cid/pages/:pageUrl', async (req, res) => {
  try { ok(res, await canvas.getPage(req.params.cid, req.params.pageUrl)); } catch (e) { fail(res, e); }
});

app.get('/api/courses/:cid/files', async (req, res) => {
  try { ok(res, await canvas.getFiles(req.params.cid)); } catch (e) { fail(res, e); }
});

// ── Assignment Settings ───────────────────────────────────────────────────────
app.get('/api/assignment-settings/:cid/:aid', (req, res) => {
  ok(res, store.assignmentSettings[gradesKey(req.params.cid, req.params.aid)] || {});
});

app.put('/api/assignment-settings/:cid/:aid', (req, res) => {
  const key = gradesKey(req.params.cid, req.params.aid);
  store.assignmentSettings[key] = { ...req.body, updatedAt: new Date().toISOString() };
  save();
  ok(res, store.assignmentSettings[key]);
});

// ── Assignment Rubrics (per-assignment) ───────────────────────────────────────
app.get('/api/assignment-rubric/:cid/:aid', (req, res) => {
  ok(res, store.assignmentRubrics[gradesKey(req.params.cid, req.params.aid)] || null);
});

app.put('/api/assignment-rubric/:cid/:aid', (req, res) => {
  const key = gradesKey(req.params.cid, req.params.aid);
  store.assignmentRubrics[key] = { ...req.body, updatedAt: new Date().toISOString() };
  save();
  ok(res, store.assignmentRubrics[key]);
});

// ── Global Saved Rubrics ──────────────────────────────────────────────────────
app.get('/api/rubrics', (_req, res) => ok(res, Object.values(store.rubrics)));
app.get('/api/rubrics/:id', (req, res) => {
  const r = store.rubrics[req.params.id];
  return r ? ok(res, r) : fail(res, { message: 'Not found' }, 404);
});
app.post('/api/rubrics', (req, res) => {
  const r = { ...req.body, id: req.body.id || String(Date.now()), createdAt: new Date().toISOString() };
  store.rubrics[r.id] = r;
  save();
  ok(res, r);
});
app.put('/api/rubrics/:id', (req, res) => {
  store.rubrics[req.params.id] = { ...req.body, id: req.params.id };
  save();
  ok(res, store.rubrics[req.params.id]);
});
app.delete('/api/rubrics/:id', (req, res) => {
  delete store.rubrics[req.params.id];
  save();
  ok(res, { ok: true });
});
app.post('/api/rubrics/generate', async (req, res) => {
  try { ok(res, await grader.generateRubric(req.body.description, req.body.totalPoints)); }
  catch (e) { fail(res, e); }
});

// ── Grades ────────────────────────────────────────────────────────────────────
// All grades for a course (for overview dashboard)
app.get('/api/grades/:cid/all', (req, res) => {
  const prefix = `${req.params.cid}__`;
  const result = {};
  Object.keys(store.grades).forEach(key => {
    if (key.startsWith(prefix)) result[key.slice(prefix.length)] = store.grades[key];
  });
  ok(res, result);
});

app.get('/api/grades/:cid/:aid', (req, res) => {
  ok(res, store.grades[gradesKey(req.params.cid, req.params.aid)] || {});
});

app.put('/api/grades/:cid/:aid/:studentId', (req, res) => {
  const key = gradesKey(req.params.cid, req.params.aid);
  if (!store.grades[key]) store.grades[key] = {};
  store.grades[key][req.params.studentId] = { ...req.body, updatedAt: new Date().toISOString() };
  save();
  ok(res, store.grades[key][req.params.studentId]);
});

app.delete('/api/grades/:cid/:aid', (req, res) => {
  delete store.grades[gradesKey(req.params.cid, req.params.aid)];
  save();
  ok(res, { ok: true });
});

// ── AI Grading ────────────────────────────────────────────────────────────────
app.post('/api/grade/single', async (req, res) => {
  try {
    const { text, rubric, studentName, hasAiCitation, aiInstructions } = req.body;
    const [grade, detect] = await Promise.all([
      grader.gradeSubmission(text, rubric, studentName, aiInstructions || ''),
      Promise.resolve(analyzeText(text)),
    ]);
    ok(res, { grade, aiDetection: detect, flagged: !hasAiCitation && detect.score >= 7 });
  } catch (e) { fail(res, e); }
});

app.post('/api/grade/batch', async (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  const { submissions, rubric, aiInstructions } = req.body;
  let completed = 0;
  for (const sub of submissions) {
    try {
      const [grade, detect] = await Promise.all([
        grader.gradeSubmission(sub.text || '', rubric, sub.studentName, aiInstructions || ''),
        Promise.resolve(analyzeText(sub.text || '')),
      ]);
      completed++;
      send({ type: 'progress', completed, total: submissions.length, studentId: sub.studentId, studentName: sub.studentName, grade, aiDetection: detect, flagged: !sub.hasAiCitation && detect.score >= 7 });
    } catch (err) {
      completed++;
      send({ type: 'error', completed, total: submissions.length, studentId: sub.studentId, error: err.message });
    }
  }
  send({ type: 'complete', total: submissions.length });
  res.end();
});

// ── Quiz Bank ─────────────────────────────────────────────────────────────────
app.get('/api/quiz-bank', (_req, res) => ok(res, store.quizBank));
app.put('/api/quiz-bank', (req, res) => { store.quizBank = req.body; save(); ok(res, store.quizBank); });
app.delete('/api/quiz-bank', (_req, res) => { store.quizBank = { questions: [] }; save(); ok(res, { ok: true }); });
app.post('/api/quiz-bank/upload', upload.single('file'), (req, res) => {
  if (!req.file) return fail(res, { message: 'No file uploaded' }, 400);
  const text = req.file.buffer.toString('utf8', 0, Math.min(req.file.buffer.length, 200000));
  ok(res, { filename: req.file.originalname, text: stripHtml(text) });
});
app.post('/api/quiz-bank/suggest', async (req, res) => {
  try {
    const { topic, courseContent, count } = req.body;
    ok(res, await grader.suggestQuizQuestions(store.quizBank?.questions || [], topic, courseContent, count || 5));
  } catch (e) { fail(res, e); }
});

// ── File upload ───────────────────────────────────────────────────────────────
app.post('/api/upload/text', upload.single('file'), (req, res) => {
  if (!req.file) return fail(res, { message: 'No file uploaded' }, 400);
  const text = req.file.buffer.toString('utf8', 0, Math.min(req.file.buffer.length, 100000));
  ok(res, { filename: req.file.originalname, text: stripHtml(text) });
});

// ── CSV Export ────────────────────────────────────────────────────────────────
app.get('/api/grades/:cid/:aid/export.csv', (req, res) => {
  const grades = Object.values(store.grades[gradesKey(req.params.cid, req.params.aid)] || {});
  if (!grades.length) return fail(res, { message: 'No grades to export' }, 404);
  const rubric = grades[0].rubric;
  const criteria = rubric?.criteria || [];
  const headers = [
    'Student Name', 'Student ID', 'Submitted', 'Late', 'AI Flagged', 'AI Confidence',
    ...criteria.flatMap(c => [
      `${c.name} — AI (/${c.maxPoints})`,
      `${c.name} — Marco (/${c.maxPoints})`,
      `${c.name} — Marlowe (/${c.maxPoints})`,
    ]),
    'Total AI', 'Total Marco', 'Total Marlowe', 'Final Score', 'Status', 'AI Signals', 'Notes',
  ];
  const rows = grades.map(g => [
    g.studentName, g.studentId,
    g.submitted ? 'Yes' : 'No',
    g.isLate ? 'LATE' : '',
    g.flagged ? 'FLAGGED' : '',
    g.aiDetection ? `${Math.round((g.aiDetection.score / 10) * 100)}%` : '',
    ...criteria.flatMap(c => [
      g.criteria?.[c.id]?.aiScore ?? '',
      g.criteria?.[c.id]?.marcoScore ?? '',
      g.criteria?.[c.id]?.marlowScore ?? '',
    ]),
    g.aiTotalScore ?? '', g.marcoTotalScore ?? '', g.marloweTotalScore ?? '',
    g.finalScore ?? '', g.status || 'pending',
    (g.aiDetection?.details?.aiPhrases?.matched || []).slice(0, 3).join('; '),
    g.notes || '',
  ]);
  const csv = [headers, ...rows].map(row => row.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="grades_${req.params.aid}.csv"`);
  res.send(csv);
});

// ── SPA fallback ──────────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  if (!req.session.authenticated) return res.redirect('/login.html');
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

app.listen(PORT, () => {
  console.log(`\n  TA Companion  →  http://localhost:${PORT}\n`);
  console.log(`  Canvas:  ${process.env.CANVAS_API_TOKEN ? 'configured' : 'NOT SET'}`);
  console.log(`  Claude:  ${process.env.ANTHROPIC_API_KEY ? 'configured' : 'NOT SET'}`);
  console.log(`  Users:   ${USERS.map(u => u.username).join(', ')}\n`);
});
