// zod schemas for the PayPal responses FlexSlot reads (DESIGN 2: one validation layer).
// Objects are loose: unknown fields are kept so a newer API shape does not break parsing.
// Status fields stay plain strings; an unknown status is classified as UNKNOWN, never success (DESIGN 6.2).

import { z } from 'zod';

export const AmountSchema = z.looseObject({
  currency_code: z.string(),
  value: z.string(),
});

export const LinkSchema = z.looseObject({
  href: z.string(),
  rel: z.string(),
  method: z.string().optional(),
});

export const PayeeSchema = z.looseObject({
  merchant_id: z.string().optional(),
  email_address: z.string().optional(),
});

const resourceFields = {
  id: z.string().min(1),
  status: z.string().min(1),
  amount: AmountSchema.optional(),
  custom_id: z.string().optional(),
  invoice_id: z.string().optional(),
  create_time: z.string().optional(),
  update_time: z.string().optional(),
  links: z.array(LinkSchema).optional(),
  status_details: z.looseObject({ reason: z.string().optional() }).optional(),
};

export const AuthorizationSchema = z.looseObject({
  ...resourceFields,
  expiration_time: z.string().optional(),
  payee: PayeeSchema.optional(),
});

export const CaptureSchema = z.looseObject({
  ...resourceFields,
  final_capture: z.boolean().optional(),
  payee: PayeeSchema.optional(),
  seller_receivable_breakdown: z.looseObject({}).optional(),
});

export const RefundSchema = z.looseObject({
  ...resourceFields,
  seller_payable_breakdown: z
    .looseObject({ total_refunded_amount: AmountSchema.optional() })
    .optional(),
});

export const PurchaseUnitSchema = z.looseObject({
  reference_id: z.string().optional(),
  custom_id: z.string().optional(),
  invoice_id: z.string().optional(),
  amount: AmountSchema.optional(),
  payee: PayeeSchema.optional(),
  payments: z
    .looseObject({
      authorizations: z.array(AuthorizationSchema).optional(),
      captures: z.array(CaptureSchema).optional(),
      refunds: z.array(RefundSchema).optional(),
    })
    .optional(),
});

export const OrderSchema = z.looseObject({
  id: z.string().min(1),
  status: z.string().min(1),
  intent: z.string().optional(),
  purchase_units: z.array(PurchaseUnitSchema).optional(),
  links: z.array(LinkSchema).optional(),
  create_time: z.string().optional(),
  update_time: z.string().optional(),
});

export const ErrorBodySchema = z.looseObject({
  name: z.string().optional(),
  message: z.string().optional(),
  debug_id: z.string().optional(),
  details: z.array(z.looseObject({ issue: z.string().optional(), description: z.string().optional() })).optional(),
});

export const TokenResponseSchema = z.looseObject({
  access_token: z.string().min(1),
  token_type: z.string(),
  expires_in: z.number().int().positive(),
});

export type Amount = z.infer<typeof AmountSchema>;
export type Authorization = z.infer<typeof AuthorizationSchema>;
export type Capture = z.infer<typeof CaptureSchema>;
export type Refund = z.infer<typeof RefundSchema>;
export type PurchaseUnit = z.infer<typeof PurchaseUnitSchema>;
export type Order = z.infer<typeof OrderSchema>;
export type ErrorBody = z.infer<typeof ErrorBodySchema>;
