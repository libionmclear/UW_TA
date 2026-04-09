const fetch = require('node-fetch');
const { API_URL, CANVAS_API_TOKEN } = require('./config');

const headers = {
  Authorization: `Bearer ${CANVAS_API_TOKEN}`,
  'Content-Type': 'application/json',
};

async function canvasGet(endpoint) {
  const url = `${API_URL}${endpoint}`;
  const res = await fetch(url, { headers });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Canvas API error ${res.status}: ${text}`);
  }
  return res.json();
}

// Fetch all pages of a paginated Canvas endpoint, following Link: rel="next" headers
async function canvasGetAll(endpoint) {
  let url = `${API_URL}${endpoint}`;
  let all = [];
  while (url) {
    const res = await fetch(url, { headers });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Canvas API error ${res.status}: ${text}`);
    }
    const page = await res.json();
    all = all.concat(page);
    // Parse Link header for next page
    const link = res.headers.get('Link') || '';
    const nextMatch = link.match(/<([^>]+)>;\s*rel="next"/);
    url = nextMatch ? nextMatch[1] : null;
  }
  return all;
}

async function testConnection() {
  const user = await canvasGet('/users/self');
  return user;
}

async function getCourses() {
  return canvasGet('/courses?enrollment_type=teacher&per_page=50');
}

async function getCourse(courseId) {
  return canvasGet(`/courses/${courseId}`);
}

async function getAssignments(courseId) {
  return canvasGetAll(`/courses/${courseId}/assignments?per_page=100&order_by=due_at`);
}

async function getStudents(courseId) {
  return canvasGetAll(`/courses/${courseId}/enrollments?type[]=StudentEnrollment&per_page=100`);
}

async function getSubmissions(courseId, assignmentId) {
  return canvasGetAll(`/courses/${courseId}/assignments/${assignmentId}/submissions?per_page=100&include[]=user&include[]=submission_comments`);
}

async function getSubmissionText(courseId, assignmentId, userId) {
  return canvasGet(`/courses/${courseId}/assignments/${assignmentId}/submissions/${userId}?include[]=submission_history`);
}

async function getAnnouncements(courseId) {
  return canvasGet(`/courses/${courseId}/discussion_topics?only_announcements=true&per_page=20`);
}

async function getModules(courseId) {
  return canvasGet(`/courses/${courseId}/modules?per_page=50&include[]=items`);
}

async function getModuleItems(courseId, moduleId) {
  return canvasGet(`/courses/${courseId}/modules/${moduleId}/items?per_page=50`);
}

async function getPages(courseId) {
  return canvasGet(`/courses/${courseId}/pages?per_page=50&sort=updated_at&order=desc`);
}

async function getPage(courseId, pageUrl) {
  return canvasGet(`/courses/${courseId}/pages/${pageUrl}`);
}

async function getFiles(courseId) {
  return canvasGet(`/courses/${courseId}/files?per_page=50&sort=updated_at&order=desc`);
}

// Fetch all submissions for all students across all assignments in a course (paginated)
async function getAllSubmissions(courseId) {
  return canvasGetAll(`/courses/${courseId}/students/submissions?student_ids[]=all&per_page=100`);
}

// Push a grade back to Canvas for a single student
async function pushGrade(courseId, assignmentId, userId, grade) {
  const url = `${API_URL}/courses/${courseId}/assignments/${assignmentId}/submissions/${userId}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ submission: { posted_grade: String(grade) } }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Canvas API error ${res.status}: ${text}`);
  }
  return res.json();
}

// ── Canvas Quizzes ───────────────────────────────────────────────────────────
async function getQuizzes(courseId) {
  return canvasGetAll(`/courses/${courseId}/quizzes?per_page=50`);
}

async function createQuiz(courseId, quizData) {
  // quizData: { title, description, quiz_type, time_limit, allowed_attempts, points_possible, published }
  const url = `${API_URL}/courses/${courseId}/quizzes`;
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ quiz: quizData }),
  });
  if (!res.ok) { const t = await res.text(); throw new Error(`Canvas ${res.status}: ${t}`); }
  return res.json();
}

async function addQuizQuestion(courseId, quizId, questionData) {
  // questionData: { question_name, question_text, question_type, points_possible, answers: [{text, weight}] }
  const url = `${API_URL}/courses/${courseId}/quizzes/${quizId}/questions`;
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ question: questionData }),
  });
  if (!res.ok) { const t = await res.text(); throw new Error(`Canvas ${res.status}: ${t}`); }
  return res.json();
}

async function publishQuiz(courseId, quizId) {
  const url = `${API_URL}/courses/${courseId}/quizzes/${quizId}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ quiz: { published: true } }),
  });
  if (!res.ok) { const t = await res.text(); throw new Error(`Canvas ${res.status}: ${t}`); }
  return res.json();
}

// Push grades for all students in bulk (uses grade_data endpoint)
async function pushGradesBulk(courseId, assignmentId, gradeData) {
  // gradeData: { userId: { posted_grade: "85" }, ... }
  const url = `${API_URL}/courses/${courseId}/assignments/${assignmentId}/submissions/update_grades`;
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ grade_data: gradeData }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Canvas API error ${res.status}: ${text}`);
  }
  return res.json();
}

// ── Canvas Analytics ─────────────────────────────────────────────────────────
async function getStudentAnalytics(courseId) {
  // Course-level student summaries: page views, participations, time on site
  return canvasGet(`/courses/${courseId}/analytics/student_summaries?per_page=100`);
}

async function getCourseActivity(courseId) {
  return canvasGet(`/courses/${courseId}/analytics/activity`);
}

// ── Canvas Send New Message ──────────────────────────────────────────────────
async function sendMessage(recipientIds, subject, body) {
  const url = `${API_URL}/conversations`;
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ recipients: recipientIds, subject, body, group_conversation: false, force_new: true }),
  });
  if (!res.ok) throw new Error(`Canvas API error ${res.status}: ${await res.text()}`);
  return res.json();
}

// ── Canvas Conversations (Messages) ──────────────────────────────────────────
async function getConversations(scope = 'inbox') {
  return canvasGet(`/conversations?scope=${scope}&per_page=30`);
}

async function getConversation(id) {
  return canvasGet(`/conversations/${id}`);
}

async function replyToConversation(id, body, recipientIds) {
  const url = `${API_URL}/conversations/${id}/add_message`;
  const payload = { body };
  // If recipientIds provided, only send to those users (not whole class)
  if (recipientIds?.length) payload.recipients = recipientIds;
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Canvas API error ${res.status}: ${await res.text()}`);
  return res.json();
}

module.exports = {
  testConnection,
  getCourses,
  getCourse,
  getAssignments,
  getStudents,
  getSubmissions,
  getSubmissionText,
  getAnnouncements,
  getModules,
  getModuleItems,
  getPages,
  getPage,
  getFiles,
  pushGrade,
  pushGradesBulk,
  getQuizzes,
  createQuiz,
  addQuizQuestion,
  publishQuiz,
  getAllSubmissions,
  sendMessage,
  getConversations,
  getConversation,
  replyToConversation,
  getStudentAnalytics,
  getCourseActivity,
};
