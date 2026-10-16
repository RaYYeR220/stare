/** Open-ended validity intervals end here (9999-12-31T23:59:59Z). FalkorDB can't store null properties. */
export const FOREVER = 253402300799000;

export const DAY = 86_400_000;

export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

export function fixedClock(at: number): Clock {
  return { now: () => at };
}

export const iso = (ms: number) => new Date(ms).toISOString();
