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
  return canvasGet(`/courses/${courseId}/assignments?per_page=50&order_by=due_at`);
}

async function getStudents(courseId) {
  return canvasGet(`/courses/${courseId}/enrollments?type[]=StudentEnrollment&per_page=100`);
}

async function getSubmissions(courseId, assignmentId) {
  return canvasGet(`/courses/${courseId}/assignments/${assignmentId}/submissions?per_page=100&include[]=user&include[]=submission_comments`);
}

async function getSubmissionText(courseId, assignmentId, userId) {
  return canvasGet(`/courses/${courseId}/assignments/${assignmentId}/submissions/${userId}?include[]=submission_history`);
}

async function getAnnouncements(courseId) {
  return canvasGet(`/courses/${courseId}/discussion_topics?only_announcements=true&per_page=20`);
}

async function getModules(courseId) {
  return canvasGet(`/courses/${courseId}/modules?per_page=50`);
}

async function getModuleItems(courseId, moduleId) {
  return canvasGet(`/courses/${courseId}/modules/${moduleId}/items?per_page=50`);
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
};
