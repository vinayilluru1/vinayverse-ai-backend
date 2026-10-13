
'use strict';

const DEFAULT_BASE_URL =
  'https://generativelanguage.googleapis.com/v1beta/openai/';
const DEFAULT_MODEL = 'gemini-2.5-flash';
const DEFAULT_TIMEOUT_MS = 50000;

const COACH_SYSTEM_PROMPT = `You are VINAYVERSE Coach, a friendly fitness and nutrition coach.
Give practical, safe, concise fitness and nutrition advice.
Treat calorie and nutrition values as estimates.
Never diagnose medical conditions or recommend dangerous diets.
Be encouraging, clear, and concise.`;

const FOOD_SYSTEM_PROMPT = `Identify foods visible in the meal photo.
Return a strict JSON array only. Each item must contain:
"name": string,
"grams": number,
"kcal": number,
"protein": number,
"carbs": number,
"fat": number,
"meal": "breakfast", "lunch", "dinner", or "snack".
Nutrition and weight estimates are approximate.
Return [] if no food can be identified.
Do not invent foods that are not visible.`;

class UpstreamError extends Error {
  constructor(code, httpStatus) {
    super(code);
    this.name = 'UpstreamError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

function isMock(env) {
  return env.AI_MOCK === '1';
}

function getTimeout(env) {
  const value = Number.parseInt(env.AI_TIMEOUT_MS || '', 10);
  return Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_TIMEOUT_MS;
}

function compactJson(value, maxLen = 2500) {
  if (value == null) return 'none provided';

  try {
    const result = JSON.stringify(value);
    return result.length > maxLen
      ? result.slice(0, maxLen) + '...(truncated)'
      : result;
  } catch {
    return 'unavailable';
  }
}

async function postChatCompletions(
  env,
  { model, messages, maxTokens, temperature }
) {
  if (isMock(env)) return { __mock: true };

  const key = env.AI_API_KEY;
  if (!key) {
    throw new UpstreamError('PROVIDER_NOT_CONFIGURED', 503);
  }

  const base = (
    env.AI_BASE_URL || DEFAULT_BASE_URL
  ).replace(/\/+$/, '');

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    getTimeout(env)
  );

  let response;

  try {
    response = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`
      },
      body: JSON.stringify({
        model: model || DEFAULT_MODEL,
        messages,
        max_tokens: maxTokens,
        temperature
      }),
      signal: controller.signal
    });
  } catch (error) {
    if (error && error.name === 'AbortError') {
      throw new UpstreamError('UPSTREAM_TIMEOUT', 504);
    }

    console.error('[AI provider] Request failed.');
    throw new UpstreamError('UPSTREAM_UNREACHABLE', 502);
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    let providerCode = 'unknown';

    try {
      const body = await response.json();
      const code = body?.error?.code || body?.error?.type;

      if (typeof code === 'string') {
        providerCode = code
          .replace(/[^a-zA-Z0-9_-]/g, '')
          .slice(0, 80) || 'unknown';
      }
    } catch {
      // Do not log API keys or provider response bodies.
    }

    console.error(
      `[AI provider] HTTP ${response.status}; code=${providerCode}`
    );

    throw new UpstreamError('UPSTREAM_ERROR', 502);
  }

  try {
    return await response.json();
  } catch {
    throw new UpstreamError('UPSTREAM_INVALID_RESPONSE', 502);
  }
}

function getText(data) {
  const content = data?.choices?.[0]?.message?.content;

  if (typeof content === 'string') {
    return content.trim();
  }

  // Some compatible APIs may return content as text blocks.
  if (Array.isArray(content)) {
    return content
      .filter(part => part && part.type === 'text')
      .map(part => part.text || '')
      .join('\n')
      .trim();
  }

  return '';
}

async function coachAnswer({ question, profile, todayData }, env) {
  if (isMock(env)) {
    return {
      answer: 'Mock response only. Configure Google AI Studio for real AI.',
      mock: true
    };
  }

  if (typeof question !== 'string' || !question.trim()) {
    throw new UpstreamError('INVALID_QUESTION', 400);
  }

  const data = await postChatCompletions(env, {
    model: env.AI_MODEL || DEFAULT_MODEL,
    messages: [
      { role: 'system', content: COACH_SYSTEM_PROMPT },
      {
        role: 'user',
        content:
          `Question: ${question.trim().slice(0, 4000)}\n` +
          `Profile: ${compactJson(profile)}\n` +
          `Today's data: ${compactJson(todayData)}`
      }
    ],
    maxTokens: 600,
    temperature: 0.6
  });

  const answer = getText(data);

  if (!answer) {
    throw new UpstreamError('UPSTREAM_EMPTY', 502);
  }

  return { answer };
}

