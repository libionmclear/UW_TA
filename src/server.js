require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const mammoth = require('mammoth');
const pdfParse = require('pdf-parse');
const fetch = require('node-fetch');
const DEFAULT_SYLLABUS = require('./syllabus-data');
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
const DEFAULT_TEAM_META = {
  '1': { name: 'Nike',              memberNames: ['Alexia Drecin','Jacob Hilse','Handan Karakucuk','Will Nguyen','Uina Yamaguchi'] },
  '2': { name: 'Southwest',         memberNames: ['Fatimah Naji','Benny Nguyen','Issabella Nguyen','Kairi Rojas','Sing Well To'] },
  '3': { name: 'Ferrari',           memberNames: ['Andrew Brunson','Ari Cherny','Matthew Lee','Quentin Swanson','Josh Winiarski'] },
  '4': { name: 'Samsung Wearables', memberNames: ['Alfredo Alamdar','Dylan Brand','Aaron Gaceta','Yejun Noh','Iman Salhi'] },
  '5': { name: 'Peloton',           memberNames: ['Jade Ellis','Marlen Makramalla','Gabe Moreno','Paul Soper','Yordanos Abebaw Tsegaye'] },
  '6': { name: 'Sony',              memberNames: ['Isabelle Berariu','Sanjana Bonagiri','Devon Dang','Tammy Huynh','Laura Summers','Mark Trofimchik'] },
  '7': { name: '',                  memberNames: ['Nikita Dubitski','Lance Kimerer','Kamron Korrell','Francis Stellano Neri','David Semaan'] },
  '8': { name: 'GoPro',             memberNames: ['Makylie Bean','Kha-vy Bui','Caden Chiong','Noah Graetzer','Hailey Granvold'] },
};

const store = { rubrics: {}, grades: {}, assignmentSettings: {}, assignmentRubrics: {}, quizBank: { questions: [] }, syllabus: null, teams: {}, teamMeta: {}, dismissed: {}, notifications: [] };

try {
  if (fs.existsSync(DATA_FILE)) {
    const saved = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    Object.assign(store, saved);
    if (!store.assignmentSettings) store.assignmentSettings = {};
    if (!store.quizBank) store.quizBank = { questions: [] };
    if (!store.assignmentRubrics) store.assignmentRubrics = {};
  }
} catch { }
// Seed syllabus from default if never customized
if (!store.syllabus) store.syllabus = DEFAULT_SYLLABUS;
// Ensure store.json exists on disk at startup so data persists
save();

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

function addNotification(req, action, detail, groupKey, link) {
  if (!store.notifications) store.notifications = [];
  const user = req.session?.username || 'unknown';

  // If groupKey provided, update existing notification instead of creating duplicate
  if (groupKey) {
    const existing = store.notifications.find(n => n.groupKey === groupKey && n.user === user);
    if (existing) {
      existing.detail = detail;
      existing.time = new Date().toISOString();
      existing.readBy = []; // mark unread again
      if (existing.count) existing.count++; else existing.count = 2;
      if (link) existing.link = link;
      save();
      return;
    }
  }

  store.notifications.push({
    id: Date.now() + '_' + Math.random().toString(36).slice(2, 6),
    user,
    action,
    detail,
    time: new Date().toISOString(),
    readBy: [],
    groupKey: groupKey || null,
    count: 1,
    link: link || null,
  });
  // Keep last 200 notifications
  if (store.notifications.length > 200) store.notifications = store.notifications.slice(-200);
  save();
}

// ── Health (live connectivity checks, cached 5 min) ───────────────────────────
let _healthCache = { canvas: false, claude: false, at: 0 };
const HEALTH_TTL = 5 * 60 * 1000;

