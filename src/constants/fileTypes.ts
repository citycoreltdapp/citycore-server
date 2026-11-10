export interface FileTypeDefinition {
  /** Extension used for the stored file. Never taken from the client's filename. */
  extension: string;
  /** Checks the file's leading bytes, because the client-sent MIME type can't be trusted. */
  matches: (header: Buffer) => boolean;
}

const startsWith = (header: Buffer, bytes: number[]): boolean =>
  bytes.every((byte, index) => header[index] === byte);

const ascii = (text: string): number[] => [...Buffer.from(text, 'ascii')];

export const FILE_TYPES = {
  'image/jpeg': { extension: '.jpg', matches: (h) => startsWith(h, [0xff, 0xd8, 0xff]) },
  'image/png': {
    extension: '.png',
    matches: (h) => startsWith(h, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  },
  'image/gif': { extension: '.gif', matches: (h) => startsWith(h, ascii('GIF8')) },
  'image/webp': {
    extension: '.webp',
    matches: (h) => startsWith(h, ascii('RIFF')) && h.subarray(8, 12).toString('ascii') === 'WEBP',
  },
  'image/bmp': { extension: '.bmp', matches: (h) => startsWith(h, ascii('BM')) },
  'application/pdf': { extension: '.pdf', matches: (h) => startsWith(h, ascii('%PDF-')) },
} as const satisfies Record<string, FileTypeDefinition>;

export type MimeType = keyof typeof FILE_TYPES;

export const IMAGE_TYPES: MimeType[] = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
/** Formats Symplus accepts for KYC documents. */
export const SYMPLUS_DOCUMENT_TYPES: MimeType[] = [
  'image/jpeg',
  'image/png',
  'image/bmp',
  'application/pdf',
];
export const DOCUMENT_TYPES: MimeType[] = ['application/pdf'];

/** A passport photograph, which also becomes the customer's avatar. */
export const KYC_PHOTO_TYPES: MimeType[] = ['image/jpeg', 'image/png', 'image/webp'];
/** A utility bill, photographed or scanned. */
export const KYC_DOCUMENT_TYPES: MimeType[] = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
];
