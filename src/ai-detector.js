/**
 * Heuristic-based AI writing detection.
 *
 * Analyzes text for patterns commonly found in AI-generated content.
 * This is NOT definitive — treat results as flags for manual review.
 */

// Phrases that appear disproportionately in AI-generated text
const AI_PHRASES = [
  'it is important to note',
  'it\'s important to note',
  'it is worth noting',
  'it\'s worth noting',
  'in today\'s rapidly',
  'in today\'s fast-paced',
  'in conclusion',
  'in summary',
  'first and foremost',
  'stands as a testament',
  'a testament to',
  'serves as a reminder',
  'it is crucial to',
  'it\'s crucial to',
  'plays a crucial role',
  'plays a pivotal role',
  'a pivotal role in',
  'landscape',
  'delve',
  'delving',
  'multifaceted',
  'nuanced',
  'comprehensive',
  'holistic approach',
  'paradigm shift',
  'navigate the complexities',
  'leverage',
  'foster',
  'underscores',
  'realm',
  'tapestry',
  'utilize',
  'utilizing',
  'moreover',
  'furthermore',
  'nevertheless',
  'harnessing',
  'harness the power',
  'in the realm of',
  'game-changer',
  'robust',
  'seamless',
  'seamlessly',
  'cutting-edge',
  'groundbreaking',
  'innovative solutions',
  'transformative',
  'at its core',
  'elevate',
  'embark on',
  'not only.*but also',
  'this ensures that',
  'by doing so',
  'to that end',
  'in this context',
];

