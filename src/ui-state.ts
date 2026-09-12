import { randomUUID } from 'node:crypto';
import { z } from 'zod';

export const PENDING_TTL_MS = 15 * 60 * 1000;

const pendingFields = {
  nonce: z.uuid(),
  promptMessageId: z.number().int().positive().optional(),
  expiresAt: z.iso.datetime(),
};

export const pendingActionSchema = z.discriminatedUnion('step', [
  z.object({ step: z.literal('term'), ...pendingFields }),
  z.object({ step: z.literal('translation'), term: z.string().trim().min(1).max(160), ...pendingFields }),
  z.object({
    step: z.literal('confirm'),
    action: z.enum(['reset', 'forget', 'deleteWord']),
    itemId: z.number().int().positive().optional(),
    ...pendingFields,
  }),
]).refine(pending => pending.step !== 'confirm' || pending.action !== 'deleteWord' || pending.itemId !== undefined, {
  message: 'Deleting a word requires its ID',
});

export type PendingAction = z.infer<typeof pendingActionSchema>;
export type UiState = { pending: PendingAction | null; tipFlags: string[]; conversationCount: number };

export function createPending(step: 'term'): Extract<PendingAction, { step: 'term' }>;
export function createPending(step: 'translation', term: string): Extract<PendingAction, { step: 'translation' }>;
export function createPending(step: 'confirm', action: 'reset' | 'forget' | 'deleteWord', itemId?: number): Extract<PendingAction, { step: 'confirm' }>;
export function createPending(step: PendingAction['step'], value?: string, itemId?: number): PendingAction {
  return pendingActionSchema.parse({
    step,
    nonce: randomUUID(),
    expiresAt: new Date(Date.now() + PENDING_TTL_MS).toISOString(),
    ...(step === 'translation' ? { term: value } : {}),
    ...(step === 'confirm' ? { action: value, itemId } : {}),
  });
}
