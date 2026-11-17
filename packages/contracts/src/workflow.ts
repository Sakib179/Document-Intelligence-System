import { z } from 'zod';
export const pageQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(100).default(25), cursor: z.string().max(512).optional() }).strict();
export const pageCursorSchema = z.object({ created_at: z.iso.datetime(), id: z.uuid() }).strict();
const amount = z.string().regex(/^-?\d{1,16}(?:\.\d{1,8})?$/).nullable();
export const invoiceChangesSchema = z.object({
  invoice_number: z.string().trim().min(1).max(200).nullable().optional(),
  invoice_date: z.iso.date().nullable().optional(), supplier_name: z.string().trim().min(1).max(500).nullable().optional(),
  customer_name: z.string().trim().min(1).max(500).nullable().optional(), subtotal: amount.optional(), tax: amount.optional(), total: amount.optional(),
  currency: z.string().regex(/^[A-Z]{3}$/).nullable().optional(),
}).strict().refine(value => Object.keys(value).length > 0, 'Supply corrected fields');
const lineChangesSchema = z.object({ description: z.string().trim().min(1).max(2000).nullable().optional(), quantity: amount.optional(), unit_price: amount.optional(), line_total: amount.optional(), tax_rate: z.string().regex(/^(?:0(?:\.\d{1,8})?|1(?:\.0{1,8})?)$/).nullable().optional() }).strict().refine(value => Object.keys(value).length > 0, 'Supply corrected line fields');
export const invoiceCorrectionSchema = z.object({ revision: z.number().int().positive(), changes: invoiceChangesSchema.optional(), line_items: z.array(z.object({ id: z.uuid(), revision: z.number().int().positive(), changes: lineChangesSchema }).strict()).min(1).max(20).optional(), reason: z.string().trim().min(1).max(2000).optional() }).strict().superRefine((input, context) => {
  if (!input.changes && !input.line_items)
    context.addIssue({ code: 'custom', message: 'Supply invoice or line corrections' });
  if (new Set(input.line_items?.map(line => line.id)).size !== (input.line_items?.length ?? 0))
    context.addIssue({ code: 'custom', message: 'Duplicate line correction IDs' });
});
export const retryRequestSchema = z.object({ reason: z.string().trim().min(1).max(2000).optional() }).strict();
export const requestKeySchema = z.string().min(8).max(128).regex(/^[A-Za-z0-9._-]+$/);
