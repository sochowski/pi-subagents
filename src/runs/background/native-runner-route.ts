import { existsSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import type { AcceptanceInput } from "../../shared/types.ts";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { stableJsonDigest } from "../../shared/launch-contract.ts";
import * as path from "node:path";
import { requiredNativeProvider, type NativeExecutionBinding } from "../../api/native-execution-provider.ts";
import { resolvePiLaunchToolPlan } from "../shared/child-tool-plan.ts";
import type { RunnerSubagentStep } from "../shared/parallel-utils.ts";

/** Hash the package-resolved serialized runner config, not display names or a provider echo. */
export function nativeRunnerConfigDigest(config: Record<string, unknown>): string {
	const { nativeExecution: _binding, runnerProcessInstanceId: _instance, launchBarrierToken: _barrier, ...contract } = config;
	return createHash("sha256").update(JSON.stringify(contract, (_key, value: unknown) => {
		if (typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") throw new Error("Native runner contract must contain data, not captured functions.");
		return value;
	})).digest("hex");
}

export function validateNativeRunnerConfig(config: Record<string, unknown>): RunnerSubagentStep {
	if (!Array.isArray(config.steps) || config.steps.length !== 1) throw new Error("Required native execution currently supports one retained child per runner; use runs.all of single children.");
	const step = config.steps[0] as RunnerSubagentStep;
	if (!step || typeof step !== "object" || "parallel" in step || step.runner && step.runner.type !== "pi") throw new Error("Required native execution only supports native Pi roles, not external runners or parallel runner groups.");
	if (step.context === "fork" || step.sessionFile && !config.nativeContinuation && (step.context !== "fresh" || existsSync(step.sessionFile)) || config.revivalLease) throw new Error("Required native execution cannot fork or reopen a transcript; retained continuation must use its existing host.");
	if (step.structuredOutput || step.structuredOutputSchema) throw new Error("Required native execution does not yet support structured-output-only completion.");
	if (resolvePiLaunchToolPlan({ ...step, inheritedCapabilityCeiling: (config.inheritedChildRuntime as { capabilityCeiling?: RunnerSubagentStep["capabilityCeiling"] } | undefined)?.capabilityCeiling }).fanoutAuthorized || step.fast || step.worktree || (step.modelCandidates?.length ?? 0) > 1) throw new Error("Required native execution does not support nested delegation, fast mode, managed worktree creation, or model fallback.");
	if (!step.parentSessionId || !config.sessionId || !config.id) throw new Error("Required native execution needs exact native parent, owner, and run identity.");
	return step;
}

export function prepareNativeRunner(config: Record<string, unknown>): NativeExecutionBinding | undefined {
	const required = requiredNativeProvider(typeof config.sessionId === "string" ? config.sessionId : "");
	if (!required) return undefined;
	const step = validateNativeRunnerConfig(config);
	if (step.parentSessionId !== required.parentSessionId) throw new Error("Native provider parent identity changed before launch.");
	const previous = config.nativeContinuation as NativeExecutionBinding | undefined;
	if (previous && (!required.provider.continue || previous.provider !== required.provider.name || previous.ownerSessionId !== required.ownerSessionId || previous.parentSessionId !== required.parentSessionId || previous.sessionFile !== step.sessionFile || !previous.nativeId)) throw new Error("Native continuation provider/owner/native identity mismatch or unsupported operation.");
	if (previous) {
		if (!previous.controlPath) throw new Error("Native continuation has no exact retained host control path.");
		const original = readNativeRunnerConfig(path.join(path.dirname(previous.controlPath), "native-runner.json"));
		if (nativeRunnerConversationContract(original) !== nativeRunnerConversationContract(config)) throw new Error("Native continuation changes its admitted profile or current/inherited ceilings.");
	}
	const configDigest = nativeRunnerConfigDigest(config);
	const admission: Parameters<typeof required.provider.prepare>[0] = { ownerSessionId: required.ownerSessionId, parentSessionId: required.parentSessionId, runId: String(config.id), configDigest, config };
	if (previous) admission.previous = previous;
	const binding = required.provider.prepare(admission);
	try {
		validateNativeExecutionBinding(config, binding);
		if (binding.provider !== required.provider.name || previous && (binding.jobId !== previous.jobId || binding.previousTurnId !== previous.turnId || binding.nativeId !== previous.nativeId || binding.sessionFile !== previous.sessionFile || binding.controlPath !== previous.controlPath)) throw new Error("Native provider changed the admitted conversation identity.");
		return binding;
	} catch (error) {
		required.provider.cancelPrepared?.(binding, String(error));
		throw error;
	}
}

export function validateNativeExecutionBinding(config: Record<string, unknown>, binding: NativeExecutionBinding): void {
	const step = validateNativeRunnerConfig(config);
	if (binding.version !== 1 || !binding.provider || binding.ownerSessionId !== config.sessionId || binding.parentSessionId !== step.parentSessionId || binding.runId !== config.id || binding.configDigest !== nativeRunnerConfigDigest(config) || !binding.jobId || !binding.turnId || !path.isAbsolute(binding.driverModule)) throw new Error("Native execution binding does not match the exact package runner contract.");
}

/** Admission is immutable across turns; task/output placement and supervision IDs are turn-local. */
export function nativeRunnerConversationContract(config: Record<string, unknown>): string {
	if (!Array.isArray(config.steps) || config.steps.length !== 1) throw new Error("Native conversation contract requires one step.");
	const step = config.steps[0] as Record<string, unknown>;
	const fields = ["agent", "runner", "model", "modelCandidates", "thinking", "thinkingCeiling", "tools", "excludeTools", "allowNestedSubagents", "extensions", "subagentOnlyExtensions", "mcpDirectTools", "mutationTools", "completionGuard", "systemPrompt", "systemPromptMode", "inheritProjectContext", "inheritGlobalContext", "inheritSkills", "skills", "fast", "permissionRules", "toolBudget", "capabilityCeiling", "extensionBindings", "effectiveAcceptance", "agentContract", "structuredOutputSchema", "waitToolEnabled", "waitToolDefaultTimeoutMs", "maxSubagentDepth", "outputMode", "cwd"];
	return stableJsonDigest({ step: Object.fromEntries(fields.map((key) => [key, step[key]])), capabilityCeiling: config.capabilityCeiling, inheritedChildRuntime: config.inheritedChildRuntime });
}

export function readNativeRunnerConfig(file: string): Record<string, unknown> {
	if (!path.isAbsolute(file) || statSync(file).size > 512 * 1024) throw new Error("Invalid bounded native runner configuration path.");
	return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
}

const nativeIdentity = Type.String({ minLength: 1 });
const nativeExecutionBindingSchema = Type.Object({
	version: Type.Literal(1), provider: nativeIdentity, ownerSessionId: nativeIdentity,
	parentSessionId: nativeIdentity, runId: nativeIdentity, configDigest: nativeIdentity,
	jobId: nativeIdentity, turnId: nativeIdentity, driverModule: nativeIdentity,
	controlPath: Type.Optional(nativeIdentity), conversationDigest: Type.Optional(nativeIdentity),
	previousTurnId: Type.Optional(nativeIdentity), hostPid: Type.Optional(Type.Integer({ minimum: 1 })),
	nativeId: Type.Optional(nativeIdentity), sessionFile: Type.Optional(nativeIdentity),
});

function readNativeExecutionBinding(file: string): NativeExecutionBinding {
	const record = readNativeRunnerConfig(file);
	if (!Check(nativeExecutionBindingSchema, record)) throw new Error("Public native resume requires exact current provider/job/parent/native/turn identity; malformed native binding.");
	return record;
}

export function readNativeContinuation(input: { sessionFile: string; asyncDir: string; runId: string; ownerSessionId: string; parentSessionId: string }): NativeExecutionBinding {
	const recorded = readNativeExecutionBinding(path.join(input.asyncDir, "native-execution.json"));
	const live = readNativeExecutionBinding(`${input.sessionFile}.native-host.json`);
	const required = requiredNativeProvider(input.ownerSessionId);
	if (!required || recorded.version !== 1 || recorded.runId !== input.runId || recorded.ownerSessionId !== input.ownerSessionId || recorded.parentSessionId !== input.parentSessionId || recorded.provider !== required.provider.name || recorded.provider !== live.provider || recorded.ownerSessionId !== live.ownerSessionId || recorded.parentSessionId !== live.parentSessionId || recorded.runId !== live.runId || recorded.configDigest !== live.configDigest || recorded.driverModule !== live.driverModule || recorded.jobId !== live.jobId || recorded.turnId !== live.turnId || live.sessionFile !== input.sessionFile || !live.nativeId || !live.hostPid || recorded.controlPath !== live.controlPath) throw new Error("Public native resume requires exact current provider/job/parent/native/turn identity; stale or cross-owner recovery is forbidden.");
	return { ...recorded, nativeId: live.nativeId, sessionFile: live.sessionFile, hostPid: live.hostPid };
}

/** Tracking release is deliberately not a process-terminal proof: the native host remains alive. */
export function hasNativeTrackingRelease(asyncDir: string, runId: string, ownerSessionId: string, runnerProcessInstanceId: string): boolean {
	try {
		const binding = readNativeRunnerConfig(path.join(asyncDir, "native-execution.json"));
		const release = readNativeRunnerConfig(path.join(asyncDir, "native-tracking-release.json"));
		return binding.version === 1 && release.version === 1 && release.runId === runId && release.ownerSessionId === ownerSessionId && release.runnerProcessInstanceId === runnerProcessInstanceId && release.hostRetained === true && typeof release.nativeId === "string" && release.nativeId.length > 0 && typeof release.sessionFile === "string" && path.isAbsolute(release.sessionFile) && ["runId", "ownerSessionId", "parentSessionId", "provider", "jobId", "turnId", "configDigest"].every((key) => typeof release[key] === "string" && release[key] !== "" && release[key] === binding[key]);
	} catch { return false; }
}


/** Auto on a retained conversation means keep its admitted input, not re-default it. */
export function nativeContinuationAcceptanceInput(previous: NativeExecutionBinding | undefined, requested: AcceptanceInput | undefined, saved: AcceptanceInput | undefined): AcceptanceInput | undefined {
	return previous && requested === "auto" ? saved : requested ?? saved;
}

const nativeAcceptanceConfigSchema = Type.Object({ steps: Type.Tuple([Type.Object({ launchBindingTask: Type.String() })]) });

export function nativeContinuationAcceptanceTask(previous: NativeExecutionBinding | undefined, task: string): string {
	if (!previous) return task;
	if (!previous.controlPath) throw new Error("Native continuation has no retained acceptance contract.");
	const config = readNativeRunnerConfig(path.join(path.dirname(previous.controlPath), "native-runner.json"));
	if (!Check(nativeAcceptanceConfigSchema, config)) throw new Error("Native continuation has no original acceptance task.");
	return config.steps[0].launchBindingTask;
}

const nativePublicationSchema = Type.Object({
	...nativeExecutionBindingSchema.properties,
	runnerProcessInstanceId: nativeIdentity,
	publication: Type.Union([Type.Literal("published"), Type.Literal("not-published"), Type.Literal("uncertain")]),
});

type NativePublicationReceipt = Static<typeof nativePublicationSchema>;
const nativePublicationAnchorSchema = Type.Object({
	id: nativeIdentity,
	sessionId: nativeIdentity,
	runnerProcessInstanceId: nativeIdentity,
	nativeExecution: nativeExecutionBindingSchema,
});

/** Missing/corrupt receipts are uncertainty, never proof of pre-publication failure. */
export function nativePublicationOutcome(asyncDir: string, binding: NativeExecutionBinding): { publication: "published" | "not-published" | "uncertain"; runnerProcessInstanceId?: string } | undefined {
	if (!binding.previousTurnId) return undefined;
	const identityFields = ["version", "provider", "ownerSessionId", "parentSessionId", "runId", "jobId", "turnId", "previousTurnId", "configDigest", "driverModule", "hostPid", "controlPath", "nativeId", "sessionFile", "conversationDigest"] as const;
	const matches = (record: NativeExecutionBinding) => identityFields.every(key => record[key] === binding[key]);
	let expectedInstance: string;
	try {
		const anchor = readNativeRunnerConfig(path.join(asyncDir, "native-runner.json"));
		if (!Check(nativePublicationAnchorSchema, anchor) || anchor.id !== binding.runId
			|| anchor.sessionId !== binding.ownerSessionId || !matches(anchor.nativeExecution)) return { publication: "uncertain" };
		expectedInstance = anchor.runnerProcessInstanceId;
	} catch { return { publication: "uncertain" }; }
	let receipt: NativePublicationReceipt | undefined;
	try {
		const record = readNativeRunnerConfig(path.join(asyncDir, "native-publication.json"));
		if (Check(nativePublicationSchema, record) && matches(record) && record.runnerProcessInstanceId === expectedInstance) receipt = record;
	} catch { /* Initial ownership can survive a crash before the publication record. */ }
	if (receipt?.publication === "not-published" || receipt?.publication === "published") return receipt;
	try {
		const observed = readNativeRunnerConfig(path.join(asyncDir, "native-publication-observed.json"));
		if (Check(nativePublicationSchema, observed) && observed.publication === "published" && matches(observed) && observed.runnerProcessInstanceId === expectedInstance) return observed;
	} catch { /* Only this exact retained writer can resolve uncertain publication. */ }
	return { publication: "uncertain", runnerProcessInstanceId: expectedInstance };
}