app.get('/api/health', async (_req, res) => {
  if (Date.now() - _healthCache.at < HEALTH_TTL) {
    return ok(res, { canvas: _healthCache.canvas, claude: _healthCache.claude });
  }
  let canvasOk = false, claudeOk = false;
  try { await canvas.testConnection(); canvasOk = true; } catch { canvasOk = false; }
  try {
    if (process.env.ANTHROPIC_API_KEY) {
      const Anthropic = require('@anthropic-ai/sdk');
      const c = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      await c.messages.create({ model: 'claude-haiku-4-5-20251001', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] });
      claudeOk = true;
    }
  } catch { claudeOk = false; }
  _healthCache = { canvas: canvasOk, claude: claudeOk, at: Date.now() };
  ok(res, { canvas: canvasOk, claude: claudeOk });
});

// ── Canvas ────────────────────────────────────────────────────────────────────
app.get('/api/courses', async (_req, res) => {
  try { ok(res, await canvas.getCourses()); } catch (e) { fail(res, e); }
});

app.get('/api/courses/:cid', async (req, res) => {
  try { ok(res, await canvas.getCourse(req.params.cid)); } catch (e) { fail(res, e); }
});

app.get('/api/courses/:cid/students', async (req, res) => {
  try {
    const enrollments = await canvas.getStudents(req.params.cid);
    const students = enrollments.map(e => ({
      id:    String(e.user_id || e.id),
      name:  e.user?.name || e.user?.short_name || `User ${e.user_id}`,
      email: e.user?.email || e.user?.login_id || '',
      sortableName: e.user?.sortable_name || e.user?.name || '',
    })).sort((a, b) => a.sortableName.localeCompare(b.sortableName));
    ok(res, students);
  } catch (e) { fail(res, e); }
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

app.put('/api/assignment-rubric/:cid/:aid', requireAuth, (req, res) => {
  const key = gradesKey(req.params.cid, req.params.aid);
  store.assignmentRubrics[key] = { ...req.body, updatedAt: new Date().toISOString() };
  addNotification(req, 'rubric_changed', `Updated rubric for assignment ${req.params.aid}`, `rubric_${req.params.aid}`, `assignment:${req.params.aid}`);
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

// ── Canvas bulk submissions (for Ledger) ─────────────────────────────────────
app.get('/api/canvas/course-submissions/:cid', async (req, res) => {
  try {
    const subs = await canvas.getAllSubmissions(req.params.cid);
    // Return as { assignmentId: { userId: score } }
    const result = {};
    subs.forEach(s => {
      const aid = String(s.assignment_id);
      const uid = String(s.user_id);
      if (!result[aid]) result[aid] = {};
      result[aid][uid] = s.score;
    });
    ok(res, result);
  } catch (e) { fail(res, e); }
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
  const prev = store.grades[key][req.params.studentId];
  store.grades[key][req.params.studentId] = { ...req.body, updatedAt: new Date().toISOString() };
  // Log grouped notification per assignment (updates count instead of new entry per student)
  if (req.body.finalScore != null && (!prev || prev.finalScore !== req.body.finalScore)) {
    const gKey = `grade_${req.params.cid}_${req.params.aid}`;
    const graded = Object.values(store.grades[key] || {}).filter(g => g.finalScore != null).length;
    const total = Object.keys(store.grades[key] || {}).length;
    addNotification(req, 'grade_changed',
      `Graded ${graded} of ${total} students (assignment ${req.params.aid})`,
      gKey, `assignment:${req.params.aid}`);
  }
  save();
  ok(res, store.grades[key][req.params.studentId]);
});

app.delete('/api/grades/:cid/:aid', (req, res) => {
  delete store.grades[gradesKey(req.params.cid, req.params.aid)];
  save();
  ok(res, { ok: true });
});

// ── AI Rubric Assistant ──────────────────────────────────────────────────────
app.post('/api/rubric/ai-assist', requireAuth, async (req, res) => {
  try {
    const { prompt, assignmentName, assignmentText, aiInstructions, currentCriteria, totalPoints } = req.body;
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const resp = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      messages: [{ role: 'user', content: `You are a rubric design assistant for a university marketing course.

ASSIGNMENT: ${assignmentName || 'Unknown'}
ASSIGNMENT DESCRIPTION: ${(assignmentText || '').substring(0, 2000)}
GRADING INSTRUCTIONS: ${(aiInstructions || '').substring(0, 1000)}
TOTAL POINTS: ${totalPoints || 15}

CURRENT RUBRIC CRITERIA:
${currentCriteria || '(none yet)'}

USER REQUEST: ${prompt}

Based on the request, either:
1. Generate a COMPLETE new rubric, OR
2. Suggest modifications to the existing rubric (add/remove/change criteria)

Respond ONLY with valid JSON:
{
  "message": "Brief explanation of what you did",
  "rubric": {
    "name": "Rubric name",
    "totalPoints": ${totalPoints || 15},
    "description": "...",
    "criteria": [
      { "id": "c1", "name": "Criterion Name", "maxPoints": 5, "description": "What earns full points", "autoGrant": false },
      ...
    ]
  }
}` }],
    });
    const raw = resp.content[0].text;
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('AI returned non-JSON');
    const parsed = JSON.parse(match[0]);
    ok(res, parsed);
  } catch (e) { fail(res, e); }
});

// ── AI Detection (standalone) ────────────────────────────────────────────────
app.post('/api/ai-detect', requireAuth, (req, res) => {
  try {
    const { text } = req.body;
    if (!text?.trim()) return ok(res, { pct: 0, level: 'TOO SHORT', message: 'No text provided', details: {} });
    const result = analyzeText(text);
    ok(res, result);
  } catch (e) { fail(res, e); }
});

// ── AI Student Feedback Generation ───────────────────────────────────────────
app.post('/api/grade/feedback', requireAuth, async (req, res) => {
  try {
    const { studentName, assignmentName, totalScore, totalPossible, criteriaContext, overallFeedback } = req.body;
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const resp = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 300,
      messages: [{ role: 'user', content: `Write ONE paragraph (3-5 sentences) of constructive student feedback for this graded assignment. Be encouraging but honest. Address what was done well and what could be improved. Write in second person ("You did well...").

Student: ${studentName}
Assignment: ${assignmentName}
Score: ${totalScore} / ${totalPossible}

Criteria breakdown:
${criteriaContext}

${overallFeedback ? `Instructor notes: ${overallFeedback}` : ''}

Write ONLY the feedback paragraph, no preamble:` }],
    });
    const feedback = resp.content[0].text.trim();
    ok(res, { feedback });
  } catch (e) { fail(res, e); }
});

