'use strict';

/**
 * AI provider layer — OpenAI-compatible Chat Completions over fetch.
 *
 * The provider API key is read ONLY from server env vars (AI_API_KEY) and is
 * never logged, never persisted, and never sent to any client.
 *
 * Set AI_MOCK=1 to run the test double: canned, obviously-fake responses
 * tagged with "mock": true. Mock mode is for automated tests and local
 * smoke-testing only — never deploy it as a real AI service.
 */

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_TIMEOUT_MS = 50000;

const COACH_SYSTEM_PROMPT = `You are VINAYVERSE Coach, a knowledgeable, encouraging fitness coach inside a fitness app.

Personalize your guidance using the user's profile and today's logged data when provided.

Rules you must always follow:
- Give practical, actionable fitness and nutrition guidance; treat calorie and macro numbers as estimates, not medical prescriptions.
- NEVER give medical diagnoses, never interpret symptoms, and never claim to replace a doctor or dietitian.
- NEVER recommend dangerous diets (crash diets, extreme fasting, purging), extreme training, or unsafe rapid weight-loss targets.
- If a question is outside fitness/nutrition or asks for anything unsafe, decline briefly and suggest a safe alternative or a professional.
- Keep answers concise (a short paragraph plus a few bullets at most), friendly, and in plain language.`;

const FOOD_SYSTEM_PROMPT = `You are a food-recognition assistant. Look at the meal photo and identify each distinct food item visible.

Respond with STRICT JSON ONLY — no prose, no markdown fences, no commentary. The response must be a JSON array where each element has exactly these fields:
- "name": string, short food name (e.g. "Cooked white rice")
- "grams": number, your best estimate of the visible serving weight in grams
- "kcal": number, estimated calories for that serving
- "protein": number, estimated protein in grams
- "carbs": number, estimated carbohydrates in grams
- "fat": number, estimated fat in grams
- "meal": string, one of "breakfast", "lunch", "dinner", "snack"

All estimates are approximate — a photo cannot give exact weights or exact nutrition. If you cannot identify any food, return an empty array [].`;

function isMock(env) {
  return env.AI_MOCK === '1';
}

function upstreamTimeoutMs(env) {
  const v = parseInt(env.AI_TIMEOUT_MS || '', 10);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_TIMEOUT_MS;
}

class UpstreamError extends Error {
  constructor(code, httpStatus) {
    super(code);
    this.code = code;
    this.httpStatus = httpStatus; // what WE return to the client
  }
}

/** Low-level POST to {base}/chat/completions. Throws UpstreamError on any failure. */
async function postChatCompletions(env, { model, messages, maxTokens, temperature }) {
  if (isMock(env)) return { __mock: true };

  const key = env.AI_API_KEY;
  if (!key) throw new UpstreamError('PROVIDER_NOT_CONFIGURED', 503);

  const base = (env.AI_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), upstreamTimeoutMs(env));

  let res;
  try {
    res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    // Never leak provider internals: classify, don't forward.
    if (err && err.name === 'AbortError') throw new UpstreamError('UPSTREAM_TIMEOUT', 504);
    throw new UpstreamError('UPSTREAM_UNREACHABLE', 502);
  }
  clearTimeout(timer);

  if (!res.ok) throw new UpstreamError('UPSTREAM_ERROR', 502);
  return res.json();
}

function chatText(data) {
  const t = data && data.choices && data.choices[0] && data.choices[0].message;
  const content = t && typeof t.content === 'string' ? t.content.trim() : '';
  return content;
}

/** Compact an object to a bounded JSON string for prompt context (never the raw key). */
function compactJson(value, maxLen) {
  if (value == null) return 'none provided';
  try {
    const s = JSON.stringify(value);
    return s.length > maxLen ? s.slice(0, maxLen) + '…(truncated)' : s;
  } catch {
    return 'unavailable';
  }
}

async function coachAnswer({ question, profile, todayData }, env) {
  if (isMock(env)) {
    return {
      answer:
        'This is a MOCK coach reply for testing only — no real AI was called. ' +
        `You asked about "${String(question).slice(0, 80)}". ` +
        'Configure AI_API_KEY on the server for genuine answers.',
      mock: true,
    };
  }
  const model = env.AI_MODEL || 'gpt-4o-mini';
  const userMsg =
    `User question: ${question}\n\n` +
    `User profile (JSON): ${compactJson(profile, 2500)}\n` +
    `Today's logged data (JSON): ${compactJson(todayData, 2500)}`;
  const data = await postChatCompletions(env, {
    model,
    messages: [
      { role: 'system', content: COACH_SYSTEM_PROMPT },
      { role: 'user', content: userMsg },
    ],
    maxTokens: 600,
    temperature: 0.6,
  });
  const answer = chatText(data);
  if (!answer) throw new UpstreamError('UPSTREAM_EMPTY', 502);
  return { answer };
}

function validNumber(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

/** Strictly validate the model's food list. Returns the cleaned array or throws. */
function sanitizeFoodItems(raw) {
  const list = Array.isArray(raw) ? raw : [raw];
  const out = [];
  for (const item of list.slice(0, 10)) {
    if (!item || typeof item !== 'object') throw new UpstreamError('UPSTREAM_BAD_SHAPE', 502);
    const name = typeof item.name === 'string' ? item.name.trim() : '';
    const grams = item.grams;
    const kcal = item.kcal;
    if (!name || !validNumber(grams) || !validNumber(kcal)) {
      throw new UpstreamError('UPSTREAM_BAD_SHAPE', 502);
    }
    out.push({
      name,
      grams,
      kcal,
      protein: validNumber(item.protein) ? item.protein : 0,
      carbs: validNumber(item.carbs) ? item.carbs : 0,
      fat: validNumber(item.fat) ? item.fat : 0,
      meal: typeof item.meal === 'string' && item.meal ? item.meal : 'snack',
    });
  }
  return out;
}

function extractJsonArray(text) {
  const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  return JSON.parse(t);
}

async function analyzeFoodImage(buffer, mimetype, env) {
  if (isMock(env)) {
    return [
      { name: 'Mock rice (test data)', grams: 150, kcal: 195, protein: 3.6, carbs: 42, fat: 0.4, meal: 'lunch', mock: true },
      { name: 'Mock dal (test data)', grams: 100, kcal: 115, protein: 7, carbs: 20, fat: 0.5, meal: 'lunch', mock: true },
    ];
  }
  const model = env.AI_VISION_MODEL || 'gpt-4o-mini';
  const dataUrl = `data:${mimetype};base64,${buffer.toString('base64')}`;
  const data = await postChatCompletions(env, {
    model,
    messages: [
      { role: 'system', content: FOOD_SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Identify the foods in this meal photo and estimate nutrition. Return STRICT JSON array only.' },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      },
    ],
    maxTokens: 800,
    temperature: 0.2,
  });
  const text = chatText(data);
  if (!text) throw new UpstreamError('UPSTREAM_EMPTY', 502);
  let parsed;
  try {
    parsed = extractJsonArray(text);
  } catch {
    throw new UpstreamError('UPSTREAM_BAD_SHAPE', 502);
  }
  return sanitizeFoodItems(parsed);
}

module.exports = {
  coachAnswer,
  analyzeFoodImage,
  sanitizeFoodItems,
  isMock,
  UpstreamError,
  COACH_SYSTEM_PROMPT,
  FOOD_SYSTEM_PROMPT,
};

