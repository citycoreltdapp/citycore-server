import { createHmac, timingSafeEqual } from 'node:crypto';

const TOLERANCE_SECONDS = 300;
const SIGNATURE_PATTERN = /^[0-9a-f]{128}$/;

const matches = (expected: Buffer, hex: string): boolean =>
  SIGNATURE_PATTERN.test(hex) && timingSafeEqual(expected, Buffer.from(hex, 'hex'));

/** Checks the `Paystack-Signature` header: `t=<unix seconds>,v1=<key id>:<hex>[,v1=...]`. */
export const verifySignedHeader = (
  rawBody: Buffer,
  header: string,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): boolean => {
  let timestamp: number | undefined;
  const signatures: string[] = [];

  for (const part of header.split(',')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();

    if (key === 't') {
      if (timestamp !== undefined || !/^\d+$/.test(value)) return false;
      timestamp = Number(value);
    } else if (key === 'v1') {
      const keyIdEnd = value.indexOf(':');
      if (keyIdEnd !== -1) signatures.push(value.slice(keyIdEnd + 1));
    }
  }

  if (timestamp === undefined || signatures.length === 0) return false;
  // Stops someone replaying an old event they captured.
  if (Math.abs(nowSeconds - timestamp) > TOLERANCE_SECONDS) return false;

  const expected = createHmac('sha512', secret).update(`${timestamp}.`).update(rawBody).digest();
  // During a secret rotation an event carries one signature per secret, and any can match.
  return signatures.some((signature) => matches(expected, signature));
};

/** Checks the older `x-paystack-signature` header, an HMAC of the body with the secret key. */
export const verifyLegacySignature = (rawBody: Buffer, header: string, secretKey: string) =>
  matches(createHmac('sha512', secretKey).update(rawBody).digest(), header);
