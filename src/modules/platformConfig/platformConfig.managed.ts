import { z } from 'zod';
import { env } from '@/config/env';

// These stop a typo from reaching customers, such as 15000 basis points for 1.5%.
const MAX_FEE_BASIS_POINTS = 1_000; // 10%
const MAX_FEE_KOBO = 10_000_000; // 100,000 naira
const MAX_FUNDING_KOBO = 10_000_000_000; // 100 million naira

const basisPoints = z.number().int().min(0).max(MAX_FEE_BASIS_POINTS);
const feeKobo = z.number().int().min(0).max(MAX_FEE_KOBO);
const fundingKobo = z.number().int().min(1).max(MAX_FUNDING_KOBO);
// 20% is far above any normal commission, so more than this is a typo.
const commissionBasisPoints = z.number().int().min(0).max(2_000);

/**
 * Settings the code itself reads. They always exist, and only their value can change. `.env` gives
 * each its first value, and the fallback if its stored value is ever missing or invalid.
 */
export const MANAGED_CONFIGS = {
  minFundingKobo: {
    key: 'wallet.funding.min_kobo',
    label: 'Minimum wallet funding',
    description: 'The least a customer can add to their wallet in one payment, in kobo.',
    fallback: env.WALLET_MIN_FUNDING_KOBO,
    rule: fundingKobo,
  },
  maxFundingKobo: {
    key: 'wallet.funding.max_kobo',
    label: 'Maximum wallet funding',
    description: 'The most a customer can add to their wallet in one payment, in kobo.',
    fallback: env.WALLET_MAX_FUNDING_KOBO,
    rule: fundingKobo,
  },
  checkoutFeeBasisPoints: {
    key: 'wallet.fees.checkout.basis_points',
    label: 'Checkout fee percentage',
    description: 'The percentage part of the checkout fee. 150 basis points is 1.5%.',
    fallback: env.PAYSTACK_FEE_BASIS_POINTS,
    rule: basisPoints,
  },
  checkoutFeeFlatKobo: {
    key: 'wallet.fees.checkout.flat_kobo',
    label: 'Checkout flat fee',
    description: 'The flat part of the checkout fee, in kobo.',
    fallback: env.PAYSTACK_FEE_FLAT_KOBO,
    rule: feeKobo,
  },
  checkoutFeeFlatWaivedBelowKobo: {
    key: 'wallet.fees.checkout.flat_waived_below_kobo',
    label: 'Checkout flat fee waiver',
    description: 'Payments below this many kobo pay no flat fee.',
    fallback: env.PAYSTACK_FEE_FLAT_WAIVED_BELOW_KOBO,
    rule: feeKobo,
  },
  checkoutFeeCapKobo: {
    key: 'wallet.fees.checkout.cap_kobo',
    label: 'Checkout fee cap',
    description: 'The most a checkout fee can be, in kobo.',
    fallback: env.PAYSTACK_FEE_CAP_KOBO,
    rule: feeKobo,
  },
  transferFeeBasisPoints: {
    key: 'wallet.fees.transfer.basis_points',
    label: 'Virtual account fee percentage',
    description: 'The virtual account transfer fee. 100 basis points is 1%.',
    fallback: env.PAYSTACK_DVA_FEE_BASIS_POINTS,
    rule: basisPoints,
  },
  transferFeeCapKobo: {
    key: 'wallet.fees.transfer.cap_kobo',
    label: 'Virtual account fee cap',
    description: 'The most a virtual account transfer fee can be, in kobo.',
    fallback: env.PAYSTACK_DVA_FEE_CAP_KOBO,
    rule: feeKobo,
  },
  referralCommissionBasisPoints: {
    key: 'referral.commission.basis_points',
    label: 'Referral commission',
    description: 'What a referrer earns for each year of an investment. 100 basis points is 1%.',
    fallback: env.REFERRAL_COMMISSION_BASIS_POINTS,
    rule: commissionBasisPoints,
  },
  referralMinInvestmentKobo: {
    key: 'referral.commission.min_investment_kobo',
    label: 'Referral minimum investment',
    description: 'The smallest investment that earns a referral commission, in kobo.',
    fallback: env.REFERRAL_MIN_INVESTMENT_KOBO,
    rule: z.number().int().min(0).max(MAX_FUNDING_KOBO),
  },
  referralMaxCommissionedInvestments: {
    key: 'referral.commission.max_investments',
    label: 'Referral commissions per person',
    description: "How many of a referred customer's investments earn a commission. 0 means all.",
    fallback: env.REFERRAL_MAX_COMMISSIONED_INVESTMENTS,
    rule: z.number().int().min(0).max(1_000),
  },
} as const;

export const MANAGED_CONFIG_CATEGORY = 'wallet';
export const REFERRAL_CONFIG_CATEGORY = 'referral';

export type WalletSettings = Record<keyof typeof MANAGED_CONFIGS, number>;
export type WalletSettingName = keyof WalletSettings;

export const MANAGED_CONFIG_NAMES = Object.keys(MANAGED_CONFIGS) as WalletSettingName[];

export const DEFAULT_WALLET_SETTINGS = Object.fromEntries(
  MANAGED_CONFIG_NAMES.map((name) => [name, MANAGED_CONFIGS[name].fallback]),
) as WalletSettings;

/** Pairs that must stay in order, checked together because each can change on its own. */
export const MANAGED_CONFIG_ORDER: readonly {
  lower: WalletSettingName;
  upper: WalletSettingName;
  message: string;
}[] = [
  {
    lower: 'minFundingKobo',
    upper: 'maxFundingKobo',
    message: 'Minimum funding cannot be more than maximum funding',
  },
  {
    lower: 'checkoutFeeFlatKobo',
    upper: 'checkoutFeeCapKobo',
    message: 'The checkout flat fee cannot be more than the checkout fee cap',
  },
];

export const managedConfigName = (key: string): WalletSettingName | undefined =>
  MANAGED_CONFIG_NAMES.find((name) => MANAGED_CONFIGS[name].key === key);
