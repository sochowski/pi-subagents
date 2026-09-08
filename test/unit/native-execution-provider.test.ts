import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { assertDefaultNativeLaunchAllowed, installRequiredNativeProviderBootstrap, registerNativeExecutionProviderListener, requireNativeExecutionProvider, requiredNativeProvider, REQUIRED_NATIVE_PROVIDER_ENV, type NativeExecutionProvider } from "../../src/api/native-execution-provider.ts";
import { nativeRunnerConfigDigest, prepareNativeRunner, validateNativeExecutionBinding, readNativeContinuation } from "../../src/runs/background/native-runner-route.ts";
import { loadRunnerChildSessionFactory } from "../../src/runs/background/runner-child-sessions.ts";
import { createNativeInteractiveHost } from "../../src/runs/shared/native-interactive-host.ts";
import { acquireSessionLease } from "../../src/runs/shared/session-lease.ts";

function bus() {
	const handlers = new Map<string, (data: unknown) => void>();
	const hooks = new Map<string, (...args: any[]) => any>();
	const pi = { events: { on(name: string, handler: (data: unknown) => void) { handlers.set(name, handler); return () => { handlers.delete(name); }; }, emit(name: string, data: unknown) { handlers.get(name)?.(data); } }, on(name: string, handler: (...args: any[]) => any) { hooks.set(name, handler); } } as unknown as ExtensionAPI;
	return { pi, hooks };
}
function config() { return { id: "run", sessionId: "owner", cwd: "/tmp", steps: [{ agent: "worker", task: "task", parentSessionId: "parent", context: "fresh", tools: [], inheritProjectContext: true, inheritGlobalContext: false, inheritSkills: false }] }; }
function provider(onPrepare = () => {}) : NativeExecutionProvider {
	return { name: "wt-test", version: 1, prepare(input) { onPrepare(); return { version: 1, provider: "wt-test", ...input, jobId: "job", turnId: "turn", driverModule: "/trusted/driver.mjs" }; }, launch() { throw new Error("test must never launch"); } };
}

it("requires an acknowledged compatible owner and blocks stock package tool calls", () => {
	const { pi, hooks } = bus();
	assert.throws(() => requireNativeExecutionProvider(pi, provider()), /acknowledgement/);
	installRequiredNativeProviderBootstrap(pi, provider());
	hooks.get("session_start")?.();
	assert.equal(hooks.get("tool_call")?.({ toolName: "subagent" }).block, true);
	assert.equal(hooks.get("tool_call")?.({ toolName: "read" }), undefined);
	hooks.get("session_shutdown")?.();
});

it("routes native roles only for the exact session owner and retains empty tool lists", () => {
	const { pi } = bus();
	const off = registerNativeExecutionProviderListener(pi, () => ({ ownerSessionId: "owner", parentSessionId: "parent" }));
	const registration = requireNativeExecutionProvider(pi, provider());
	try {
		const input = config();
		const binding = prepareNativeRunner(input);
		assert.equal(binding?.jobId, "job");
		assert.deepEqual(input.steps[0]?.tools, []);
		assert.notEqual(nativeRunnerConfigDigest(input), nativeRunnerConfigDigest({ ...input, steps: [{ ...input.steps[0], tools: undefined }] }));
		assert.notEqual(nativeRunnerConfigDigest(input), nativeRunnerConfigDigest({ ...input, steps: [{ ...input.steps[0], tools: null }] }));
		assert.throws(() => nativeRunnerConfigDigest({ callback() {} }), /captured functions/);
		assert.throws(() => assertDefaultNativeLaunchAllowed("parent"), /headless/);
		assert.doesNotThrow(() => assertDefaultNativeLaunchAllowed("other"));
		assert.equal(prepareNativeRunner({ ...input, sessionId: "other" }), undefined);
		assert.throws(() => validateNativeExecutionBinding(input, { ...binding!, parentSessionId: "other" }), /exact package/);
	} finally { registration.dispose(); off(); }
	assert.equal(requiredNativeProvider("owner"), undefined);
});

