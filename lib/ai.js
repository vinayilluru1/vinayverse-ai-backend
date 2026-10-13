'use strict';

/**
 * VINAYVERSE AI provider layer.
 * API keys are read only from server environment variables.
 * Never log API keys, images, or full provider responses.
 */

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_TIMEOUT_MS = 50000;

const COACH_SYSTEM_PROMPT = `You are VINAYVERSE Coach, a knowledgeable, encouraging fitness coach inside a fitness app.

Personalize your guidance using the user's profile and today's logged data when provided.

Rules:
- Give practical fitness and nutrition guidance.
- Treat calorie and macro numbers as estimates.
- Never diagnose medical conditions.
- Never recommend dangerous diets or extreme training.
- For medical concerns, suggest a qualified professional.
- Keep answers concise, friendly, and easy to understand.`;

const FOOD_SYSTEM_PROMPT = `You are a food-recognition assistant.
Identify each distinct food item visible in the meal photo.

Return STRICT JSON ONLY: a JSON array. Each item must contain:
"name": string,
"grams": number,
"kcal": number,
"protein": number,
"carbs": number,
"fat": number,
"meal": one of "breakfast", "lunch", "dinner", "snack".

Nutrition and weight are estimates only.
If no food can be identified, return [].`;

function isMock(env) {
  return env.AI_MOCK === '1';
}

function upstreamTimeoutMs(env) {
  const value = parseInt(env.AI_TIMEOUT_MS || '', 10);
  return Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_TIMEOUT_MS;
}

class UpstreamError extends Error {
  constructor(code, httpStatus) {
    super(code);
    this.name = 'UpstreamError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

/**
 * Send a request to the OpenAI Chat Completions API.
 * Log only a sanitized error code and HTTP status on failure.
 */
async function postChatCompletions(
  env,
  { model, messages, maxTokens, temperature }
) {
  if (isMock(env)) {
    return { __mock: true };
  }

  const key = env.AI_API_KEY;

  if (!key) {
    throw new UpstreamError('PROVIDER_NOT_CONFIGURED', 503);
  }

  const base = (env.AI_BASE_URL || DEFAULT_BASE_URL)
    .replace(/\/+$/, '');

  const controller = new AbortController();

  const timer = setTimeout(
    () => controller.abort(),
    upstreamTimeoutMs(env)
  );

  let response;

  try {
    response = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: maxTokens,
        temperature,
      }),
      signal: controller.signal,
    });
  } catch (error) {
    if (error && error.name === 'AbortError') {
      throw new UpstreamError('UPSTREAM_TIMEOUT', 504);
    }

    throw new UpstreamError('UPSTREAM_UNREACHABLE', 502);
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    let providerCode = 'unknown';

    try {
      const body = await response.json();

      const rawCode =
        body &&
        body.error &&
        (body.error.code || body.error.type);

      if (typeof rawCode === 'string') {
        providerCode = rawCode
          .replace(/[^a-zA-Z0-9_-]/g, '')
          .slice(0, 80) || 'unknown';
      }
    } catch {
      // Do not log the response body.
    }

    // Safe diagnostic: no API key, image, or full response.
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

function chatText(data) {
  const message =
    data &&
    data.choices &&
    data.choices[0] &&
    data.choices[0].message;

  return message && typeof message.content === 'string'
    ? message.content.trim()
    : '';
}

function compactJson(value, maxLength) {
  if (value == null) {
    return 'none provided';
  }

  try {
    const result = JSON.stringify(value);

    return result.length > maxLength
      ? result.slice(0, maxLength) + '...(truncated)'
      : result;
  } catch {
    return 'unavailable';
  }
}

async function coachAnswer(
  { question, profile, todayData },
  env
) {
  if (isMock(env)) {
    return {
      answer:
        'This is a MOCK coach reply for testing only. ' +
        'No real AI was called. Configure AI_API_KEY on the server.',
      mock: true,
    };
  }

  const model = env.AI_MODEL || 'gpt-4o-mini';

  const userMessage =
    `User question: ${question}\n\n` +
    `User profile (JSON): ${compactJson(profile, 2500)}\n` +
    `Today's logged data (JSON): ${compactJson(todayData, 2500)}`;

  const data = await postChatCompletions(env, {
    model,
    messages: [
      {
        role: 'system',
        content: COACH_SYSTEM_PROMPT,
      },
      {
        role: 'user',
        content: userMessage,
      },
    ],
    maxTokens: 600,
    temperature: 0.6,
  });

  const answer = chatText(data);

  if (!answer) {
    throw new UpstreamError('UPSTREAM_EMPTY', 502);
  }

  return { answer };
}

function validNumber(value) {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0
  );
}

function sanitizeFoodItems(raw) {
  if (!Array.isArray(raw)) {
    throw new UpstreamError('UPSTREAM_BAD_SHAPE', 502);
  }

  const output = [];

  for (const item of raw.slice(0, 10)) {
    if (!item || typeof item !== 'object') {
      throw new UpstreamError('UPSTREAM_BAD_SHAPE', 502);
    }

    const name =
      typeof item.name === 'string'
        ? item.name.trim().slice(0, 100)
        : '';

    if (
      !name ||
      !validNumber(item.grams) ||
      !validNumber(item.kcal)
    ) {
      throw new UpstreamError('UPSTREAM_BAD_SHAPE', 502);
    }

    const allowedMeals = [
      'breakfast',
      'lunch',
      'dinner',
      'snack',
    ];

    output.push({
      name,
      grams: item.grams,
      kcal: item.kcal,
      protein: validNumber(item.protein) ? item.protein : 0,
      carbs: validNumber(item.carbs) ? item.carbs : 0,
      fat: validNumber(item.fat) ? item.fat : 0,
      meal: allowedMeals.includes(item.meal)
        ? item.meal
        : 'snack',
    });
  }

  return output;
}

function extractJsonArray(text) {
  const cleaned = text
    .trim()
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
    return [
      {
        name: 'Mock rice (test data)',
        grams: 150,
        kcal: 195,
        protein: 3.6,
        carbs: 42,
        fat: 0.4,
        meal: 'lunch',
        mock: true,
      },
    ];
  }

  const model = env.AI_VISION_MODEL || 'gpt-4o-mini';

  const dataUrl =
    `data:${mimetype};base64,${buffer.toString('base64')}`;

  const data = await postChatCompletions(env, {
    model,
    messages: [
      {
        role: 'system',
        content: FOOD_SYSTEM_PROMPT,
      },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text:
              'Identify the foods in this meal photo. ' +
              'Estimate nutrition and return a strict JSON array.',
          },
          {
            type: 'image_url',
            image_url: {
              url: dataUrl,
            },
          },
        ],
      },
    ],
    maxTokens: 800,
    temperature: 0.2,
  });

  const text = chatText(data);

  if (!text) {
    throw new UpstreamError('UPSTREAM_EMPTY', 502);
  }

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
