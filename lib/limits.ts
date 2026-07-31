/**
 * 7TV emote constraints. Change these in one place if 7TV updates them.
 */
export const LIMITS = {
  maxBytes: 7 * 1024 * 1024, // 7 MB
  maxWidth: 1000,
  maxHeight: 1000,
  maxFrames: 1000,
} as const;

export const MAX_MB = LIMITS.maxBytes / (1024 * 1024);

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

export function formatTime(s: number): string {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const sec = s - m * 60;
  return `${m}:${sec.toFixed(2).padStart(5, '0')}`;
}