function validNumber(value) {
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0;
}

function sanitizeFoodItems(items) {
  if (!Array.isArray(items)) {
    throw new UpstreamError('UPSTREAM_BAD_SHAPE', 502);
  }

  const allowedMeals = [
    'breakfast',
    'lunch',
    'dinner',
    'snack'
  ];

  return items.slice(0, 15).map(item => {
    if (!item || typeof item !== 'object') {
      throw new UpstreamError('UPSTREAM_BAD_SHAPE', 502);
    }

    const name = typeof item.name === 'string'
      ? item.name.trim().slice(0, 100)
      : '';

    if (
      !name ||
      !validNumber(item.grams) ||
      !validNumber(item.kcal)
    ) {
      throw new UpstreamError('UPSTREAM_BAD_SHAPE', 502);
    }

    return {
      name,
      grams: item.grams,
      kcal: item.kcal,
      protein: validNumber(item.protein) ? item.protein : 0,
      carbs: validNumber(item.carbs) ? item.carbs : 0,
      fat: validNumber(item.fat) ? item.fat : 0,
      meal: allowedMeals.includes(item.meal)
        ? item.meal
        : 'snack'
    };
  });
}

function extractJsonArray(text) {
  const cleaned = text.trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');

  const parsed = JSON.parse(cleaned);

  if (!Array.isArray(parsed)) {
    throw new Error('Expected a JSON array');
  }

  return parsed;
}

async function analyzeFoodImage(buffer, mimetype, env) {
  if (isMock(env)) {
    return [{
      name: 'Mock food (test data)',
      grams: 100,
      kcal: 150,
      protein: 5,
      carbs: 20,
      fat: 4,
      meal: 'snack',
      mock: true
    }];
  }

  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new UpstreamError('INVALID_IMAGE', 400);
  }

  const allowedTypes = [
    'image/jpeg',
    'image/png',
    'image/webp'
  ];

  if (!allowedTypes.includes(mimetype)) {
    throw new UpstreamError('UNSUPPORTED_IMAGE_TYPE', 415);
  }

  const dataUrl =
    `data:${mimetype};base64,${buffer.toString('base64')}`;

  const data = await postChatCompletions(env, {
    model: env.AI_VISION_MODEL || DEFAULT_MODEL,
    messages: [
      { role: 'system', content: FOOD_SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'Identify the visible foods and estimate nutrition. Return JSON only.'
          },
          {
            type: 'image_url',
            image_url: { url: dataUrl }
          }
        ]
      }
    ],
    maxTokens: 800,
    temperature: 0.2
  });

  const result = getText(data);

  if (!result) {
    throw new UpstreamError('UPSTREAM_EMPTY', 502);
  }

  let items;

  try {
    items = extractJsonArray(result);
  } catch {
    throw new UpstreamError('UPSTREAM_BAD_SHAPE', 502);
  }

  return sanitizeFoodItems(items);
}

module.exports = {
  coachAnswer,
  analyzeFoodImage,
  sanitizeFoodItems,
  isMock,
  UpstreamError,
  COACH_SYSTEM_PROMPT,
  FOOD_SYSTEM_PROMPT
};
