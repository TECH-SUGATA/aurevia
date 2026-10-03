export const RANGES = {
  moisture: { lo: 45, hi: 70, min: 20, max: 90 },
  temperature: { lo: 18, hi: 28, min: 10, max: 35 },
  ph: { lo: 5.8, hi: 7.0, min: 4.5, max: 8 },
};

export function statusOf(key, v) {
  const r = RANGES[key];
  return v < r.lo ? 'low' : v > r.hi ? 'high' : 'optimal';
}

/** 0-100 score: each reading loses points the further it is outside its healthy range. */
export function healthScore(reading) {
  let score = 100;
  for (const [k, r] of Object.entries(RANGES)) {
    const v = reading[k];
    const out = v < r.lo ? r.lo - v : v > r.hi ? v - r.hi : 0;
    score -= (out / (r.max - r.min)) * 120;
  }
  return Math.max(20, Math.round(score));
}

export function healthLabel(score) {
  return score >= 75 ? 'thriving' : score >= 55 ? 'needs_care' : 'stressed';
}

export function summary(reading) {
  const score = healthScore(reading);
  return {
    score,
    label: healthLabel(score),
    status: Object.fromEntries(Object.keys(RANGES).map((k) => [k, statusOf(k, reading[k])])),
  };
}
