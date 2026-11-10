interface RequestErrors {
  timeout: () => Error;
  network: () => Error;
}

/** Sends a request, turning a timeout or connection failure into the caller's own errors. */
export const fetchWithTimeout = async (
  url: string,
  init: RequestInit,
  timeoutMs: number,
  errors: RequestErrors,
): Promise<Response> => {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw (err as Error).name === 'TimeoutError' ? errors.timeout() : errors.network();
  }
};

/** Returns null for an empty body, and undefined if the body isn't valid JSON. */
export const parseJsonBody = (text: string): unknown => {
  if (text.trim() === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};
