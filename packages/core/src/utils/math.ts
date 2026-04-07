export function round(value: number, precision = 8): number {
  return Number(value.toFixed(precision));
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
