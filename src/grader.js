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

// ── Parse raw text into structured quiz questions ─────────────────────────────
async function parseQuestionsFromText(rawText) {
  const prompt = `You are a quiz question extractor. Given raw text that may contain multiple-choice, true/false, short-answer, or essay questions (possibly messy formatting from textbook test banks), extract EVERY question and return a JSON array.

The source text may use "Feedback:" or "Explanation:" for the explanation of the correct answer.
The source text may use "Difficulty: 1 Easy", "Difficulty: 2 Medium", "Difficulty: 3 Hard" or similar for difficulty level.
The source text may include metadata like AACSB, Blooms, Topic — extract Topic if present.

Each object MUST have ALL of these fields:
- "question": string (the question text, cleaned up)
- "choices": array of strings (e.g. ["A. True", "B. False"] or ["A. choice1", "B. choice2"] — empty array if no choices or essay)
- "answer": string (the correct answer: for T/F use "True" or "False", for MC use the letter like "B", for essay/short answer use the answer text, empty string if not identified)
- "explanation": string (the Feedback/Explanation text that explains WHY the answer is correct — copy the full feedback text, do NOT leave empty if the source has a Feedback line)
- "difficulty": string (one of "easy", "medium", "hard" — extract from the source text "Difficulty:" line, otherwise infer from question complexity)
- "questionType": string (one of "multiple_choice", "true_false", "short_answer", "essay" — infer from the question format)
- "topic": string (the Topic from the source metadata if present, otherwise empty string)

CRITICAL: Do NOT skip the "explanation" field. If the source has a "Feedback:" line after the answer, that IS the explanation — include it in full.

IMPORTANT: Escape all double quotes inside string values with backslash (e.g. \"word\"). Return ONLY a valid JSON array — no explanation, no markdown fences.

RAW TEXT:
${rawText.slice(0, 120000)}`;

  const msg = await client().messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 16384,
    messages: [{ role: 'user', content: prompt }],
  });
  const content = msg.content[0].text.trim();
  // Extract JSON array from response
  const match = content.match(/\[[\s\S]*\]/);
  if (!match) throw new Error('Claude did not return a valid JSON array');
  let jsonStr = match[0];
  try {
    return JSON.parse(jsonStr);
  } catch (e) {
    // Fix common JSON issues: unescaped quotes inside string values
    // Replace smart quotes with escaped regular quotes
    jsonStr = jsonStr.replace(/[\u201C\u201D\u201E\u201F\u2033\u2036]/g, '\\"');
    jsonStr = jsonStr.replace(/[\u2018\u2019\u201A\u201B\u2032\u2035]/g, "\\'");
    // Fix unescaped double quotes inside JSON string values by re-serializing
    // Strategy: extract each value between known keys and re-escape
    try {
      return JSON.parse(jsonStr);
    } catch {
      // Last resort: use a more lenient repair approach
      // Fix unescaped quotes inside string values (between ": " and the next ",\n or "\n})
      jsonStr = match[0].replace(
        /("(?:question|explanation|answer|topic)":\s*")([\s\S]*?)("(?:,\s*\n|\s*\n\s*["\}]))/g,
        (m, prefix, val, suffix) => prefix + val.replace(/(?<!\\)"/g, '\\"') + suffix
      );
      try {
        return JSON.parse(jsonStr);
      } catch {
        throw new Error(e.message);
      }
    }
  }
}

module.exports = { gradeSubmission, generateRubric, suggestQuizQuestions, parseQuestionsFromText };
