# Explicit cold native recovery — source-only integration

Owner-authorized scope: recover a stopped native process through a deliberately
new operation, without changing its genuine SDK session, admitted role/resources,
permission/model/thinking/acceptance contract or proven budget ceilings. This is
not an installed capability and not a successful recovery of the current reviewer.

## Narrow initial eligibility

Start with **demonstrably settled successful native turns only**. A failed,
interrupted or uncertain model/tool turn is not eligible. Existing warm continuation
keeps its current live-host contract. Normal `resume` must never silently cold-spawn.

A cold operation has its own explicit request identity, not the old run/turn ID.
It must acquire an authoritative exclusive WT lease on the original admitted job,
with the old process proven absent. Unknown PID liveness/ownership, another lease,
a changed session/leaf/profile or missing/exhausted budget accounting refuses.
No added agent/worktree slot and no reset of logical admission/spawn counters.

The new physical host/process is an explicitly recorded ownership epoch; it must
not be disguised as the old PID. The same real native session ID and session file
must come from public SDK SessionManager reads, with the expected committed leaf.
No sidecar/PID rewrites to make old warm-continuation validation appear satisfied.

## Implemented boundaries

The explicit request is `subagent({ action: "resume", id: "<settled-native-run>",
message: "<new instruction>", nativeColdRecovery: true })`. It does not make a
failed/uncertain turn eligible or enable automatic recovery after ESRCH.
Both the companion WT control implementation and this fork are required.

`runner-startup-ready.json` records the actual physical runner reaching its
startup barrier; readiness is not SDK creation, prompt publication or success.
Cold launch remains uncertain until the sole SDK owner binds and claims the
new WT turn and writes its exact `native-publication-observed.json` receipt.

## Implementation slices

1. Pure admission guard (`src/runs/shared/cold-native-recovery.ts`) and private
   policy regressions. This slice does not create/verify real leases or SDK facts;
   callers must supply authoritative evidence. Unit acceptance is NOT integration
   evidence. Guard retains every finite budget and refuses uncertainty.
2. WT-side prepare/claim/cancel recovery lifecycle: exact parent/job/runtime checks,
   authoritative original contract/snapshot/budget records, no human/pin/peer
   protection bypass, exclusive lease and new process epoch. No direct DB edits.
3. Explicit fork/provider cold-recovery operation and versioned authorization
   descriptor. Public SDK reopening only AFTER admission, before any prompt/model
   wake; fail on session/leaf/model/tools drift. Cold attempts cannot use the warm
   mailbox path or fake a host identity.
4. Rebind the actual newly created SDK host to the original recorded conversation;
   publish a NEW delegated turn only after exact identity/ownership proof. Keep
   definite-not-published separate from uncertain publication. Never replay the
   completed old turn or infer consent from its queues/receipts.
5. Private actual-SDK + compiled-WT/PTY fixtures: successful settled recovery,
   concurrent recovery rejection, dead-vs-unknown host proof, changed owner/leaf/
   profile, missing/exhausted finite counters, startup/claim/publication crashes,
   new/duplicate explicit request handling and no old tool/model execution.
6. Freeze both checkout snapshots for review. PR publication is owner-authorized;
   installation, activation, merge and live recovery are not. Original M2 plugin
   checkpoint remains frozen and independently unreviewed.

## Reproducible private validation

- `npm run typecheck` and the native execution/policy/publication/resume tests.
- Set `WT_NATIVE_SDK_TEST_MODULE` to the actual published SDK's `dist/index.js`
  and run `node --experimental-strip-types --test
  test/integration/native-checkpoint-inspection.test.ts`.
- `test/support/native-cold-sdk-pty.py` runs a bounded real-PTY SDK fixture with
  fake HOME and a loopback-only synthetic model endpoint. It can be driven by
  the companion WT compiled-control tests; no live credentials are needed.
- Companion WT's `TestNativeRecoveryFullHostedRunner` exercises the actual
  package `subagent-runner.ts`, compiled WT launcher, original node lock,
  private tmux pane reuse, observed startup barrier, real SDK identity restore,
  actual publication/result receipts and duplicate-launch refusal. A second
  case SIGKILLs the actual runner at the barrier and verifies nonpublication
  and no epoch replay. Its historical transcript is explicitly SDK fixture data.
- Additional compiled-control/SDK SIGKILL cases cover post-open, post-bind,
  post-claim and loopback-model-request boundaries; these complement, not
  replace, the hosted-runner test.

No private fixture result is a claim of recovering the live retained reviewer,
resetting a legacy budget or accepting the separate Durable compatibility work.

## Known hard seams

Legacy hosts may lack authoritative finite-counter checkpoints. Do not guess or
reset those counters. If evidence cannot establish the complete admitted budget,
that legacy session is ineligible. A private Boolean labelled `proven` or a mock
lease is not end-to-end evidence; WT and the real SDK must produce the facts.

Settled-turn-only recovery is intentionally narrower than restart of an interrupted
native agent. An interrupted writer remains blocked until a separate safe policy
exists. No external-effect exactly-once or hostile-same-UID sandbox claim.

The original observed review attempt had a genuine `not-published` receipt after
its retained host vanished. Recovering that conversation must handle the cancelled
attempt honestly while keeping its last genuine successful native checkpoint;
never pretend the cancelled attempt was executed or erase its history.
