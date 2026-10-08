import assert from "node:assert/strict";
import test from "node:test";
import { validateColdNativeRecovery, type ColdNativeRecoveryRequest, type ColdNativeRecoveryFacts } from "../../src/runs/shared/cold-native-recovery.ts";

// Policy fixtures, not evidence of a real SDK reopen or WT ownership lease.
function fixture(): { request: ColdNativeRecoveryRequest; facts: ColdNativeRecoveryFacts } {
  const request: ColdNativeRecoveryRequest = { version: 1, operationId: "new-explicit-operation", originalRunId: "old-run", originalTurnId: "old-turn", ownerSessionId: "owner", parentSessionId: "parent", jobId: "job", nativeId: "native", sessionFile: "/private/fixture/session.jsonl", leaf: "committed-leaf", conversationDigest: "a".repeat(64), budgetLimits: { tools: 10, spawns: 8 } };
  const facts: ColdNativeRecoveryFacts = { ownerSessionId: request.ownerSessionId, parentSessionId: request.parentSessionId, jobId: request.jobId, nativeId: request.nativeId, sessionFile: request.sessionFile, leaf: request.leaf, conversationDigest: request.conversationDigest, exclusiveLeaseOperationId: request.operationId, oldHost: "dead", priorTurn: "completed", pendingWork: false, budgets: { tools: { limit: 10, spent: 4 }, spawns: { limit: 8, spent: 5 } } };
  return { request, facts };
}
test("cold recovery guard accepts only a settled, exclusively owned, accounted checkpoint", () => {
  const { request, facts } = fixture(), before = JSON.stringify({ request, facts });
  validateColdNativeRecovery(request, facts);
  assert.equal(JSON.stringify({ request, facts }), before, "guard must not mutate or reset retained counters");
});
for (const key of ["ownerSessionId", "parentSessionId", "jobId", "nativeId", "sessionFile", "leaf", "conversationDigest"] as const) {
  test(`cold recovery guard rejects changed ${key}`, () => {
    const { request, facts } = fixture(); facts[key] = "different";
    assert.throws(() => validateColdNativeRecovery(request, facts), new RegExp(`exact ${key} mismatch`));
  });
}
test("cold recovery cannot reuse old run/turn identity or another recovery lease", () => {
  for (const old of ["old-run", "old-turn", ""]) {
    const { request, facts } = fixture(); request.operationId = old;
    assert.throws(() => validateColdNativeRecovery(request, facts), /separate explicit operation identity/);
  }
  const { request, facts } = fixture(); facts.exclusiveLeaseOperationId = "other-request";
  assert.throws(() => validateColdNativeRecovery(request, facts), /exclusive owner lease/);
});
test("cold recovery refuses alive, permission-unknown, unsettled or pending hosts", () => {
  for (const oldHost of ["alive", "unknown"] as const) {
    const { request, facts } = fixture(); facts.oldHost = oldHost;
    assert.throws(() => validateColdNativeRecovery(request, facts), /absence unproven/);
  }
  for (const priorTurn of ["failed", "uncertain"] as const) {
    const { request, facts } = fixture(); facts.priorTurn = priorTurn;
    assert.throws(() => validateColdNativeRecovery(request, facts), /not demonstrably settled/);
  }
  const { request, facts } = fixture(); facts.pendingWork = true;
  assert.throws(() => validateColdNativeRecovery(request, facts), /not demonstrably settled/);
});
test("cold recovery refuses missing, changed, invalid and exhausted retained budgets", () => {
  const variants = [undefined, { limit: 20, spent: 4 }, { limit: 10, spent: -1 }, { limit: 10, spent: 0.5 }, { limit: 10, spent: 10 }, { limit: 10, spent: 11 }];
  for (const variant of variants) {
    const { request, facts } = fixture();
    if (variant) facts.budgets.tools = variant; else delete facts.budgets.tools;
    assert.throws(() => validateColdNativeRecovery(request, facts), /retained tools budget|exhausted tools budget/);
  }
});