function stripHtml(html) {
  if (!html) return '';
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function getSentences(text) {
  return text
    .split(/[.!?]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 10);
}

function getWords(text) {
  return text.toLowerCase().match(/\b[a-z']+\b/g) || [];
}

/**
 * 1. AI Phrase Score — counts matches against known AI-heavy phrases
 */
function phraseScore(text) {
  const lower = text.toLowerCase();
  let hits = 0;
  const matched = [];
  for (const phrase of AI_PHRASES) {
    const regex = new RegExp(phrase, 'gi');
    const matches = lower.match(regex);
    if (matches) {
      hits += matches.length;
      matched.push(phrase);
    }
  }
  return { hits, matched };
}

/**
 * 2. Sentence Length Uniformity — AI text has low variance in sentence length
 */
function sentenceUniformity(text) {
  const sentences = getSentences(text);
  if (sentences.length < 3) return { score: 0, avg: 0, stddev: 0 };

  const lengths = sentences.map((s) => getWords(s).length);
  const avg = lengths.reduce((a, b) => a + b, 0) / lengths.length;
  const variance = lengths.reduce((sum, l) => sum + (l - avg) ** 2, 0) / lengths.length;
  const stddev = Math.sqrt(variance);
  const cv = avg > 0 ? stddev / avg : 0; // coefficient of variation

  // Low CV = more uniform = more likely AI
  // Human writing typically CV > 0.4, AI tends to be < 0.3
  const score = cv < 0.25 ? 3 : cv < 0.35 ? 2 : cv < 0.45 ? 1 : 0;
  return { score, avg: avg.toFixed(1), stddev: stddev.toFixed(1), cv: cv.toFixed(2) };
}

/**
 * 3. Vocabulary Diversity — type-token ratio
 */
function vocabDiversity(text) {
  const words = getWords(text);
  if (words.length < 50) return { score: 0, ttr: 0 };
  const unique = new Set(words);
  const ttr = unique.size / words.length;

  // AI text often has lower diversity (more repetitive vocabulary patterns)
  // But can also be artificially diverse. Low TTR with many AI phrases = flag.
  const score = ttr < 0.35 ? 2 : ttr < 0.45 ? 1 : 0;
  return { score, ttr: ttr.toFixed(3), wordCount: words.length, uniqueWords: unique.size };
}

/**
 * 4. Paragraph Structure — AI tends to write very even paragraph lengths
 */
function paragraphUniformity(text) {
  const paragraphs = text.split(/\n\s*\n/).filter((p) => p.trim().length > 20);
  if (paragraphs.length < 3) return { score: 0 };

  const lengths = paragraphs.map((p) => getWords(p).length);
  const avg = lengths.reduce((a, b) => a + b, 0) / lengths.length;
  const variance = lengths.reduce((sum, l) => sum + (l - avg) ** 2, 0) / lengths.length;
  const stddev = Math.sqrt(variance);
  const cv = avg > 0 ? stddev / avg : 0;

  const score = cv < 0.2 ? 2 : cv < 0.35 ? 1 : 0;
  return { score, paragraphs: paragraphs.length, cv: cv.toFixed(2) };
}

/**
 * Main analysis function
 */
function analyzeText(rawText) {
  const text = stripHtml(rawText);
  const words = getWords(text);

  if (words.length < 30) {
    return {
      score: 0,
      pct: 0,
      maxScore: 10,
      level: 'TOO SHORT',
      message: 'Text too short for meaningful analysis (< 30 words)',
      wordCount: words.length,
      details: {},
    };
  }

  const phrases = phraseScore(text);
  const sentUnif = sentenceUniformity(text);
  const vocab = vocabDiversity(text);
  const paraUnif = paragraphUniformity(text);

  // Normalize phrase hits relative to text length (per 500 words)
  const normalizedPhraseHits = (phrases.hits / words.length) * 500;
  const phrasePoints = normalizedPhraseHits > 8 ? 3 : normalizedPhraseHits > 4 ? 2 : normalizedPhraseHits > 2 ? 1 : 0;

  const totalScore = phrasePoints + sentUnif.score + vocab.score + paraUnif.score;
  const maxScore = 10;

  // Scale to 1-100 percentage with finer granularity
  // Use weighted continuous scoring for smoother distribution
  let pctRaw = 0;
  // Phrase contribution (0-30): based on normalized hits
  pctRaw += Math.min(30, normalizedPhraseHits * 3);
  // Sentence uniformity (0-25): based on coefficient of variation
  const sentCv = sentUnif.cv != null ? parseFloat(sentUnif.cv) : 1;
  pctRaw += Math.max(0, 25 * (1 - sentCv / 0.5));
  // Vocabulary diversity (0-20): based on TTR
  const ttr = vocab.ttr ? parseFloat(vocab.ttr) : 0.6;
  pctRaw += Math.max(0, 20 * (1 - ttr / 0.55));
  // Paragraph uniformity (0-25): based on CV
  const paraCv = paraUnif.cv != null ? parseFloat(paraUnif.cv) : 1;
  pctRaw += Math.max(0, 25 * (1 - paraCv / 0.4));

  const pct = Math.max(1, Math.min(100, Math.round(pctRaw)));

  let level;
  if (pct >= 80) level = 'HIGH';
  else if (pct >= 50) level = 'MEDIUM';
  else if (pct >= 25) level = 'LOW';
  else level = 'MINIMAL';

  return {
    score: totalScore,
    pct,
    maxScore,
    level,
    message: getLevelMessage(level),
    wordCount: words.length,
    details: {
      aiPhrases: { points: phrasePoints, hits: phrases.hits, normalizedPer500: normalizedPhraseHits.toFixed(1), matched: phrases.matched.slice(0, 10) },
      sentenceUniformity: { points: sentUnif.score, ...sentUnif },
      vocabularyDiversity: { points: vocab.score, ...vocab },
      paragraphUniformity: { points: paraUnif.score, ...paraUnif },
    },
  };
}

function getLevelMessage(level) {
  switch (level) {
    case 'HIGH':
      return 'Strong indicators of AI-generated text. Recommend manual review.';
    case 'MEDIUM':
      return 'Moderate indicators. Some patterns consistent with AI writing. Worth reviewing.';
    case 'LOW':
      return 'Few indicators. Likely human-written with possible minor AI assistance.';
    case 'MINIMAL':
      return 'No significant AI indicators detected.';
    default:
      return '';
  }
}

module.exports = { analyzeText, stripHtml };
