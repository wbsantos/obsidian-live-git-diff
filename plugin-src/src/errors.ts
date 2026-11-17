/** Keep CLI/plain-text failures readable, including thrown strings and empty errors. */
export function errorMessage(error: unknown): string {
  const detail = error instanceof Error ? error.message : typeof error === 'string' ? error :
    error && typeof error === 'object' && 'message' in error ? String(error.message || '') : '';
  return detail.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').trim() || 'The operation failed without details. Refresh the list and try again.';
}
