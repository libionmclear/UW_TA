const readline = require('readline');
const canvas = require('./canvas-client');
const { analyzeText, stripHtml } = require('./ai-detector');
const { DEFAULT_COURSE_ID } = require('./config');

let activeCourseId = DEFAULT_COURSE_ID;
let activeCourseName = '';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function prompt(question) {
  return new Promise((resolve) => rl.question(question, resolve));
}

function printHeader(title) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  ${title}`);
  console.log(`${'='.repeat(60)}`);
}

function printDivider() {
  console.log(`${'─'.repeat(60)}`);
}

async function showMenu() {
  printHeader(`TA Companion — ${activeCourseName || 'Loading...'}`);
  console.log(`  Course ID: ${activeCourseId}\n`);
  console.log('  1) List Students');
  console.log('  2) List Assignments');
  console.log('  3) Check Submissions for AI Use');
  console.log('  4) Analyze Single Submission');
  console.log('  5) Switch Course');
  console.log('  6) Course Overview');
  console.log('  0) Exit');
  printDivider();
  return prompt('\n> Choose an option: ');
}

async function loadCourseName() {
  try {
    const course = await canvas.getCourse(activeCourseId);
    activeCourseName = course.name || `Course ${activeCourseId}`;
  } catch {
    activeCourseName = `Course ${activeCourseId}`;
  }
}

async function listStudents() {
  printHeader('Enrolled Students');
  const enrollments = await canvas.getStudents(activeCourseId);
  if (enrollments.length === 0) {
    console.log('  No students found.');
    return;
  }
  enrollments.sort((a, b) => (a.user.sortable_name || '').localeCompare(b.user.sortable_name || ''));
  enrollments.forEach((e, i) => {
    const name = e.user.name || 'Unknown';
    const login = e.user.login_id || '';
    console.log(`  ${String(i + 1).padStart(3)}. ${name}  (${login})`);
  });
  console.log(`\n  Total: ${enrollments.length} students`);
}

async function listAssignments() {
  printHeader('Assignments');
  const assignments = await canvas.getAssignments(activeCourseId);
  if (assignments.length === 0) {
    console.log('  No assignments found.');
    return;
  }
  assignments.forEach((a, i) => {
    const due = a.due_at ? new Date(a.due_at).toLocaleDateString() : 'No due date';
    const pts = a.points_possible != null ? `${a.points_possible} pts` : '';
    const types = a.submission_types ? a.submission_types.join(', ') : '';
    console.log(`  ${String(i + 1).padStart(3)}. [${a.id}] ${a.name}`);
    console.log(`       Due: ${due}  |  ${pts}  |  Type: ${types}`);
  });
  return assignments;
}

async function checkSubmissionsForAI() {
  console.log('\n  Loading assignments...');
  const assignments = await canvas.getAssignments(activeCourseId);

  // Filter to text-based assignments
  const textAssignments = assignments.filter((a) =>
    a.submission_types && a.submission_types.some((t) => ['online_text_entry', 'online_upload'].includes(t))
  );

  if (textAssignments.length === 0) {
    console.log('  No text-based assignments found.');
    return;
  }

  console.log('\n  Text-based assignments:');
  textAssignments.forEach((a, i) => {
    const due = a.due_at ? new Date(a.due_at).toLocaleDateString() : 'No due date';
    console.log(`  ${String(i + 1).padStart(3)}. [${a.id}] ${a.name} — Due: ${due}`);
  });

  const choice = await prompt('\n> Enter assignment number to scan: ');
  const idx = parseInt(choice, 10) - 1;
  if (isNaN(idx) || idx < 0 || idx >= textAssignments.length) {
    console.log('  Invalid selection.');
    return;
  }

  const assignment = textAssignments[idx];
  printHeader(`AI Analysis: ${assignment.name}`);

  console.log('  Fetching submissions...');
  const submissions = await canvas.getSubmissions(activeCourseId, assignment.id);

  const submitted = submissions.filter((s) => s.workflow_state !== 'unsubmitted' && s.body);

  if (submitted.length === 0) {
    console.log('  No text submissions found for this assignment.');
    console.log('  (Students may have uploaded files instead of inline text.)');
    return;
  }

  console.log(`  Analyzing ${submitted.length} submissions...\n`);

  const results = [];
  for (const sub of submitted) {
    const name = sub.user ? sub.user.name : `User ${sub.user_id}`;
    const analysis = analyzeText(sub.body);
    results.push({ name, analysis, sub });
  }

  // Sort by score descending (most suspicious first)
  results.sort((a, b) => b.analysis.score - a.analysis.score);

  for (const r of results) {
    const flag = r.analysis.level === 'HIGH' ? '🔴' : r.analysis.level === 'MEDIUM' ? '🟡' : r.analysis.level === 'LOW' ? '🟢' : '⚪';
    console.log(`  ${flag} ${r.name}`);
    console.log(`     Score: ${r.analysis.score}/${r.analysis.maxScore} (${r.analysis.level}) — ${r.analysis.wordCount} words`);
    console.log(`     ${r.analysis.message}`);
    if (r.analysis.details.aiPhrases && r.analysis.details.aiPhrases.matched.length > 0) {
      console.log(`     Flagged phrases: ${r.analysis.details.aiPhrases.matched.slice(0, 5).join(', ')}`);
    }
    printDivider();
  }

  const highCount = results.filter((r) => r.analysis.level === 'HIGH').length;
  const medCount = results.filter((r) => r.analysis.level === 'MEDIUM').length;
  console.log(`\n  Summary: ${highCount} HIGH, ${medCount} MEDIUM out of ${results.length} submissions`);
}

async function analyzeSingleSubmission() {
  console.log('\n  Loading assignments...');
  const assignments = await canvas.getAssignments(activeCourseId);
  const textAssignments = assignments.filter((a) =>
    a.submission_types && a.submission_types.some((t) => ['online_text_entry', 'online_upload'].includes(t))
  );

  if (textAssignments.length === 0) {
    console.log('  No text-based assignments found.');
    return;
  }

  textAssignments.forEach((a, i) => {
    console.log(`  ${String(i + 1).padStart(3)}. [${a.id}] ${a.name}`);
  });

  const aChoice = await prompt('\n> Assignment number: ');
  const aIdx = parseInt(aChoice, 10) - 1;
  if (isNaN(aIdx) || aIdx < 0 || aIdx >= textAssignments.length) {
    console.log('  Invalid selection.');
    return;
  }

  const assignment = textAssignments[aIdx];
  console.log('  Fetching submissions...');
  const submissions = await canvas.getSubmissions(activeCourseId, assignment.id);
  const submitted = submissions.filter((s) => s.workflow_state !== 'unsubmitted' && s.body);

  if (submitted.length === 0) {
    console.log('  No text submissions found.');
    return;
  }

  submitted.forEach((s, i) => {
    const name = s.user ? s.user.name : `User ${s.user_id}`;
    console.log(`  ${String(i + 1).padStart(3)}. ${name}`);
  });

  const sChoice = await prompt('\n> Student number: ');
  const sIdx = parseInt(sChoice, 10) - 1;
  if (isNaN(sIdx) || sIdx < 0 || sIdx >= submitted.length) {
    console.log('  Invalid selection.');
    return;
  }

  const sub = submitted[sIdx];
  const name = sub.user ? sub.user.name : `User ${sub.user_id}`;
  const text = stripHtml(sub.body);

  printHeader(`Detailed Analysis: ${name}`);
  console.log(`\n  --- Submission Preview (first 500 chars) ---`);
  console.log(`  ${text.substring(0, 500)}${text.length > 500 ? '...' : ''}`);
  console.log();

  const analysis = analyzeText(sub.body);

  console.log(`  Overall Score: ${analysis.score}/${analysis.maxScore} — ${analysis.level}`);
  console.log(`  ${analysis.message}`);
  console.log(`  Word Count: ${analysis.wordCount}\n`);

  const d = analysis.details;
  if (d.aiPhrases) {
    console.log(`  AI Phrases: ${d.aiPhrases.hits} hits (${d.aiPhrases.normalizedPer500}/500 words) [${d.aiPhrases.points} pts]`);
    if (d.aiPhrases.matched.length > 0) {
      console.log(`    Matched: ${d.aiPhrases.matched.join(', ')}`);
    }
  }
  if (d.sentenceUniformity) {
    console.log(`  Sentence Uniformity: CV=${d.sentenceUniformity.cv} (avg ${d.sentenceUniformity.avg} words/sent) [${d.sentenceUniformity.points} pts]`);
  }
  if (d.vocabularyDiversity) {
    console.log(`  Vocab Diversity: TTR=${d.vocabularyDiversity.ttr} (${d.vocabularyDiversity.uniqueWords}/${d.vocabularyDiversity.wordCount} unique) [${d.vocabularyDiversity.points} pts]`);
  }
  if (d.paragraphUniformity) {
    console.log(`  Paragraph Uniformity: CV=${d.paragraphUniformity.cv} (${d.paragraphUniformity.paragraphs} paragraphs) [${d.paragraphUniformity.points} pts]`);
  }
}

async function switchCourse() {
  printHeader('Switch Course');
  console.log('  Fetching your courses...\n');
  const courses = await canvas.getCourses();
  courses.forEach((c, i) => {
    const active = c.id == activeCourseId ? ' ◀ CURRENT' : '';
    console.log(`  ${String(i + 1).padStart(3)}. [${c.id}] ${c.name}${active}`);
  });

  const choice = await prompt('\n> Enter course number: ');
  const idx = parseInt(choice, 10) - 1;
  if (isNaN(idx) || idx < 0 || idx >= courses.length) {
    console.log('  Invalid selection.');
    return;
  }

  activeCourseId = courses[idx].id;
  activeCourseName = courses[idx].name;
  console.log(`\n  Switched to: ${activeCourseName}`);
}

async function courseOverview() {
  printHeader(`Overview: ${activeCourseName}`);

  const [students, assignments] = await Promise.all([
    canvas.getStudents(activeCourseId),
    canvas.getAssignments(activeCourseId),
  ]);

  console.log(`\n  Students enrolled: ${students.length}`);
  console.log(`  Total assignments: ${assignments.length}`);

  const upcoming = assignments
    .filter((a) => a.due_at && new Date(a.due_at) > new Date())
    .sort((a, b) => new Date(a.due_at) - new Date(b.due_at));

  const past = assignments
    .filter((a) => a.due_at && new Date(a.due_at) <= new Date())
    .sort((a, b) => new Date(b.due_at) - new Date(a.due_at));

  if (upcoming.length > 0) {
    console.log(`\n  Upcoming assignments:`);
    upcoming.slice(0, 5).forEach((a) => {
      console.log(`    • ${a.name} — Due: ${new Date(a.due_at).toLocaleDateString()}`);
    });
  }

  if (past.length > 0) {
    console.log(`\n  Recent past assignments:`);
    past.slice(0, 5).forEach((a) => {
      console.log(`    • ${a.name} — Was due: ${new Date(a.due_at).toLocaleDateString()}`);
    });
  }
}

async function main() {
  console.log('\n  Starting TA Companion...');
  await loadCourseName();

  let running = true;
  while (running) {
    try {
      const choice = await showMenu();
      switch (choice.trim()) {
        case '1': await listStudents(); break;
        case '2': await listAssignments(); break;
        case '3': await checkSubmissionsForAI(); break;
        case '4': await analyzeSingleSubmission(); break;
        case '5': await switchCourse(); break;
        case '6': await courseOverview(); break;
        case '0':
          console.log('\n  Goodbye!\n');
          running = false;
          break;
        default:
          console.log('  Invalid option. Try again.');
      }
    } catch (err) {
      console.error(`\n  Error: ${err.message}\n`);
    }

    if (running) {
      await prompt('\n  Press Enter to continue...');
    }
  }

  rl.close();
}

main();
