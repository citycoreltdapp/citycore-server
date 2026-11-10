import { env } from '@/config/env';
import { symplusClient } from './symplus.client';
import { symplusBadResponse } from './symplus.errors';

export type SymplusRow = Record<string, unknown>;
export type SymplusPayload = Record<string, string>;

export interface SymplusMutationResult {
  code?: string;
  remarks?: string;
  customerId?: string;
  sourceReference?: string;
}

export interface SymplusCustomerRow extends SymplusRow {
  customer_id: string;
}

export interface SymplusNetWorthRow extends SymplusRow {
  module_name: string;
  currency_id: string;
  currency_name: string;
  net_worth_amount: number | string;
}

export interface SymplusPositionRow extends SymplusRow {
  product_id: string;
  product_name: string;
  account_id: string;
  currency_id: string;
  currency_name: string;
  current_balance: number | string;
  current_value: number | string;
}

export const CUSTOMER_KINDS = ['individual', 'corporate', 'joint', 'minor'] as const;
export type CustomerKind = (typeof CUSTOMER_KINDS)[number];

const KIND_ENDPOINTS: Record<CustomerKind, { create: string; status: string; document: string }> = {
  individual: {
    create: 'DoCRCSNewIndividualCustomer',
    status: 'GetCRCSNewIndividualCustomerStatus',
    document: 'DoCRCSIndividualCustomerDoc',
  },
  corporate: {
    create: 'DoCRCSNewCorporate',
    status: 'GetCRCSNewCorporateStatus',
    document: 'DoCRCSCorporateCustomerDoc',
  },
  joint: {
    create: 'DoCRCSNewJoint',
    status: 'GetCRCSNewJointCustomerStatus',
    document: 'DoCRCSJointCustomerDoc',
  },
  minor: {
    create: 'DoCRCSNewMinor',
    status: 'GetCRCSNewMinorStatus',
    document: 'DoCRCSMinorCustomerDoc',
  },
};

export const CUSTOMER_LOOKUPS = {
  id: { endpoint: 'GetCRCSCustomerByID' },
  bvn: { endpoint: 'GetCRCSCustomerByBVN', rowsKey: 'GetCRCSCustomerByBank' },
  nin: { endpoint: 'GetCRCSCustomerByNIN' },
  email: { endpoint: 'GetCRCSCustomerByEmail' },
  phone: { endpoint: 'GetCRCSCustomerByPhone' },
  name: { endpoint: 'GetCRCSCustomerByName' },
  cashAccount: { endpoint: 'GetCRCSCustomerByCashAccount' },
} as const;
export type CustomerLookup = keyof typeof CUSTOMER_LOOKUPS;

export const REFERENCE_LISTS = {
  banks: 'GetCRCSBanks',
  countries: 'GetCRCSCountries',
  currencies: 'GetCRCSCurrency',
  identities: 'GetCRCSIdentity',
  lgas: 'GetCRCSLga',
  locations: 'GetCRCSLocation',
  nationalities: 'GetCRCSNationality',
  officers: 'GetCRCSOfficers',
  positions: 'GetCRCSPosition',
  relationships: 'GetCRCSRelation',
  sectors: 'GetCRCSSector',
  states: 'GetCRCSState',
  titles: 'GetCRCSTitle',
  turnovers: 'GetCRCSTurnover',
} as const;
export type ReferenceList = keyof typeof REFERENCE_LISTS;

export const DOCUMENT_READ_ENDPOINTS = {
  PIX: 'GetCRCSIndividualCusPICBase64',
  IDN: 'GetCRCSIndividualCusIDNBase64',
  SIG: 'GetCRCSIndividualCusSIGBase64',
  UBL: 'GetCRCSIndividualCusUBLBase64',
} as const;
export type IndividualDocumentType = keyof typeof DOCUMENT_READ_ENDPOINTS;

export const CUSTOMER_UPDATE_ENDPOINTS = {
  details: { endpoint: 'DoCRCSCustomerDetailsUpdate' },
  nextOfKin: { endpoint: 'DoCRCSNOKCustomerUpdate' },
  nin: { endpoint: 'DoCRCSCustomerNINUpdate' },
  tin: { endpoint: 'DoCRCSCustomerTINUpdate' },
  bank: { endpoint: 'DoCRCSCustomerBankUpdate' },
  address: { endpoint: 'DoCRCSUpdateIndividualAddress' },
  email: { endpoint: 'DoCRCSUpdateIndividualEmail', usesSessionKey: true },
  employment: { endpoint: 'DoCRCSUpdateIndividualEmploy', usesSessionKey: true },
  identification: { endpoint: 'DoCRCSUpdateIndividualIDN', usesSessionKey: true },
} as const;
export type CustomerUpdateSection = keyof typeof CUSTOMER_UPDATE_ENDPOINTS;

/**
 * Finds the rows in a response. Most endpoints use `{ <name>: [...] }`, a few nest it as
 * `{ status, result: [{ <name>: [...] }] }`, and a 204 has no body at all.
 */
const extractRows = <T extends SymplusRow>(body: unknown, key: string): T[] => {
  if (body === null) return [];

  const container = body as { result?: unknown } & Record<string, unknown>;
  if (Array.isArray(container[key])) return container[key] as T[];

  if (Array.isArray(container.result)) {
    for (const entry of container.result as Record<string, unknown>[]) {
      if (Array.isArray(entry?.[key])) return entry[key] as T[];
    }
  }

  if (typeof body === 'object' && Object.keys(body).length === 0) return [];
  throw symplusBadResponse();
};

