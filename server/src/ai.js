const KEY = () => process.env.ANTHROPIC_API_KEY;
const MODEL = () => process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';

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

export const aiEnabled = () => Boolean(KEY());

export async function diagnoseLeaf({ image_base64, media_type, plant }) {
  if (!aiEnabled()) {
    return { diagnosis: 'Demo result (AI key not set)', confidence: 0, severity: 'none',
      advice: 'Set ANTHROPIC_API_KEY on the server to get real leaf diagnoses.', demo: true };
  }
  const text = await callClaude({
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
    return { answer: `Monty's latest readings: moisture ${reading?.moisture ?? '?'}%, ${reading?.temperature ?? '?'}°C, pH ${reading?.ph ?? '?'}. Set ANTHROPIC_API_KEY to enable full answers.`, demo: true };
  }
  const ctx = plant && reading
    ? `Plant: ${plant.name} (${plant.species}). Latest readings: moisture ${reading.moisture}%, temperature ${reading.temperature}°C, pH ${reading.ph}. Healthy ranges: moisture 45-70%, temperature 18-28°C, pH 5.8-7.`
    : 'No sensor data available.';
  const answer = await callClaude({
    system: `You are Aurevia, a friendly plant-care assistant. Be concise (under 100 words) and practical. ${ctx}`,
    messages: [...history.slice(-6), { role: 'user', content: question }],
  });
  return { answer };
}