it("rejects unsupported contexts and operations before provider reservation", () => {
	let prepared = 0;
	const { pi } = bus();
	const off = registerNativeExecutionProviderListener(pi, () => ({ ownerSessionId: "owner", parentSessionId: "parent" }));
	const registration = requireNativeExecutionProvider(pi, provider(() => { prepared++; }));
	try {
		for (const patch of [{ context: "fork" }, { sessionFile: "/" }, { runner: { type: "external-job", provider: "wt" } }, { allowNestedSubagents: true }, { fast: true }, { worktree: true }, { modelCandidates: ["a", "b"] }]) {
			assert.throws(() => prepareNativeRunner({ ...config(), steps: [{ ...config().steps[0], ...patch }] }));
		}
		assert.equal(prepared, 0);
	} finally { registration.dispose(); off(); }
});

it("missing durable runner binding cannot fall through default or injected factories", async () => {
	const old = process.env[REQUIRED_NATIVE_PROVIDER_ENV];
	process.env[REQUIRED_NATIVE_PROVIDER_ENV] = "missing";
	try {
		assert.throws(() => prepareNativeRunner(config()), /unavailable/);
		await assert.rejects(loadRunnerChildSessionFactory({}), /binding is missing/);
		await assert.rejects(loadRunnerChildSessionFactory({ childSessionFactoryModule: "/never-import.mjs" }), /binding is missing/);
	} finally { if (old === undefined) delete process.env[REQUIRED_NATIVE_PROVIDER_ENV]; else process.env[REQUIRED_NATIVE_PROVIDER_ENV] = old; }
});

it("retained native ownership forbids public SDK revival leases", () => {
	const dir = mkdtempSync(join(tmpdir(), "native-lease-"));
	const file = join(dir, "session.jsonl");
	writeFileSync(file, "");
	writeFileSync(`${file}.native-host.json`, "{}");
	try { assert.throws(() => acquireSessionLease({ sessionFile: file, runId: "new", sourceRunId: "old" }, { rootDir: join(dir, "leases") }), /second SDK writer/); }
	finally { rmSync(dir, { recursive: true, force: true }); }
});

it("interactive native host rejects non-TTY creation before loading the SDK", async () => {
	if (process.stdin.isTTY && process.stdout.isTTY) return;
	const host = createNativeInteractiveHost({ loadPiCodingAgent: async () => { throw new Error("must not load"); } });
	await assert.rejects(host.create({} as never), /real terminal/);
});

it("public native continuation verifies provider, owner, parent, job, native and current turn", () => {
	const dir = mkdtempSync(join(tmpdir(), "native-resume-"));
	const { pi } = bus();
	const off = registerNativeExecutionProviderListener(pi, () => ({ ownerSessionId: "owner", parentSessionId: "parent" }));
	const registration = requireNativeExecutionProvider(pi, provider());
	try {
		const binding = { ...prepareNativeRunner(config())!, controlPath: join(dir, "control.json") };
		const sessionFile = join(dir, "session.jsonl");
		const live = { ...binding, nativeId: "native", sessionFile, hostPid: process.pid };
		writeFileSync(join(dir, "native-execution.json"), JSON.stringify(binding));
		writeFileSync(`${sessionFile}.native-host.json`, JSON.stringify(live));
		const input = { sessionFile, asyncDir: dir, runId: "run", ownerSessionId: "owner", parentSessionId: "parent" };
		assert.equal(readNativeContinuation(input).nativeId, "native");
		for (const patch of [{ provider: "other" }, { ownerSessionId: "other" }, { parentSessionId: "other" }, { jobId: "other" }, { turnId: "old-turn" }, { nativeId: "" }, { sessionFile: "/other" }, { configDigest: "other" }]) {
			writeFileSync(`${sessionFile}.native-host.json`, JSON.stringify({ ...live, ...patch }));
			assert.throws(() => readNativeContinuation(input), /exact current provider/);
		}
	} finally { registration.dispose(); off(); rmSync(dir, { recursive: true, force: true }); }
});

