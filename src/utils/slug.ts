const MAX_BASE_SLUG_LENGTH = 100;

/** A URL-friendly form of `text`, or `fallback` if nothing in it can be used. */
export const toSlug = (text: string, fallback: string): string =>
  text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, MAX_BASE_SLUG_LENGTH)
    .replace(/^-+|-+$/g, '') || fallback;
