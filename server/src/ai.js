const KEY = () => process.env.ANTHROPIC_API_KEY;
const MODEL = () => process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';
const GKEY = () => process.env.GEMINI_API_KEY;
const GMODEL = () => process.env.GEMINI_MODEL || 'gemini-2.5-flash';

// Google Gemini (free tier available in Google AI Studio). Used when only GEMINI_API_KEY is set.
async function callGemini({ system, messages, max_tokens = 600 }) {
  const model = GMODEL();
  const contents = messages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: (Array.isArray(m.content) ? m.content : [{ type: 'text', text: String(m.content) }]).map((b) =>
      b.type === 'image'
        ? { inlineData: { mimeType: b.source.media_type, data: b.source.data } }
        : { text: b.text }),
  }));
  const generationConfig = { maxOutputTokens: max_tokens * 4 };
  if (model.includes('2.5-flash')) generationConfig.thinkingConfig = { thinkingBudget: 0 };
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': GKEY() },
    body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents, generationConfig }),
  });
  if (!res.ok) throw new Error(`AI provider error ${res.status}`);
  const data = await res.json();
  return (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('\n');
}

async function callAI(args) {
  return KEY() ? callClaude(args) : callGemini(args);
}

async function callClaude({ system, messages, max_tokens = 600 }) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': KEY(), 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODEL(), max_tokens, system, messages }),
  });
  if (!res.ok) throw new Error(`AI provider error ${res.status}`);
  const data = await res.json();
  return data.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
}

export const aiEnabled = () => Boolean(KEY() || GKEY());

export async function diagnoseLeaf({ image_base64, media_type, plant }) {
  if (!aiEnabled()) {
    return { diagnosis: 'Demo result (AI key not set)', confidence: 0, severity: 'none',
      advice: 'Set GEMINI_API_KEY (free) or ANTHROPIC_API_KEY on the server to get real leaf diagnoses.', demo: true };
  }
  const text = await callAI({
    system: 'You are a plant pathologist. Look at the leaf photo and reply with ONLY a JSON object: {"diagnosis": string, "confidence": number 0-100, "severity": "none"|"mild"|"moderate"|"severe", "advice": string (2-3 short sentences of practical care steps)}. If the image is not a plant leaf, say so in diagnosis with confidence 0.',
    messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type, data: image_base64 } },
      { type: 'text', text: plant ? `Plant: ${plant.name} (${plant.species}).` : 'Diagnose this leaf.' },
    ] }],
  });
  try { return JSON.parse(text.replace(/```json|```/g, '').trim()); }
  catch { return { diagnosis: 'Could not read the result', confidence: 0, severity: 'none', advice: text.slice(0, 300) }; }
}

export async function chatAdvice({ question, plant, reading, history = [] }) {
  if (!aiEnabled()) {
    return { answer: `Monty's latest readings: moisture ${reading?.moisture ?? '?'}%, ${reading?.temperature ?? '?'}°C, pH ${reading?.ph ?? '?'}. Set GEMINI_API_KEY (free) or ANTHROPIC_API_KEY to enable full answers.`, demo: true };
  }
  const ctx = plant && reading
    ? `Plant: ${plant.name} (${plant.species}). Latest readings: moisture ${reading.moisture}%, temperature ${reading.temperature}°C, pH ${reading.ph}. Healthy ranges: moisture 45-70%, temperature 18-28°C, pH 5.8-7.`
    : 'No sensor data available.';
  const answer = await callAI({
    system: `You are Aurevia, a friendly plant-care assistant. Be concise (under 100 words) and practical. ${ctx}`,
    messages: [...history.slice(-6), { role: 'user', content: question }],
  });
  return { answer };
}