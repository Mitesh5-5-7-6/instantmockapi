import type { IAiProposal } from '@instantmockapi/db';

/**
 * Public shape of a proposal. `rawOutput`, `model` and `promptVersion` are
 * omitted on purpose: they are for operators, and exposing them would make
 * them part of the API contract.
 */
export function toAiProposalView(doc: IAiProposal) {
  return {
    id: String(doc._id),
    status: doc.status,
    stage: doc.stage,
    prompt: doc.prompt,
    hints: {
      ...(doc.hints?.name ? { name: doc.hints.name } : {}),
      ...(doc.hints?.kind ? { kind: doc.hints.kind } : {}),
      ...(doc.hints?.description ? { description: doc.hints.description } : {}),
    },
    responseLanguage: doc.responseLanguage,
    result: doc.result,
    error: doc.error,
    geminiCalls: doc.geminiCalls,
    durationMs: doc.durationMs,
    projectId: doc.projectId ? String(doc.projectId) : null,
    draft: doc.draft,
    translation: doc.translation,
    parentId: doc.parentId ? String(doc.parentId) : null,
    childId: doc.childId ? String(doc.childId) : null,
    clarification: doc.clarification,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

export function toAiProposalSummary(doc: IAiProposal) {
  return {
    id: String(doc._id),
    status: doc.status,
    prompt: doc.prompt,
    name: doc.result?.name ?? null,
    projectId: doc.projectId ? String(doc.projectId) : null,
    createdAt: doc.createdAt.toISOString(),
  };
}
