import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { NativeExecutionBinding } from "../../src/api/native-execution-provider.ts";
import { nativePublicationOutcome } from "../../src/runs/background/native-runner-route.ts";

// Pure transport fixtures, not an SDK startup or operational recovery proof.
test("cold publication requires actual-owner observation, never a launch or cancellation receipt", () => {
 const dir = mkdtempSync(join(tmpdir(), "cold-publication-"));
 const binding: NativeExecutionBinding = {
  version: 1, provider: "fixture", ownerSessionId: "owner", parentSessionId: "parent",
  runId: "cold-operation", configDigest: "fixture-contract", jobId: "fixture-job", turnId: "new-turn", previousTurnId: "settled-turn",
  driverModule: join(dir,"driver.mjs"), nativeId: "fixture-native", sessionFile: join(dir,"session.jsonl"),
  coldRecovery: { version: 1, leaseId: "a".repeat(64), operation: "cold-operation", leaf: "settled-leaf", cwd: dir, sourceDigest: "b".repeat(64), sidecarDigest: "c".repeat(64), modelId: "fixture/model", thinking: "off", request: { operation: "cold-operation" } },
 };
 const instance = "new-physical-instance";
 const put = (file: string, value: unknown) => writeFileSync(join(dir,file),JSON.stringify(value));
 try {
  put("native-runner.json", { id: binding.runId, sessionId: binding.ownerSessionId, runnerProcessInstanceId: instance, nativeExecution: binding });
  for (const publication of ["uncertain","published","not-published"]) {
   put("native-publication.json", { ...binding, runnerProcessInstanceId: instance, publication });
   assert.equal(nativePublicationOutcome(dir,binding)?.publication,"uncertain");
  }
  const observed = { ...binding, runnerProcessInstanceId: instance, publication: "published", pid: process.pid, runtime: "new-runtime" };
  for (const patch of [{ pid: undefined }, { runtime: undefined }, { pid: 0 }, { turnId: "old-turn" }, { runnerProcessInstanceId: "old-instance" }, { coldRecovery: { ...binding.coldRecovery, leaseId: "d".repeat(64) } }]) {
   put("native-publication-observed.json", { ...observed, ...patch });
   assert.equal(nativePublicationOutcome(dir,binding)?.publication,"uncertain");
  }
  put("native-publication-observed.json",observed);
  assert.equal(nativePublicationOutcome(dir,binding)?.publication,"published");
  // Subsequent warm turns retain the cold provenance, not the cold operation.
  const warm = { ...binding, runId: "later-warm", turnId: "later-turn", previousTurnId: binding.turnId, hostPid: process.pid };
  put("native-runner.json", { id: warm.runId, sessionId: warm.ownerSessionId, runnerProcessInstanceId: "warm-instance", nativeExecution: warm });
  put("native-publication.json", { ...warm, runnerProcessInstanceId: "warm-instance", publication: "published" });
  assert.equal(nativePublicationOutcome(dir,warm)?.publication,"published");
 } finally { rmSync(dir,{recursive:true,force:true}); }
});
