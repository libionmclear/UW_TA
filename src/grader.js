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

// ── Grade a single submission against a rubric ────────────────────────────────
async function gradeSubmission(submissionText, rubric, studentName, aiInstructions = '') {
  const criteriaLines = rubric.criteria
    .map(c =>
      `  - id="${c.id}" | "${c.name}" | 0–${c.maxPoints} pts` +
      (c.autoGrant ? ' | AUTO-GRANT full points (student submitted)' : '') +
      `\n    Description: ${c.description}`
    )
    .join('\n');

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

CASE WRITE-UP STRUCTURE GUIDANCE (apply when the submission is a case write-up or business analysis):
When grading written cases or business analyses, evaluate whether the student has included:
1. Executive Summary — concise overview with clear, actionable RECOMMENDATIONS upfront
2. Supporting Points — evidence, data, and analysis that back up the recommendations
3. Conclusion / Alternatives / Other Thoughts — wrap-up, discussion of alternatives considered, or additional insights

Penalize submissions that lack a clear recommendation, bury the conclusion, or fail to support arguments with evidence.

STUDENT SUBMISSION (first 6000 chars):
---
${text.substring(0, 6000)}${text.length > 6000 ? '\n[...truncated]' : ''}
---

INSTRUCTIONS:
1. Grade EACH criterion independently using its full 0–max range
2. Auto-grant criteria should receive their full points automatically
3. For each criterion provide a 1–2 sentence justification referencing the actual submission
4. Estimate AI writing confidence (0–100): how likely is this AI-generated WITHOUT human disclosure?
   Signals: generic phrasing, overly polished prose, no personal voice, suspiciously comprehensive coverage, LLM hedging phrases
5. List up to 3 specific AI signals if confidence ≥ 60
6. Write 2–3 sentences of overall feedback

Respond ONLY with valid JSON (no markdown, no explanation):
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

// ── Generate a rubric from an assignment description ──────────────────────────
async function generateRubric(description, totalPoints = 15) {
  const prompt = `You are an expert course designer and teaching assistant creating a grading rubric for a marketing course assignment.

ASSIGNMENT DESCRIPTION:
${description}

TOTAL POINTS: ${totalPoints}

Design a rubric. If this is a case write-up or business analysis assignment, include criteria for:
  - Executive Summary & Recommendations (clear, actionable recommendations upfront)
  - Supporting Analysis & Evidence (data, research, reasoning that backs the recommendations)
  - Conclusion / Alternatives / Other Thoughts (wrap-up, alternatives considered, additional insights)

Otherwise design 3–5 substantive criteria covering core learning objectives.

Always include:
- One "Submission" criterion (auto-granted, 5 pts) for simply turning it in
- Clear, measurable descriptions of what earns full points
- A list of 3–5 clarifying questions to ask the professor before grading

Respond ONLY with valid JSON:
{
  "name": "Short assignment name",
  "totalPoints": ${totalPoints},
  "criteria": [
    {
      "id": "c1",
      "name": "Submission",
      "maxPoints": 5,
      "description": "Student submitted any work.",
      "autoGrant": true
    }
  ],
  "clarifyingQuestions": [
    "Question 1?",
    "Question 2?"
  ]
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

// ── Suggest quiz questions from a question bank ───────────────────────────────
async function suggestQuizQuestions(questionBank, topic, courseContent, count = 5) {
  const bankText = questionBank.length
    ? questionBank.map((q, i) => `Q${i + 1}: ${typeof q === 'string' ? q : q.question || JSON.stringify(q)}`).join('\n')
    : '(No question bank uploaded yet)';

  const contentSummary = courseContent
    ? `\nCOURSE CONTENT / VIDEOS COVERED:\n${String(courseContent).substring(0, 3000)}`
    : '';

  const prompt = `You are a teaching assistant helping a professor select quiz questions for a marketing course.

TOPIC / FOCUS: ${topic || 'General course review'}
${contentSummary}

AVAILABLE QUESTION BANK:
${bankText}

TASK:
1. Review the question bank above
2. Select the ${count} most appropriate questions for a quiz on this topic
3. If the bank has fewer than ${count} questions, suggest NEW questions in the same style to fill the gap
4. For each selected/suggested question, briefly explain why it's relevant to the topic

Respond ONLY with valid JSON:
{
  "selectedQuestions": [
    {
      "question": "...",
      "source": "bank" or "suggested",
      "originalIndex": 0,
      "rationale": "Why this question tests the topic..."
    }
  ],
  "notes": "Any overall notes about the quiz selection..."
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