it("continuation rejects changed tools or ceilings before queuing a provider turn", () => {
	const dir = mkdtempSync(join(tmpdir(), "native-contract-"));
	const { pi } = bus();
	let prepared = 0;
	const nativeProvider = { ...provider(() => { prepared++; }), continue() { return { pid: process.pid }; } };
	const off = registerNativeExecutionProviderListener(pi, () => ({ ownerSessionId: "owner", parentSessionId: "parent" }));
	const registration = requireNativeExecutionProvider(pi, nativeProvider);
	try {
		mkdirSync(join(dir, "host"));
		const original = config();
		const previous = { ...prepareNativeRunner(original)!, nativeId: "native", sessionFile: join(dir, "session.jsonl"), controlPath: join(dir, "host", "control.json") };
		writeFileSync(join(dir, "host", "native-runner.json"), JSON.stringify(original));
		prepared = 0;
		for (const patch of [{ tools: ["write"] }, { tools: null }, { capabilityCeiling: { denyExtensions: true } }, { inheritSkills: true }]) {
			assert.throws(() => prepareNativeRunner({ ...original, id: "next", nativeContinuation: previous, steps: [{ ...original.steps[0], sessionFile: previous.sessionFile, ...patch }] }), /changes its admitted profile/);
		}
		assert.equal(prepared, 0);
	} finally { registration.dispose(); off(); rmSync(dir, { recursive: true, force: true }); }
});

it("a durable session requirement rejects missing-provider registration after reload", () => {
	const dir = mkdtempSync(join(tmpdir(), "native-requirement-"));
	const ownerSessionId = join(dir, "parent.jsonl");
	writeFileSync(ownerSessionId, "");
	const alias = join(dir, "alias.jsonl");
	symlinkSync(ownerSessionId, alias);
	const { pi } = bus();
	const off = registerNativeExecutionProviderListener(pi, () => ({ ownerSessionId, parentSessionId: "parent" }));
	const registration = requireNativeExecutionProvider(pi, provider());
	try {
		assert.equal(requiredNativeProvider(ownerSessionId)?.provider.name, "wt-test");
		registration.dispose();
		assert.throws(() => requiredNativeProvider(ownerSessionId), /unavailable/);
		assert.throws(() => requiredNativeProvider(alias), /unavailable/);
	} finally { registration.dispose(); off(); rmSync(dir, { recursive: true, force: true }); }
});

