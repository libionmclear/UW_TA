require('dotenv').config();

const CANVAS_API_TOKEN = process.env.CANVAS_API_TOKEN;
const CANVAS_BASE_URL = process.env.CANVAS_BASE_URL;

if (!CANVAS_API_TOKEN || !CANVAS_BASE_URL) {
  console.error('Missing CANVAS_API_TOKEN or CANVAS_BASE_URL in .env file');
  process.exit(1);
}

module.exports = {
  CANVAS_API_TOKEN,
  CANVAS_BASE_URL,
  API_URL: `${CANVAS_BASE_URL}/api/v1`,
  DEFAULT_COURSE_ID: process.env.DEFAULT_COURSE_ID || '',
};
