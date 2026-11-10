import { env } from '@/config/env';
import { symplusService } from '@/modules/symplus/symplus.service';
import { userService } from '@/modules/user/user.service';

const DOCUMENT_LABELS: Record<string, string> = {
  PIX: 'Passport photograph',
  IDN: 'Means of identification',
  SIG: 'Signature',
  UBL: 'Utility bill',
};

export const ONBOARDING_STEPS = [
  'submit_details',
  'processing',
  'upload_documents',
  'await_review',
  'complete',
] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

/**
 * A layer over Symplus for the customer's onboarding flow. Symplus holds the customer's record and
 * decides whether KYC is complete. This only works out where they are, and what to do next.
 */
export const onboardingService = {
  async getState(userId: string) {
    const [user, link] = await Promise.all([
      userService.findById(userId),
      symplusService.getLinkForUser(userId),
    ]);

    const submitted = link?.submittedDocuments ?? [];
    const documents = env.SYMPLUS_REQUIRED_DOCUMENTS.map((type) => ({
      type,
      label: DOCUMENT_LABELS[type] ?? type,
      submitted: submitted.includes(type),
    }));

    const nextStep = ((): OnboardingStep => {
      if (user.kycCompleted) return 'complete';
      if (!link || link.status === 'failed' || link.status === 'rejected') return 'submit_details';
      if (link.status === 'queued') return 'processing';
      return documents.every((document) => document.submitted)
        ? 'await_review'
        : 'upload_documents';
    })();

    return {
      /** False while Symplus is switched off, so a frontend can hide or disable the button. */
      available: env.SYMPLUS_ENABLED,
      kycCompleted: user.kycCompleted,
      kycCompletedAt: user.kycCompletedAt,
      status: link?.status ?? 'not_started',
      nextStep,
      documents,
      customerId: link?.customerId ?? null,
      sourceReference: link?.sourceReference ?? null,
      upstreamStatus: link?.upstreamStatus ?? null,
      lastError: link?.lastError ?? null,
    };
  },

  /** Asks Symplus for the latest on this customer, rather than waiting for the background sync. */
  async refresh(userId: string) {
    const link = await symplusService.requireLinkForUser(userId);
    if (link.status === 'pending') await symplusService.refreshRegistration(link.id);
    else await symplusService.syncKyc(link.id);
    return this.getState(userId);
  },
};