const getRows = async <T extends SymplusRow = SymplusRow>(
  endpoint: string,
  params: readonly (string | number)[] = [],
  rowsKey: string = endpoint,
): Promise<T[]> => extractRows<T>(await symplusClient.request({ endpoint, params }), rowsKey);

const asOptionalString = (value: unknown): string | undefined =>
  (typeof value === 'string' && value.trim() !== '') || typeof value === 'number'
    ? String(value)
    : undefined;

const postMutation = async (
  endpoint: string,
  body: unknown,
  headers?: Record<string, string>,
): Promise<SymplusMutationResult> => {
  const response = (await symplusClient.request({ endpoint, body, headers })) as {
    result?: {
      code?: string;
      remarks?: string;
      reference?: Record<string, unknown>;
    }[];
  } | null;

  const result = response?.result?.[0];
  return {
    code: result?.code,
    remarks: result?.remarks,
    // The spec uses both spellings, depending on the endpoint.
    customerId: asOptionalString(result?.reference?.customer_id ?? result?.reference?.CustomerID),
    sourceReference: asOptionalString(result?.reference?.customer_source_reference),
  };
};

export const symplusApi = {
  // Connection
  checkConnection: () => symplusClient.getAccessToken(true),

  // Customer creation and registration status
  createCustomer: (kind: CustomerKind, customer: SymplusPayload) =>
    postMutation(KIND_ENDPOINTS[kind].create, { customer: [customer] }),

  getRegistrationStatus: async (kind: CustomerKind, reference: string) => {
    const endpoint = KIND_ENDPOINTS[kind].status;
    const [row] = await getRows(endpoint, [reference]);
    return asOptionalString(row?.status);
  },

  upgradeMinor: (minor: SymplusPayload) => postMutation('DoCRCSMinorUpgrade', { minor: [minor] }),

  // Customer lookups
  findCustomers: (by: CustomerLookup, value: string) => {
    const lookup: { endpoint: string; rowsKey?: string } = CUSTOMER_LOOKUPS[by];
    return getRows<SymplusCustomerRow>(lookup.endpoint, [value], lookup.rowsKey);
  },
  getCustomerDetails: async (customerId: string) => {
    const [row] = await getRows<SymplusCustomerRow>('GetCRCSCustomerDetails', [customerId]);
    return row ?? null;
  },
  isValidCustomerId: async (customerId: string) => {
    const body = (await symplusClient.request({
      endpoint: 'GetCRCSIsValidCustomerID',
      params: [customerId],
    })) as { IsValidCustomerID?: unknown } | null;
    return String(body?.IsValidCustomerID ?? '').toUpperCase() === 'YES';
  },
  listCustomersByRows: (offset: number, rows: number) =>
    getRows('GetCRCSCustomersByRows', [offset, rows]),
  listCustomersBySerial: (start: number, end: number) =>
    getRows('GetCRCSCustomersBySerialNO', [start, end]),
  listCustomersByAccountPlan: (product: string) =>
    getRows('GetCRCSCustomersByAccountPlan', [product]),
  listMinors: () => getRows('GetCRCSMinors'),
  listMinorsByParent: (parentCustomerId: string) =>
    getRows('GetCRCSMinorByParentID', [parentCustomerId]),

  // Balances
  getNetWorth: (customerId: string) =>
    getRows<SymplusNetWorthRow>('GetCRCSCustomerPosition', [customerId]),
  getPositions: (customerId: string) =>
    getRows<SymplusPositionRow>('GetCRCSCustomerPosition2', [customerId]),

  // Customer updates
  updateCustomer: (section: CustomerUpdateSection, customerId: string, data: SymplusPayload) => {
    const definition: { endpoint: string; usesSessionKey?: boolean } =
      CUSTOMER_UPDATE_ENDPOINTS[section];
    const headers =
      definition.usesSessionKey && env.SYMPLUS_SESSION_KEY
        ? { 'X-SAPI2-SSS-KEY': env.SYMPLUS_SESSION_KEY }
        : undefined;
    return postMutation(
      definition.endpoint,
      { customer: [{ customer_id: customerId, ...data }] },
      headers,
    );
  },
  removeEmployment: (customerId: string) =>
    postMutation('DoCRCSRemoveIndividualEmploy', { customer: [{ customer_id: customerId }] }),

  // Documents
  uploadDocument: (
    kind: CustomerKind,
    owner: { customer_id?: string; customer_source_reference?: string },
    document: { type: string; mimeType: string; contentBase64: string },
  ) =>
    postMutation(KIND_ENDPOINTS[kind].document, {
      ...owner,
      document_type: document.type,
      document_mime_type: document.mimeType,
      document_content_base64: document.contentBase64,
    }),
  getDocumentStatus: (customerId: string) =>
    getRows('GetCRCSIndividualCustomerDocStatus', [customerId]),
  getDocument: async (type: IndividualDocumentType, customerId: string) => {
    const endpoint = DOCUMENT_READ_ENDPOINTS[type];
    const [row] = await getRows(endpoint, [customerId]);
    if (!row) return null;
    return {
      // The picture endpoint spells this differently from the other three.
      mimeType: asOptionalString(row.image_mime_type ?? row.image_mimetype),
      contentBase64: asOptionalString(row.image_base64),
    };
  },

  // Reference data
  getReferenceList: (list: ReferenceList) => getRows(REFERENCE_LISTS[list]),
};
