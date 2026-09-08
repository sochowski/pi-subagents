import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerNativeExecutionProviderListener, requireNativeExecutionProvider, type NativeExecutionProvider } from "../../src/api/native-execution-provider.ts";
import { acquireActiveAsyncCapacity, getActiveAsyncCapacitySnapshot } from "../../src/runs/background/active-async-capacity.ts";
import { spawnRunner } from "../../src/runs/background/async-execution.ts";
import { reconcileAsyncRun } from "../../src/runs/background/stale-run-reconciler.ts";
import { nativePublicationOutcome } from "../../src/runs/background/native-runner-route.ts";

for (const boundary of ["prepare", "pre-proceed", "probe", "publish-definite", "publish-uncertain", "published"] as const) {
	it(`native ${boundary} preserves exact reservation/publication lifecycle`, () => {
		const root = mkdtempSync(join(tmpdir(), "native-publication-"));
		const hostDir = join(root, "host"), asyncDir = join(root, "next"), capacityDir = join(root, "capacity");
		mkdirSync(hostDir); mkdirSync(asyncDir);
		const original = { id: "original", sessionId: "owner", cwd: root, steps: [{ agent: "reviewer", task: "read", launchBindingTask: "read", parentSessionId: "parent", cwd: root, context: "fresh", tools: ["read"], extensions: [], inheritSkills: false }] };
		writeFileSync(join(hostDir, "native-runner.json"), JSON.stringify(original));
		const previous = { version: 1, provider: "publication-fixture", ownerSessionId: "owner", parentSessionId: "parent", runId: "original", jobId: "job", turnId: "old-turn", configDigest: "original", driverModule: "/trusted/driver.mjs", nativeId: "native", sessionFile: join(hostDir, "native.jsonl"), hostPid: process.pid, controlPath: join(hostDir, "control.json") } as const;
		const config = { ...original, id: "next", asyncDir, nativeContinuation: previous, steps: [{ ...original.steps[0], task: "continue", sessionFile: previous.sessionFile }] };
		let queued = false, publications = 0, launches = 0;
		const provider: NativeExecutionProvider = { name: previous.provider, version: 1,
			prepare(input) { if (boundary === "prepare") throw new Error("injected prepare"); queued = true; return { ...previous, runId: input.runId, configDigest: input.configDigest, turnId: "next-turn", previousTurnId: "old-turn" }; },
			cancelPrepared(binding) { assert.equal(binding.turnId, "next-turn"); queued = false; },
			launch() { launches++; throw new Error("second writer forbidden"); },
			continue({ binding }) {
				assert.equal(binding.hostPid, process.pid);
				if (boundary === "probe" || boundary === "publish-definite") { queued = false; return { pid: process.pid, publication: "not-published", error: `injected ${boundary}` }; }
				publications++;
				if (boundary === "publish-uncertain") throw new Error("injected uncertain publish");
				queued = false;
				return { pid: process.pid, publication: "published" };
			},
		};
		let listener: Parameters<ExtensionAPI["events"]["on"]>[1] | undefined;
		const pi: Pick<ExtensionAPI, "events"> = { events: { on(_event, fn) { listener = fn; return () => { listener = undefined; }; }, emit(_event, raw) { listener?.(raw); } } };
		const off = registerNativeExecutionProviderListener(pi, () => ({ ownerSessionId: "owner", parentSessionId: "parent" }));
		const registration = requireNativeExecutionProvider(pi, provider);
		const capacity = acquireActiveAsyncCapacity({ sessionId: "owner", limit: 1, runId: "next", kind: "runner", asyncDir }, { rootDir: capacityDir });
		assert.ok(capacity);
		try {
			const start = () => spawnRunner(config, "next", root, { runId: "next", sessionId: "owner", mode: "single", state: "running", startedAt: 1 }, join(asyncDir, "status.json"), undefined, instance => { capacity.markStarted(instance); if (boundary === "pre-proceed") throw new Error("injected pre-proceed"); });
			if (boundary === "prepare") {
				assert.throws(start, /injected prepare/);
				assert.equal(capacity.rollback(), true);
				assert.equal(existsSync(join(asyncDir, "status.json")), false);
			} else {
				const result = start();
				assert.ok(result.runnerProcessInstanceId, result.error);
				const status = JSON.parse(readFileSync(join(asyncDir, "status.json"), "utf8"));
				if (["pre-proceed", "probe", "publish-definite"].includes(boundary)) {
					assert.equal(status.state, "failed"); assert.equal(status.processTerminal.state, "not-started");
					assert.equal(result.startupDidNotProceed, true);
					assert.equal(capacity.rollbackBeforeRunnerProceed(result.runnerProcessInstanceId!), true);
				} else {
					assert.equal(status.pid, process.pid);
					assert.equal(status.nativeExecution.turnId, "next-turn");
					const publication = JSON.parse(readFileSync(join(asyncDir, "native-publication.json"), "utf8"));
					assert.equal(publication.runnerProcessInstanceId, result.runnerProcessInstanceId);
					assert.equal(publication.ownerSessionId, "owner");
					if (boundary === "publish-uncertain") {
						assert.equal(publication.publication, "uncertain");
						for (const dead of [false, true]) {
							const reconciled = reconcileAsyncRun(asyncDir, { resultsDir: join(root, "results"), now: () => Date.now() + 10 ** 9, staleAlivePidMs: 1, kill: () => { if (dead) throw Object.assign(new Error("gone"), { code: "ESRCH" }); return true; } });
							assert.equal(reconciled.repaired, false); assert.equal(reconciled.status?.state, "running"); assert.match(reconciled.message!, /uncertain/);
						}
						assert.equal(capacity.rollback(), false, "uncertainty cannot release a started reservation");
					}
				}
			}
			assert.equal(launches, 0, "continuation never opens a second writer");
			assert.equal(publications, ["publish-uncertain", "published"].includes(boundary) ? 1 : 0);
			assert.equal(queued, boundary === "publish-uncertain", "only uncertain publication retains queued ownership");
			assert.equal(getActiveAsyncCapacitySnapshot("owner", 1, { rootDir: capacityDir }).used, ["publish-uncertain", "published"].includes(boundary) ? 1 : 0);
		} finally { registration.dispose(); off(); rmSync(root, { recursive: true, force: true }); }
	});
}

