require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');

let _client = null;
function client() {
  if (!_client) {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set in .env');
    _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _client;
}

// ── Grade a single submission ─────────────────────────────────────────────────
async function gradeSubmission(submissionText, rubric, studentName, aiInstructions = '', isCaseWriteup = false) {
  const criteriaLines = rubric.criteria
    .map(c =>
      `  - id="${c.id}" | "${c.name}" | 0–${c.maxPoints} pts` +
      (c.autoGrant ? ' | AUTO-GRANT full points (student submitted)' : '') +
      `\n    Description: ${c.description}`
    ).join('\n');

  const criteriaJson = rubric.criteria
    .map(c => `    "${c.id}": { "score": ${c.autoGrant ? c.maxPoints : 0}, "justification": "..." }`)
    .join(',\n');

  const text = submissionText?.trim() || '(no submission text)';
  const customInstructions = aiInstructions?.trim()
    ? `\nSPECIFIC GRADING INSTRUCTIONS FOR THIS ASSIGNMENT:\n${aiInstructions.trim()}\n`
    : '';

  const prompt = `You are an expert teaching assistant grading a student submission for a marketing course. Be fair, specific, and constructive.

ASSIGNMENT: ${rubric.name || 'Student Assignment'} (${rubric.totalPoints} pts total)
STUDENT: ${studentName}
${customInstructions}
RUBRIC CRITERIA:
${criteriaLines}

${isCaseWriteup ? `CASE WRITE-UP STRUCTURE GUIDANCE:
Evaluate whether the student has included:
1. Executive Summary — concise overview with clear, actionable RECOMMENDATIONS upfront
2. Supporting Points — evidence, data, and analysis that back up the recommendations
3. Conclusion / Alternatives / Other Thoughts — wrap-up, alternatives considered, additional insights
Penalize submissions missing a clear recommendation, burying conclusions, or lacking evidence.

` : ''}STUDENT SUBMISSION (first 6000 chars):
---
${text.substring(0, 6000)}${text.length > 6000 ? '\n[...truncated]' : ''}
---

INSTRUCTIONS:
1. Grade EACH criterion independently using its full 0–max range
2. Auto-grant criteria receive full points automatically
3. Per criterion: 1–2 sentence justification referencing the actual submission
4. Estimate AI writing confidence (0–100)
5. List up to 3 AI signals if confidence ≥ 60
6. Write 2–3 sentences of overall feedback

Respond ONLY with valid JSON:
{
  "criteria": {
${criteriaJson}
  },
  "aiConfidence": 0,
  "aiSignals": [],
  "overallFeedback": "..."
}`;

  const resp = await client().messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 1200,
    messages: [{ role: 'user', content: prompt }],
  });

  const raw = resp.content[0].text;
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`Claude returned non-JSON: ${raw.substring(0, 200)}`);
  return JSON.parse(match[0]);
}

// ── Generate rubric ───────────────────────────────────────────────────────────
async function generateRubric(description, totalPoints = 15) {
  const prompt = `You are an expert course designer creating a grading rubric for a marketing course assignment.

ASSIGNMENT DESCRIPTION:
${description}

TOTAL POINTS: ${totalPoints}

If this is a case write-up or business analysis, include criteria for:
  - Executive Summary & Recommendations (clear, actionable recommendations upfront)
  - Supporting Analysis & Evidence (data, research, reasoning)
  - Conclusion / Alternatives / Other Thoughts

Always include:
- One "Submission" criterion (auto-granted, 5 pts) for turning it in
- Clear, measurable descriptions of what earns full points
- 3–5 clarifying questions for the professor

Respond ONLY with valid JSON:
{
  "name": "Short assignment name",
  "totalPoints": ${totalPoints},
  "criteria": [
    { "id": "c1", "name": "Submission", "maxPoints": 5, "description": "Student submitted any work.", "autoGrant": true }
  ],
  "clarifyingQuestions": ["Question 1?", "Question 2?"]
}`;

  const resp = await client().messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 1000,
    messages: [{ role: 'user', content: prompt }],
  });

  const raw = resp.content[0].text;
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`Claude returned non-JSON: ${raw.substring(0, 200)}`);
  return JSON.parse(match[0]);
}

// ── Suggest quiz questions ────────────────────────────────────────────────────
async function suggestQuizQuestions(questionBank, topic, courseContent, count = 5) {
  const bankText = questionBank.length
    ? questionBank.map((q, i) => `Q${i + 1}: ${typeof q === 'string' ? q : q.question || JSON.stringify(q)}`).join('\n')
    : '(No question bank uploaded yet)';

  const contentSummary = courseContent
    ? `\nCOURSE CONTENT / VIDEOS COVERED:\n${String(courseContent).substring(0, 3000)}`
    : '';

  const prompt = `You are a teaching assistant helping select quiz questions for a marketing course.

TOPIC / FOCUS: ${topic || 'General course review'}
${contentSummary}

AVAILABLE QUESTION BANK:
${bankText}

Select the ${count} most appropriate questions for a quiz on this topic.
If fewer than ${count} exist, suggest new questions in the same style.
For each, briefly explain why it's relevant.

Respond ONLY with valid JSON:
{
  "selectedQuestions": [
    { "question": "...", "source": "bank", "originalIndex": 0, "rationale": "..." }
  ],
  "notes": "..."
}`;

  const resp = await client().messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 2000,
    messages: [{ role: 'user', content: prompt }],
  });

  const raw = resp.content[0].text;
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`Claude returned non-JSON: ${raw.substring(0, 200)}`);
  return JSON.parse(match[0]);
}

module.exports = { gradeSubmission, generateRubric, suggestQuizQuestions };