it("real preview acceptance inference preserves required independent review on a fresh retained turn", async () => {
	const { readFileSync } = await import("node:fs");
	const { nativeContinuationAcceptanceInput, nativeContinuationAcceptanceTask, nativeRunnerConversationContract } = await import("../../src/runs/background/native-runner-route.ts");
	const { resolveEffectiveAcceptance } = await import("../../src/runs/shared/acceptance.ts");
	const fixture = JSON.parse(readFileSync(new URL("../fixtures/native-preview/acceptance-contract.json", import.meta.url), "utf8"));
	const original = fixture.config;
	const step = original.steps[0];
	const dir = mkdtempSync(join(tmpdir(), "native-preview-contract-"));
	const previous = { version: 1, provider: "wt-test", ownerSessionId: "owner", parentSessionId: "parent", runId: "original", jobId: "job", turnId: "turn", nativeId: "native", sessionFile: join(dir, "session.jsonl"), controlPath: join(dir, "control.json"), configDigest: "original", driverModule: "/trusted/driver.mjs" } as const;
	writeFileSync(join(dir, "native-runner.json"), JSON.stringify(original));
	let prepares = 0;
	const { pi } = bus();
	const off = registerNativeExecutionProviderListener(pi, () => ({ ownerSessionId: "owner", parentSessionId: "parent" }));
	const registration = requireNativeExecutionProvider(pi, { ...provider(), prepare(input) { prepares++; return { ...previous, runId: input.runId, configDigest: input.configDigest, previousTurnId: previous.turnId, turnId: "next" }; }, continue() { throw new Error("must not publish"); } });
	try {
		const followUp = fixture.followUp;
		const { buildRevivedAsyncTask } = await import("../../src/runs/background/async-resume.ts");
		const infer = (task: string) => resolveEffectiveAcceptance({ explicit: step.acceptanceInput, agentName: step.agent, task, mode: "single", async: true });
		// SAFETY: The prompt builder reads only these saved fields; this is not an executable resume target.
		const broken = infer(buildRevivedAsyncTask({ runId: "original", agent: step.agent, sessionFile: previous.sessionFile } as never, followUp));
		assert.deepEqual(broken.inferredReason, ["read-only task wording"]);
		assert.equal(broken.review, undefined, "faithful saved-preview failure: inferred review disappeared");
		const nextFor = (requested: undefined | "auto") => {
			const acceptanceInput = nativeContinuationAcceptanceInput(previous, requested, step.acceptanceInput);
			const launchBindingTask = nativeContinuationAcceptanceTask(previous, followUp);
			const effectiveAcceptance = resolveEffectiveAcceptance({ explicit: acceptanceInput, agentName: step.agent, task: launchBindingTask, mode: "single", async: true });
			assert.deepEqual(JSON.parse(JSON.stringify(effectiveAcceptance)), step.effectiveAcceptance);
			assert.equal(effectiveAcceptance.review?.required, true);
			assert.deepEqual(effectiveAcceptance.criteria, step.effectiveAcceptance.criteria);
			return { ...original, id: "next", nativeContinuation: previous, steps: [{ ...step, task: followUp, launchBindingTask, sessionFile: previous.sessionFile, acceptanceInput, effectiveAcceptance }] };
		};
		for (const requested of [undefined, "auto"] as const) {
			const admitted = nextFor(requested);
			assert.equal(nativeRunnerConversationContract(original), nativeRunnerConversationContract(admitted));
			assert.equal(prepareNativeRunner(admitted)?.turnId, "next");
			assert.equal(admitted.steps[0].task, followUp, "only the fresh follow-up is dispatched, never admission wording");
			assert.equal("acceptanceEvidence" in admitted.steps[0], false, "new turn needs fresh evidence");
			writeFileSync(join(dir, "native-runner.json"), JSON.stringify(admitted));
			assert.equal(nativeContinuationAcceptanceTask(previous, followUp), step.launchBindingTask, "third turn keeps the original admission anchor");
		}
		assert.equal(nativeContinuationAcceptanceInput(undefined, "auto", step.acceptanceInput), "auto", "fresh/headless auto semantics are unchanged");
		const next = nextFor(undefined);
		const incompatible = nativeContinuationAcceptanceInput(previous, { ...step.acceptanceInput, review: false }, step.acceptanceInput);
		const changedAcceptance = resolveEffectiveAcceptance({ explicit: incompatible, agentName: step.agent, task: step.launchBindingTask, mode: "single", async: true });
		assert.throws(() => prepareNativeRunner({ ...next, steps: [{ ...next.steps[0], acceptanceInput: incompatible, effectiveAcceptance: changedAcceptance }] }), /changes its admitted profile/);
		assert.equal(prepares, 2);
		for (const patch of [{ effectiveAcceptance: broken }, { tools: [] }, { model: "other/model" }, { thinking: "low" }, { inheritSkills: true }, { extensions: [] }, { capabilityCeiling: { version: 1, denyExtensions: true, sources: ["current"] } }]) {
			assert.throws(() => prepareNativeRunner({ ...next, steps: [{ ...next.steps[0], ...patch }] }), /changes its admitted profile/);
		}
		for (const patch of [{ capabilityCeiling: { version: 1, tools: [], sources: ["current"] } }, { inheritedChildRuntime: { capabilityCeiling: { version: 1, tools: [], sources: ["inherited"] } } }]) {
			assert.throws(() => prepareNativeRunner({ ...next, ...patch }));
		}
		assert.equal(prepares, 2, "all incompatible changes rejected before reserve/publication");
	} finally { registration.dispose(); off(); rmSync(dir, { recursive: true, force: true }); }
});

it("canonical native contracts preserve every value and allowlist distinction, not object insertion order", async () => {
	const { stableJsonDigest } = await import("../../src/shared/launch-contract.ts");
	assert.equal(stableJsonDigest({ a: { tools: [], denyExtensions: true }, b: 1 }), stableJsonDigest({ b: 1, a: { denyExtensions: true, tools: [] } }));
	for (const pair of [[null, []], [undefined, []], [["read", "write"], ["write", "read"]]]) assert.notEqual(stableJsonDigest({ tools: pair[0] }), stableJsonDigest({ tools: pair[1] }));
});

it("resolved explicit-tool nested authorization rejects before native reservation", () => {
	let prepared = 0;
	const { pi } = bus();
	const off = registerNativeExecutionProviderListener(pi, () => ({ ownerSessionId: "owner", parentSessionId: "parent" }));
	const registration = requireNativeExecutionProvider(pi, provider(() => { prepared++; }));
	try {
		for (const tools of [["subagent"], ["read", "subagent"]]) assert.throws(() => prepareNativeRunner({ ...config(), steps: [{ ...config().steps[0], tools }] }), /nested delegation/);
		assert.equal(prepared, 0);
	} finally { registration.dispose(); off(); }
});
