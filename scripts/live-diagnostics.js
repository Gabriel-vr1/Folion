// Only the CLI verifier uses these details; HTTP customers receive safe AppErrors.
export function liveErrorDetails(error, apiKey = '') {
  const provider = error?.cause ?? error;
  const status = Number(provider?.status);
  let message = typeof provider?.message === 'string' ? provider.message : 'No provider error message available.';
  // The SDK ApiError message may contain Google's JSON error envelope.
  try {
    const parsed = JSON.parse(message);
    if (typeof parsed.error?.message === 'string') message = parsed.error.message;
  } catch { /* Plain-text SDK and network errors are also useful. */ }
  for (const key of new Set([apiKey.trim(), encodeURIComponent(apiKey.trim())])) {
    if (key) message = message.replaceAll(key, '[REDACTED]');
  }
  message = message
    .replace(/AIza[\w-]+/g, '[REDACTED]')
    .replace(/((?:[?&]|\b)(?:key|api_key|x-goog-api-key)\s*[=:]\s*)[^\s&"'<>]+/gi, '$1[REDACTED]')
    .replace(/(\bBearer\s+)[^\s"'<>]+/gi, '$1[REDACTED]');
  return {
    status: Number.isInteger(status) && status >= 100 && status <= 599 ? status : null,
    message,
  };
}
