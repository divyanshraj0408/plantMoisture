export type Reading = {
  t: number; // ms since epoch
  raw: number;
  pct: number;
  start: number; // pump start threshold %
  status: string;
};

// Nano prints: raw,pct,startPct,status
export function parseLine(line: string, t: number): Reading | null {
  const m = line.trim().match(/^(\d+),(\d+),(\d+),(.+)$/);
  if (!m) return null;
  return { t, raw: +m[1], pct: +m[2], start: +m[3], status: m[4] };
}

export function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// Population standard deviation: sqrt(sum((x - mean)^2) / n)
export function stdDev(xs: number[]): number {
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
}

// Least squares fit y = slope * x + intercept, with r^2 (coefficient of determination)
export function linearRegression(xs: number[], ys: number[]) {
  const mx = mean(xs);
  const my = mean(ys);
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < xs.length; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  const slope = sxx === 0 ? 0 : sxy / sxx;
  const intercept = my - slope * mx;
  const r2 = sxx === 0 || syy === 0 ? 0 : (sxy * sxy) / (sxx * syy);
  return { slope, intercept, r2 };
}

// Trailing simple moving average over `window` points
export function movingAverage(xs: number[], window: number): number[] {
  return xs.map((_, i) => mean(xs.slice(Math.max(0, i - window + 1), i + 1)));
}

// Minutes from xNow until the trend line y = slope*x + intercept falls to `threshold`.
// null when the trend isn't falling or is already below.
export function minutesUntil(threshold: number, slope: number, intercept: number, xNow: number): number | null {
  if (slope >= 0) return null;
  const left = (threshold - intercept) / slope - xNow;
  return left > 0 ? left : null;
}
