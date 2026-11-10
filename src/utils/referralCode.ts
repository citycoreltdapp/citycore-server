import { randomInt } from 'node:crypto';

// Leaves out characters that are easily confused when read aloud or copied: 0, O, 1, I and L.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;

export const generateReferralCode = (): string =>
  Array.from({ length: CODE_LENGTH }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
