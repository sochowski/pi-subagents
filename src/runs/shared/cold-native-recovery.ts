// Admission guard only. No process/session creation, publication, or replay.
// The caller must obtain these facts from the owning WT backend and real SDK.
// This is NOT a cold-recovery implementation until those sources are integrated.
export interface ColdNativeRecoveryRequest {
  version: 1;
  operationId: string;
  originalRunId: string;
  originalTurnId: string;
  ownerSessionId: string;
  parentSessionId: string;
  jobId: string;
  nativeId: string;
  sessionFile: string;
  leaf: string;
  conversationDigest: string;
  budgetLimits: Record<string, number>;
}
export interface ColdNativeRecoveryFacts {
  ownerSessionId: string;
  parentSessionId: string;
  jobId: string;
  nativeId: string;
  sessionFile: string;
  leaf: string;
  conversationDigest: string;
  /** Owner backend's exclusive lease, not a caller-supplied permission claim. */
  exclusiveLeaseOperationId: string;
  oldHost: "dead" | "alive" | "unknown";
  priorTurn: "completed" | "failed" | "uncertain";
  pendingWork: boolean;
  /** Authoritatively retained accounting for every admitted finite budget. */
  budgets: Record<string, { limit: number; spent: number }>;
}
export function validateColdNativeRecovery(request: ColdNativeRecoveryRequest, facts: ColdNativeRecoveryFacts): void {
  const reject: (reason: string) => never = (reason) => { throw new Error(`Cold native recovery refused: ${reason}`); };
  if (request.version !== 1 || !request.operationId || request.operationId === request.originalRunId || request.operationId === request.originalTurnId) reject("separate explicit operation identity required");
  if (!request.originalRunId || !request.originalTurnId || !request.leaf || !/^[a-f0-9]{64}$/.test(request.conversationDigest)) reject("missing original admission/checkpoint identity");
  for (const key of ["ownerSessionId", "parentSessionId", "jobId", "nativeId", "sessionFile", "leaf", "conversationDigest"] as const) {
    if (!request[key] || request[key] !== facts[key]) reject(`exact ${key} mismatch`);
  }
  if (facts.exclusiveLeaseOperationId !== request.operationId) reject("exclusive owner lease required");
  if (facts.oldHost !== "dead") reject("old host absence unproven");
  // Initially permit only settled successful turns. Unknown/failed provider
  // effects and in-flight tools require a separate recovery design, not replay.
  if (facts.priorTurn !== "completed" || facts.pendingWork) reject("prior native work is not demonstrably settled");
  for (const [name, limit] of Object.entries(request.budgetLimits)) {
    const retained = facts.budgets[name];
    if (!Number.isSafeInteger(limit) || limit < 0 || !retained || retained.limit !== limit || !Number.isSafeInteger(retained.spent) || retained.spent < 0) reject(`unproven retained ${name} budget`);
    if (retained.spent >= limit) reject(`exhausted ${name} budget`);
  }
}
