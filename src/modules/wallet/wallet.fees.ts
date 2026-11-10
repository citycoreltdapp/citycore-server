import { AppError } from '@/core/errors/AppError';
import type { WalletSettings } from '@/modules/platformConfig/platformConfig.managed';

const BASIS_POINTS = 10_000;

export interface FundingQuote {
  /** What reaches the wallet, in kobo. */
  amount: number;
  /** Paystack's charge, which the customer pays, in kobo. */
  fee: number;
  /** What the customer is charged, in kobo. */
  total: number;
}

const percentOf = (amount: number, basisPoints: number): number =>
  Math.ceil((amount * basisPoints) / BASIS_POINTS);

/** Refuses an amount outside the current funding limits. `path` is where the client sent it. */
export const assertFundingAmountAllowed = (
  amount: number,
  { minFundingKobo, maxFundingKobo }: WalletSettings,
  path: string,
): void => {
  const message =
    amount < minFundingKobo
      ? `Amount must be at least ${minFundingKobo} kobo`
      : amount > maxFundingKobo
        ? `Amount must be at most ${maxFundingKobo} kobo`
        : null;
  if (message) throw AppError.validation([{ path, message }]);
};

/** Paystack's fee on a local card or USSD payment of `charged` kobo. */
export const calculateCheckoutFee = (charged: number, settings: WalletSettings): number => {
  const flat =
    charged >= settings.checkoutFeeFlatWaivedBelowKobo ? settings.checkoutFeeFlatKobo : 0;
  return Math.min(
    percentOf(charged, settings.checkoutFeeBasisPoints) + flat,
    settings.checkoutFeeCapKobo,
  );
};

/** Paystack's fee on a transfer of `received` kobo into a dedicated virtual account. */
export const calculateTransferFee = (received: number, settings: WalletSettings): number =>
  Math.min(percentOf(received, settings.transferFeeBasisPoints), settings.transferFeeCapKobo);

/**
 * Works out what to charge so that `amount` is left after Paystack's fee. The fee is taken from the
 * total, so adding it to `amount` isn't enough. The fee also has three forms (without the flat part,
 * with it, and capped), so this tries the total each would give and takes the lowest that works.
 */
export const quoteFunding = (amount: number, settings: WalletSettings): FundingQuote => {
  const grossUp = (value: number) =>
    Math.ceil((value * BASIS_POINTS) / (BASIS_POINTS - settings.checkoutFeeBasisPoints));

  const candidates = [
    grossUp(amount),
    grossUp(amount + settings.checkoutFeeFlatKobo),
    amount + settings.checkoutFeeCapKobo,
  ];
  const total = Math.min(
    ...candidates.filter(
      (candidate) => candidate - calculateCheckoutFee(candidate, settings) >= amount,
    ),
  );

  return { amount, fee: total - amount, total };
};
