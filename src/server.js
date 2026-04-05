require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const canvas = require('./canvas-client');
const { analyzeText, stripHtml } = require('./ai-detector');
const grader = require('./grader');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, '../public')));

// ── Persistence ──────────────────────────────────────────────────────────────
const DATA_FILE = path.join(__dirname, '../data/store.json');

const store = { rubrics: {}, grades: {} };

try {
  if (fs.existsSync(DATA_FILE)) {
    Object.assign(store, JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')));
  }
} catch { /* start fresh */ }

function save() {
  try {
    const dir = path.dirname(DATA_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2));
  } catch (e) {
    console.error('Save failed:', e.message);
  }
}

// ── Upload storage ────────────────────────────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});

// ── Helpers ───────────────────────────────────────────────────────────────────
const gradesKey = (courseId, assignmentId) => `${courseId}__${assignmentId}`;

function ok(res, data) { res.json(data); }
function fail(res, e, code = 500) { res.status(code).json({ error: e.message || e }); }

// ── Health ─────────────────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
  ok(res, {
    canvas: !!(process.env.CANVAS_API_TOKEN && process.env.CANVAS_BASE_URL),
    claude: !!process.env.ANTHROPIC_API_KEY,
  });
});

// ── Canvas ─────────────────────────────────────────────────────────────────────
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
  try {
    ok(res, await canvas.getSubmissions(req.params.cid, req.params.aid));
  } catch (e) { fail(res, e); }
});

// ── Rubrics ───────────────────────────────────────────────────────────────────
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

// Generate rubric with AI
app.post('/api/rubrics/generate', async (req, res) => {
  try {
    ok(res, await grader.generateRubric(req.body.description, req.body.totalPoints));
  } catch (e) { fail(res, e); }
});

// ── Grades ────────────────────────────────────────────────────────────────────
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

// ── AI grading ────────────────────────────────────────────────────────────────
app.post('/api/grade/single', async (req, res) => {
  try {
    const { text, rubric, studentName, hasAiCitation } = req.body;
    const [grade, detect] = await Promise.all([
      grader.gradeSubmission(text, rubric, studentName),
      Promise.resolve(analyzeText(text)),
    ]);
    ok(res, { grade, aiDetection: detect, flagged: !hasAiCitation && detect.score >= 7 });
  } catch (e) { fail(res, e); }
});

// Streaming batch grade (SSE)
app.post('/api/grade/batch', async (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  const { submissions, rubric } = req.body;
  let completed = 0;

  for (const sub of submissions) {
    try {
      const [grade, detect] = await Promise.all([
        grader.gradeSubmission(sub.text || '', rubric, sub.studentName),
        Promise.resolve(analyzeText(sub.text || '')),
      ]);
      completed++;
      send({
        type: 'progress',
        completed,
        total: submissions.length,
        studentId: sub.studentId,
        studentName: sub.studentName,
        grade,
        aiDetection: detect,
        flagged: !sub.hasAiCitation && detect.score >= 7,
      });
    } catch (err) {
      completed++;
      send({ type: 'error', completed, total: submissions.length, studentId: sub.studentId, error: err.message });
    }
  }

  send({ type: 'complete', total: submissions.length });
  res.end();
});

// ── File upload → text extraction ─────────────────────────────────────────────
app.post('/api/upload/text', upload.single('file'), (req, res) => {
  if (!req.file) return fail(res, { message: 'No file uploaded' }, 400);
  // For plain text files, return buffer as string
  // PDF/DOCX parsing would need additional libraries — return raw for now
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
    ...criteria.flatMap(c => [`${c.name} — AI (/${c.maxPoints})`, `${c.name} — Human (/${c.maxPoints})`]),
    'Total AI', 'Total Human', 'Final Score', 'Status', 'AI Signals', 'Notes',
  ];

  const rows = grades.map(g => [
    g.studentName,
    g.studentId,
    g.submitted ? 'Yes' : 'No',
    g.isLate ? 'LATE' : '',
    g.flagged ? 'FLAGGED' : '',
    g.aiDetection ? `${Math.round((g.aiDetection.score / 10) * 100)}%` : '',
    ...criteria.flatMap(c => [
      g.criteria?.[c.id]?.aiScore ?? '',
      g.criteria?.[c.id]?.humanScore ?? '',
    ]),
    g.aiTotalScore ?? '',
    g.humanTotalScore ?? '',
    g.finalScore ?? '',
    g.status || 'pending',
    (g.aiDetection?.details?.aiPhrases?.matched || []).slice(0, 3).join('; '),
    g.notes || '',
  ]);

  const csv = [headers, ...rows]
    .map(row => row.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(','))
    .join('\r\n');

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="grades_${req.params.aid}.csv"`);
  res.send(csv);
});

// ── SPA fallback ──────────────────────────────────────────────────────────────
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, '../public/index.html')));

app.listen(PORT, () => {
  console.log(`\n  TA Companion  →  http://localhost:${PORT}\n`);
  console.log(`  Canvas:  ${process.env.CANVAS_API_TOKEN ? 'configured' : 'NOT SET'}`);
  console.log(`  Claude:  ${process.env.ANTHROPIC_API_KEY ? 'configured' : 'NOT SET'}\n`);
});