// ── AI Grading ────────────────────────────────────────────────────────────────
app.post('/api/grade/single', async (req, res) => {
  try {
    const { text, rubric, studentName, hasAiCitation, aiInstructions, isCaseWriteup } = req.body;
    const [grade, detect] = await Promise.all([
      grader.gradeSubmission(text, rubric, studentName, aiInstructions || '', !!isCaseWriteup),
      Promise.resolve(analyzeText(text)),
    ]);
    ok(res, { grade, aiDetection: detect, flagged: !hasAiCitation && detect.pct >= 80 });
  } catch (e) { fail(res, e); }
});

app.post('/api/grade/batch', async (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  const { submissions, rubric, aiInstructions, isCaseWriteup } = req.body;
  let completed = 0;
  for (const sub of submissions) {
    try {
      const [grade, detect] = await Promise.all([
        grader.gradeSubmission(sub.text || '', rubric, sub.studentName, aiInstructions || '', !!isCaseWriteup),
        Promise.resolve(analyzeText(sub.text || '')),
      ]);
      completed++;
      send({ type: 'progress', completed, total: submissions.length, studentId: sub.studentId, studentName: sub.studentName, grade, aiDetection: detect, flagged: !sub.hasAiCitation && detect.pct >= 80 });
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
app.post('/api/quiz-bank/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return fail(res, { message: 'No file uploaded' }, 400);
  try {
    const name = req.file.originalname.toLowerCase();
    let text;
    if (name.endsWith('.docx') || name.endsWith('.doc')) {
      const result = await mammoth.extractRawText({ buffer: req.file.buffer });
      text = result.value;
    } else {
      text = req.file.buffer.toString('utf8', 0, Math.min(req.file.buffer.length, 200000));
    }
    ok(res, { filename: req.file.originalname, text: stripHtml(text.substring(0, 200000)) });
  } catch (e) { fail(res, e); }
});
app.post('/api/quiz-bank/parse-text', async (req, res) => {
  try {
    const { text } = req.body;
    if (!text?.trim()) return fail(res, { message: 'No text provided' }, 400);
    const questions = await grader.parseQuestionsFromText(text);
    ok(res, { questions });
  } catch (e) { fail(res, e); }
});

app.post('/api/quiz-bank/suggest', async (req, res) => {
  try {
    const { topic, courseContent, count } = req.body;
    ok(res, await grader.suggestQuizQuestions(store.quizBank?.questions || [], topic, courseContent, count || 5));
  } catch (e) { fail(res, e); }
});

// ── Create Quiz on Canvas from question bank ──────────────────────────────────
app.post('/api/canvas/create-quiz/:cid', async (req, res) => {
  try {
    const { cid } = req.params;
    const { title, description, timeLimit, allowedAttempts, pointsPossible, questions, publish } = req.body;

    if (!questions || !questions.length) return fail(res, { message: 'No questions provided.' }, 400);

    // 1. Create the quiz shell
    const quiz = await canvas.createQuiz(cid, {
      title: title || 'Quiz',
      description: description || '',
      quiz_type: 'assignment',
      time_limit: timeLimit || null,
      allowed_attempts: allowedAttempts || 1,
      points_possible: pointsPossible || questions.length * 1,
      published: false, // publish after adding questions
      show_correct_answers: true,
    });

    // 2. Add each question
    const added = [];
    for (const q of questions) {
      const qText   = typeof q === 'string' ? q : (q.question || '');
      const answer  = typeof q === 'string' ? '' : (q.answer || '');
      const choices = typeof q === 'string' ? [] : (q.choices || []);
      const pts     = typeof q === 'object' && q.points ? q.points : 1;

      let questionType = 'multiple_choice_question';
      let answers = [];

      if (choices.length >= 2) {
        // Multiple choice — mark correct answer by matching answer text or letter
        answers = choices.map((c, i) => {
          const choiceText = c.replace(/^[a-dA-D][\.\)]\s*/, '').trim();
          const choiceLetter = String.fromCharCode(65 + i); // A, B, C, D
          const isCorrect = answer
            ? (answer.toUpperCase().startsWith(choiceLetter) || answer.toLowerCase().includes(choiceText.toLowerCase().substring(0, 15)))
            : false;
          return { answer_text: choiceText, weight: isCorrect ? 100 : 0 };
        });
      } else if (answer) {
        // Short answer / essay
        questionType = 'short_answer_question';
        answers = [{ answer_text: answer, weight: 100 }];
      } else {
        // Essay (no answer key)
        questionType = 'essay_question';
        answers = [];
      }

      const created = await canvas.addQuizQuestion(cid, quiz.id, {
        question_name: `Question`,
        question_text: qText,
        question_type: questionType,
        points_possible: pts,
        answers,
      });
      added.push(created);
    }

    // 3. Optionally publish
    let finalQuiz = quiz;
    if (publish) {
      finalQuiz = await canvas.publishQuiz(cid, quiz.id);
    }

    ok(res, {
      quiz: finalQuiz,
      questionsAdded: added.length,
      quizUrl: `${process.env.CANVAS_BASE_URL}/courses/${cid}/quizzes/${quiz.id}`,
    });
  } catch (e) { fail(res, e); }
});

// ── Push grades to Canvas ─────────────────────────────────────────────────────
app.post('/api/canvas/push-grades/:cid/:aid', async (req, res) => {
  try {
    const { cid, aid } = req.params;
    const key = gradesKey(cid, aid);
    const grades = store.grades[key] || {};
    const entries = Object.values(grades).filter(g => g.finalScore != null && g.studentId);

    if (!entries.length) return fail(res, { message: 'No graded students to push.' }, 400);

    // Build grade_data object: { userId: { posted_grade: "score" }, ... }
    const gradeData = {};
    entries.forEach(g => {
      gradeData[g.studentId] = { posted_grade: String(g.finalScore) };
    });

    const result = await canvas.pushGradesBulk(cid, aid, gradeData);
    ok(res, { pushed: entries.length, result });
  } catch (e) { fail(res, e); }
});

// Push a single student grade to Canvas
app.post('/api/canvas/push-grade/:cid/:aid/:studentId', async (req, res) => {
  try {
    const { cid, aid, studentId } = req.params;
    const key = gradesKey(cid, aid);
    const g = store.grades[key]?.[studentId];
    if (!g || g.finalScore == null) return fail(res, { message: 'No final grade for this student.' }, 400);
    const result = await canvas.pushGrade(cid, aid, studentId, g.finalScore);
    ok(res, { pushed: true, studentId, finalScore: g.finalScore, result });
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

// ── Current user ──────────────────────────────────────────────────────────────
app.get('/api/me', requireAuth, (req, res) => ok(res, { username: req.session.username, role: req.session.role || 'admin' }));

// ── Assignment Comments (instructor chat) ─────────────────────────────────────
app.get('/api/comments/:cid/:aid', requireAuth, (req, res) => {
  const key = `${req.params.cid}__${req.params.aid}`;
  ok(res, (store.comments || {})[key] || []);
});
app.post('/api/comments/:cid/:aid', requireAuth, (req, res) => {
  if (!store.comments) store.comments = {};
  const key = `${req.params.cid}__${req.params.aid}`;
  if (!store.comments[key]) store.comments[key] = [];
  const { text } = req.body;
  if (!text?.trim()) return fail(res, { message: 'Empty comment' }, 400);
  const comment = { author: req.session.username, text: text.trim(), ts: new Date().toISOString() };
  store.comments[key].push(comment);
  addNotification(req, 'comment', `Wrote a note on assignment: "${text.trim().substring(0, 60)}${text.length > 60 ? '…' : ''}"`, null, `assignment:${req.params.aid}:chat`);
  save();
  ok(res, comment);
});

// ── Dismissed assignments (overview "Done") ───────────────────────────────────
app.get('/api/dismissed/:cid', (req, res) => ok(res, store.dismissed[req.params.cid] || []));
app.put('/api/dismissed/:cid', (req, res) => {
  store.dismissed[req.params.cid] = req.body;
  save();
  ok(res, store.dismissed[req.params.cid]);
});

// ── Teams ──────────────────────────────────────────────────────────────────────
app.get('/api/team-meta/:cid', (req, res) => {
  if (!store.teamMeta[req.params.cid]) store.teamMeta[req.params.cid] = DEFAULT_TEAM_META;
  ok(res, store.teamMeta[req.params.cid]);
});
app.put('/api/team-meta/:cid', requireAuth, (req, res) => {
  const prev = store.teamMeta[req.params.cid];
  store.teamMeta[req.params.cid] = req.body;
  // Detect new team notes
  if (req.body && prev) {
    Object.entries(req.body).forEach(([tNum, tData]) => {
      const prevNotes = prev[tNum]?.notes?.length || 0;
      const newNotes = tData?.notes?.length || 0;
      if (newNotes > prevNotes) {
        const latest = tData.notes[tData.notes.length - 1];
        addNotification(req, 'team_note', `Wrote a note for Team ${tNum}: "${(latest?.text || '').substring(0, 60)}${(latest?.text || '').length > 60 ? '…' : ''}"`, null, `teams:${tNum}`);
      }
    });
  }
  save();
  ok(res, store.teamMeta[req.params.cid]);
});

app.get('/api/teams/:cid', (req, res) => ok(res, store.teams[req.params.cid] || {}));
app.put('/api/teams/:cid', (req, res) => {
  store.teams[req.params.cid] = req.body;
  save();
  ok(res, store.teams[req.params.cid]);
});

// ── Syllabus ──────────────────────────────────────────────────────────────────
app.get('/api/syllabus', (_req, res) => ok(res, store.syllabus));
app.put('/api/syllabus', (req, res) => {
  if (!Array.isArray(req.body)) return fail(res, { message: 'Expected array' }, 400);
  store.syllabus = req.body;
  save();
  ok(res, store.syllabus);
});
// Reset to default
app.delete('/api/syllabus', (_req, res) => {
  store.syllabus = DEFAULT_SYLLABUS.map(r => ({ ...r }));
  save();
  ok(res, store.syllabus);
});

// ── Canvas file download helper ──────────────────────────────────────────────
async function fetchCanvasFile(url) {
  const authHeader = { Authorization: `Bearer ${process.env.CANVAS_API_TOKEN}` };

  // Strategy 1: Direct fetch with auth + follow redirects
  let resp = await fetch(url, { headers: authHeader, redirect: 'follow' });
  if (resp.ok) return Buffer.from(await resp.arrayBuffer());

  // Strategy 2: Manual redirect — Canvas → S3 drops auth header on cross-origin
  resp = await fetch(url, { headers: authHeader, redirect: 'manual' });
  if (resp.status >= 300 && resp.status < 400 && resp.headers.get('location')) {
    const s3Url = resp.headers.get('location');
    resp = await fetch(s3Url, { redirect: 'follow' });
    if (resp.ok) return Buffer.from(await resp.arrayBuffer());
  }

  // Strategy 3: If URL looks like a Canvas file API URL, try adding /download
  if (!url.includes('/download')) {
    const dlUrl = url.replace(/\?.*$/, '') + '/download?' + (url.split('?')[1] || '');
    resp = await fetch(dlUrl, { headers: authHeader, redirect: 'follow' });
    if (resp.ok) return Buffer.from(await resp.arrayBuffer());
    // Try manual redirect on download URL too
    resp = await fetch(dlUrl, { headers: authHeader, redirect: 'manual' });
    if (resp.status >= 300 && resp.status < 400 && resp.headers.get('location')) {
      resp = await fetch(resp.headers.get('location'), { redirect: 'follow' });
      if (resp.ok) return Buffer.from(await resp.arrayBuffer());
    }
  }

  throw new Error(`Failed to download Canvas file (tried multiple strategies). URL: ${url.substring(0, 100)}`);
}

// ── Canvas File Proxy (download attachments) ────────────────────────────────
app.get('/api/canvas/file-proxy', requireAuth, async (req, res) => {
  const fileUrl = req.query.url;
  if (!fileUrl) return fail(res, { message: 'No url provided' }, 400);
  try {
    const buf = await fetchCanvasFile(fileUrl);
    const ext = (fileUrl.match(/\.(\w+)(\?|$)/) || [])[1] || '';
    const mimeMap = { pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', doc: 'application/msword', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif' };
    res.setHeader('Content-Type', mimeMap[ext.toLowerCase()] || 'application/octet-stream');
    res.send(buf);
  } catch (e) { fail(res, e); }
});

// ── Extract text from Canvas attachment (PDF / DOCX) for AI grading ─────────
app.post('/api/canvas/extract-text', requireAuth, async (req, res) => {
  const { url, filename } = req.body;
  if (!url) return fail(res, { message: 'No url provided' }, 400);
  try {
    // Canvas file URLs redirect to S3 — need to handle the redirect chain
    const buf = await fetchCanvasFile(url);
    const name = (filename || '').toLowerCase();
    let text = '';
    if (name.endsWith('.pdf')) {
      const pdf = await pdfParse(buf);
      text = pdf.text;
    } else if (name.endsWith('.docx') || name.endsWith('.doc')) {
      const result = await mammoth.extractRawText({ buffer: buf });
      text = result.value;
    } else if (name.endsWith('.txt') || name.endsWith('.md') || name.endsWith('.csv') || name.endsWith('.html') || name.endsWith('.htm')) {
      text = buf.toString('utf8');
      text = stripHtml(text);
    } else {
      text = buf.toString('utf8', 0, Math.min(buf.length, 100000));
    }
    console.log(`  Extracted ${text.length} chars from ${filename || 'unknown'} (${buf.length} bytes)`);
    ok(res, { text: text.substring(0, 200000), filename });
  } catch (e) {
    console.error('Extract-text error:', e.message, '| url:', (url || '').substring(0, 100));
    fail(res, e);
  }
});

// ── Student Photos ──────────────────────────────────────────────────────────
const PHOTOS_DIR = path.join(__dirname, '../data/photos');
if (!fs.existsSync(PHOTOS_DIR)) fs.mkdirSync(PHOTOS_DIR, { recursive: true });

app.get('/api/student-photo/:studentId', (req, res) => {
  const sid = req.params.studentId;
  const exts = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
  for (const ext of exts) {
    const fp = path.join(PHOTOS_DIR, sid + ext);
    if (fs.existsSync(fp)) return res.sendFile(fp);
  }
  res.status(404).json({ error: 'No photo' });
});

app.post('/api/student-photo/:studentId', requireAuth, upload.single('photo'), (req, res) => {
  if (!req.file) return fail(res, { message: 'No file uploaded' }, 400);
  const sid = req.params.studentId;
  const ext = path.extname(req.file.originalname).toLowerCase() || '.jpg';
  // Remove old photos for this student
  const exts = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
  for (const e of exts) {
    const fp = path.join(PHOTOS_DIR, sid + e);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  }
  const fp = path.join(PHOTOS_DIR, sid + ext);
  fs.writeFileSync(fp, req.file.buffer);
  ok(res, { ok: true, path: `/api/student-photo/${sid}` });
});

app.delete('/api/student-photo/:studentId', requireAuth, (req, res) => {
  const sid = req.params.studentId;
  const exts = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
  for (const e of exts) {
    const fp = path.join(PHOTOS_DIR, sid + e);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  }
  ok(res, { ok: true });
});

// ── Notifications ────────────────────────────────────────────────────────────
app.get('/api/notifications', requireAuth, (req, res) => {
  const user = req.session.username;
  const all = store.notifications || [];
  // Return notifications from OTHER users, with read status for current user
  const forUser = all
    .filter(n => n.user !== user)
    .map(n => ({ ...n, read: (n.readBy || []).includes(user) }));
  ok(res, forUser);
});

app.get('/api/notifications/unread-count', requireAuth, (req, res) => {
  const user = req.session.username;
  const count = (store.notifications || [])
    .filter(n => n.user !== user && !(n.readBy || []).includes(user))
    .length;
  ok(res, { count });
});

app.delete('/api/notifications/:id', requireAuth, (req, res) => {
  store.notifications = (store.notifications || []).filter(n => n.id !== req.params.id);
  save();
  ok(res, { ok: true });
});

app.post('/api/notifications/mark-read', requireAuth, (req, res) => {
  const user = req.session.username;
  (store.notifications || []).forEach(n => {
    if (!n.readBy) n.readBy = [];
    if (!n.readBy.includes(user)) n.readBy.push(user);
  });
  save();
  ok(res, { ok: true });
});

// ── Canvas Analytics ─────────────────────────────────────────────────────────
app.get('/api/analytics/:cid/students', requireAuth, async (req, res) => {
  try { ok(res, await canvas.getStudentAnalytics(req.params.cid)); } catch (e) { fail(res, e); }
});
app.get('/api/analytics/:cid/activity', requireAuth, async (req, res) => {
  try { ok(res, await canvas.getCourseActivity(req.params.cid)); } catch (e) { fail(res, e); }
});

// ── Textbook Storage ─────────────────────────────────────────────────────────
app.get('/api/textbook', requireAuth, (_req, res) => {
  ok(res, { text: store.textbook || '', filename: store.textbookFilename || '' });
});
app.post('/api/textbook', requireAuth, upload.single('file'), async (req, res) => {
  try {
    let text = '';
    const name = (req.file?.originalname || '').toLowerCase();
    if (req.file) {
      if (name.endsWith('.pdf')) {
        const pdf = await pdfParse(req.file.buffer);
        text = pdf.text;
      } else if (name.endsWith('.docx') || name.endsWith('.doc')) {
        const result = await mammoth.extractRawText({ buffer: req.file.buffer });
        text = result.value;
      } else {
        text = req.file.buffer.toString('utf8', 0, Math.min(req.file.buffer.length, 500000));
        text = stripHtml(text);
      }
    } else if (req.body.text) {
      text = req.body.text;
    }
    store.textbook = text.substring(0, 500000);
    store.textbookFilename = req.file?.originalname || 'pasted text';
    save();
    ok(res, { chars: store.textbook.length, filename: store.textbookFilename });
  } catch (e) { fail(res, e); }
});
app.delete('/api/textbook', requireAuth, (_req, res) => {
  store.textbook = ''; store.textbookFilename = '';
  save();
  ok(res, { ok: true });
});

// ── Canvas Messages ──────────────────────────────────────────────────────────
app.get('/api/messages', requireAuth, async (_req, res) => {
  try { ok(res, await canvas.getConversations()); } catch (e) { fail(res, e); }
});
app.get('/api/messages/:id', requireAuth, async (req, res) => {
  try { ok(res, await canvas.getConversation(req.params.id)); } catch (e) { fail(res, e); }
});
app.post('/api/messages/:id/reply', requireAuth, async (req, res) => {
  try {
    const result = await canvas.replyToConversation(req.params.id, req.body.body);
    addNotification(req, 'message_sent', `Replied to conversation ${req.params.id}`);
    ok(res, result);
  } catch (e) { fail(res, e); }
});

// ── Change Password ──────────────────────────────────────────────────────────
app.post('/api/change-password', requireAuth, (req, res) => {
  const { oldPassword, newPassword } = req.body;
  if (!oldPassword || !newPassword) return fail(res, { message: 'Missing fields' }, 400);
  if (newPassword.length < 4) return fail(res, { message: 'Password too short' }, 400);
  const user = USERS.find(u => u.username === req.session.username);
  if (!user) return fail(res, { message: 'User not found' }, 404);
  if (user.password !== oldPassword) return fail(res, { message: 'Old password incorrect' }, 401);
  user.password = newPassword;
  try { fs.writeFileSync(USERS_FILE, JSON.stringify(USERS, null, 2)); } catch { }
  ok(res, { ok: true });
});

// ── User Profile Photo ──────────────────────────────────────────────────────
app.get('/api/user-photo/:username', (req, res) => {
  const name = req.params.username.toLowerCase();
  const exts = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
  for (const ext of exts) {
    const fp = path.join(PHOTOS_DIR, 'user_' + name + ext);
    if (fs.existsSync(fp)) return res.sendFile(fp);
  }
  res.status(404).json({ error: 'No photo' });
});
app.post('/api/user-photo/:username', requireAuth, upload.single('photo'), (req, res) => {
  if (!req.file) return fail(res, { message: 'No file' }, 400);
  const name = req.params.username.toLowerCase();
  const ext = path.extname(req.file.originalname).toLowerCase() || '.jpg';
  const exts = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
  for (const e of exts) { const fp = path.join(PHOTOS_DIR, 'user_' + name + e); if (fs.existsSync(fp)) fs.unlinkSync(fp); }
  fs.writeFileSync(path.join(PHOTOS_DIR, 'user_' + name + ext), req.file.buffer);
  ok(res, { ok: true });
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