it("reconciles lost/uncertain versus confirmed-not-published receipts without replay or cross-host evidence", () => {
	const root = mkdtempSync(join(tmpdir(), "native-publication-reconcile-"));
	const binding = { version: 1, provider: "fixture", ownerSessionId: "owner", parentSessionId: "parent", runId: "next", jobId: "job", turnId: "turn", previousTurnId: "previous", configDigest: "digest", driverModule: "/trusted/driver.mjs", nativeId: "native", sessionFile: join(root, "native.jsonl"), hostPid: process.pid, controlPath: join(root, "control.json") } as const;
	const status = { runId: "next", sessionId: "owner", mode: "single", state: "running", startedAt: 1, pid: process.pid, nativeExecution: binding };
	const statusFile = join(root, "status.json"), receiptFile = join(root, "native-publication.json");
	const reconcile = () => reconcileAsyncRun(root, { resultsDir: join(root, "results"), now: () => Date.now() + 10 ** 9, staleAlivePidMs: 1, kill: () => { throw Object.assign(new Error("dead fixture"), { code: "ESRCH" }); } });
	try {
		writeFileSync(statusFile, JSON.stringify(status));
		const anchorFile = join(root, "native-runner.json");
		const anchor = { id: binding.runId, sessionId: binding.ownerSessionId, runnerProcessInstanceId: "instance", nativeExecution: binding };
		writeFileSync(anchorFile, JSON.stringify(anchor));
		assert.equal(reconcile().repaired, false, "missing receipt never proves no publication");
		for (const origin of [undefined, "not-json", JSON.stringify({ ...binding, jobId: "other", runnerProcessInstanceId: "other", publication: "uncertain" })]) {
			if (origin === undefined) rmSync(receiptFile, { force: true }); else writeFileSync(receiptFile, origin);
			writeFileSync(join(root, "native-publication-observed.json"), JSON.stringify({ ...binding, runnerProcessInstanceId: "other", publication: "published" }));
			assert.equal(nativePublicationOutcome(root, binding)?.publication, "uncertain", "wrong-instance observation without valid origin");
			writeFileSync(join(root, "native-publication-observed.json"), JSON.stringify({ ...binding, runnerProcessInstanceId: "instance", publication: "published" }));
			assert.equal(nativePublicationOutcome(root, binding)?.publication, "published", "independent owned anchor permits exact observation");
		}
		for (const patch of [{ id: "other" }, { sessionId: "other" }, { nativeExecution: { ...binding, turnId: "other" } }]) {
			writeFileSync(anchorFile, JSON.stringify({ ...anchor, ...patch }));
			assert.equal(nativePublicationOutcome(root, binding)?.publication, "uncertain", "cross-owner configuration cannot anchor observation");
		}
		rmSync(anchorFile);
		assert.equal(nativePublicationOutcome(root, binding)?.publication, "uncertain", "missing anchor cannot resolve uncertainty");
		writeFileSync(anchorFile, JSON.stringify(anchor));
		writeFileSync(receiptFile, JSON.stringify({ ...binding, runnerProcessInstanceId: "instance", publication: "uncertain" }));
		for (const patch of [{ nativeId: "other" }, { sessionFile: "/other" }, { hostPid: process.pid + 1 }, { runnerProcessInstanceId: "other" }, { version: 2 }]) {
			writeFileSync(join(root, "native-publication-observed.json"), JSON.stringify({ ...binding, runnerProcessInstanceId: "instance", publication: "published", ...patch }));
			assert.equal(reconcile().repaired, false, "cross-host/instance observation cannot resolve uncertainty");
		}
		writeFileSync(receiptFile, JSON.stringify({ ...binding, runnerProcessInstanceId: "instance", publication: "not-published" }));
		const failed = reconcile();
		assert.equal(failed.repaired, true);
		assert.equal(failed.status?.state, "failed");
		assert.equal(failed.status?.processTerminal?.state, "not-started");
		assert.equal(failed.status?.processTerminal?.runnerProcessInstanceId, "instance");
	} finally { rmSync(root, { recursive: true, force: true }); }
});
