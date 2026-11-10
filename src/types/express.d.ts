import type { Permission } from '@/constants/permissions';

declare global {
  namespace Express {
    interface AuthUser {
      id: string;
      /** A built-in role or the key of a custom one. */
      /** Read fresh on every request, so a change from Symplus applies immediately. */
      kycCompleted: boolean;
      role: string;
      permissions: readonly Permission[];
    }

    namespace Multer {
      interface File {
        /** Where the file is stored. Set by uploaders that have a `subdirectory`. */
        url?: string;
      }
    }

    interface Request {
      /** Set by the `authenticate` middleware. */
      user?: AuthUser;
    }
  }
}

export {};
