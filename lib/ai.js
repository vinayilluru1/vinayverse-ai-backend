```javascript
'use strict';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_TIMEOUT_MS = 50000;

const COACH_SYSTEM_PROMPT = `You are VINAYVERSE Coach, a friendly fitness and nutrition coach.
Give practical, safe, concise advice.
Treat calorie and nutrition values as estimates.
Never diagnose medical conditions or recommend dangerous diets.`;

const FOOD_SYSTEM_PROMPT = `Identify the foods visible in the meal photo.
Return a strict JSON array only. Each item must contain:
"name": string,
"grams": number,
"kcal": number,
"protein": number,
"carbs": number,
"fat": number,
"meal": "breakfast", "lunch", "dinner", or "snack".
All nutrition and weight estimates are approximate.
Return [] if no food can be identified.`;

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

async function postChatCompletions(
  env,
  { model, messages, maxTokens, temperature }
) {
  if (isMock(env)) return { __mock: true };

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

  let res;

  try {
    res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: maxTokens,
        temperature
      }),
      signal: controller.signal
    });
  } catch (err) {
    if (err && err.name === 'AbortError') {
      throw new UpstreamError('UPSTREAM_TIMEOUT', 504);
    }
    throw new UpstreamError('UPSTREAM_UNREACHABLE', 502);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    let providerCode = 'unknown';

    try {
      const body = await res.json();
      const code = body?.error?.code || body?.error?.type;

      if (typeof code === 'string') {
        providerCode = code
          .replace(/[^a-zA-Z0-9_-]/g, '')
          .slice(0, 80) || 'unknown';
      }
    } catch {
      // Do not log the provider response body.
    }

    console.error(
      `[AI provider] HTTP ${res.status}; code=${providerCode}`
    );

    throw new UpstreamError('UPSTREAM_ERROR', 502);
  }

  try {
    return await res.json();
  } catch {
    throw new UpstreamError('UPSTREAM_INVALID_RESPONSE', 502);
  }
}

function chatText(data) {
  const message = data?.choices?.[0]?.message;
  return typeof message?.content === 'string'
    ? message.content.trim()
    : '';
}

function compactJson(value, maxLen) {
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

async function coachAnswer(
  { question, profile, todayData },
  env
) {
  if (isMock(env)) {
    return {
      answer: 'Mock response only. Configure AI_API_KEY for real AI.',
      mock: true
    };
  }

  const data = await postChatCompletions(env, {
    model: env.AI_MODEL || 'gpt-4o-mini',
    messages: [
      { role: 'system', content: COACH_SYSTEM_PROMPT },
      {
        role: 'user',
        content:
          `Question: ${question}\n` +
          `Profile: ${compactJson(profile, 2500)}\n` +
          `Today's data: ${compactJson(todayData, 2500)}`
      }
    ],
    maxTokens: 600,
    temperature: 0.6
  });

  const answer = chatText(data);
  if (!answer) throw new UpstreamError('UPSTREAM_EMPTY', 502);

  return { answer };
}

function validNumber(value) {
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0;
}

function sanitizeFoodItems(raw) {
  if (!Array.isArray(raw)) {
    throw new UpstreamError('UPSTREAM_BAD_SHAPE', 502);
  }

  const allowedMeals = ['breakfast', 'lunch', 'dinner', 'snack'];

  return raw.slice(0, 10).map(item => {
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
      meal: allowedMeals.includes(item.meal) ? item.meal : 'snack'
    };
  });
}

function extractJsonArray(value) {
  const cleaned = value.trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');

  const parsed = JSON.parse(cleaned);

  if (!Array.isArray(parsed)) {
    throw new Error('Expected JSON array');
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

  const dataUrl =
    `data:${mimetype};base64,${buffer.toString('base64')}`;

  const data = await postChatCompletions(env, {
    model: env.AI_VISION_MODEL || 'gpt-4o-mini',
    messages: [
      { role: 'system', content: FOOD_SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'Identify foods and estimate nutrition. Return JSON only.'
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

  const result = chatText(data);
  if (!result) throw new UpstreamError('UPSTREAM_EMPTY', 502);

  let parsed;
  try {
    parsed = extractJsonArray(result);
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
  FOOD_SYSTEM_PROMPT
};
```
