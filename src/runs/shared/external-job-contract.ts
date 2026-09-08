import { writeAtomicJson } from "../../shared/atomic-json.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import { ExternalJobProviderError, getExternalJobProvider, type ExternalJobAdmission, type ExternalJobLaunchRequirements, type ExternalJobProvider, type ExternalJobRequirements, type ExternalJobStartInput } from "../../api/external-job-provider.ts";
import type { AgentConfig } from "../../agents/agents.ts";
import { agentDefinitionDigest, stableJsonDigest } from "../../shared/launch-contract.ts";
import { intersectSubagentCapabilityCeilings, parseSubagentCapabilityCeiling, resolveCurrentSubagentCapabilityCeiling } from "./capability-ceiling.ts";
import type { PiLaunchToolPlan } from "./child-tool-plan.ts";

function fail(message: string): never {
	throw new ExternalJobProviderError(message, { code: "launch-requirements-invalid" });
}
function record(value: unknown, keys: string[]): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) fail("Missing external-job launch requirements object.");
	const result = value as Record<string, unknown>;
	if (Object.keys(result).sort().join(",") !== keys.sort().join(",")) fail("Unknown or missing external-job launch requirements fields.");
	return result;
}
function text(value: unknown): asserts value is string {
	if (typeof value !== "string" || !value.trim() || value.includes("\0")) fail("Invalid external-job launch requirements binding.");
}
function digest(value: unknown): void {
	if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) fail("Missing or invalid external-job launch requirements digest.");
}
function strings(value: unknown): void {
	if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry.trim())) fail("Invalid external-job requirements list.");
}
function verifyDigest(value: { digest: string }): void {
	const { digest: expected, ...body } = value;
	digest(expected);
	if (stableJsonDigest(body) !== expected) fail("External-job launch requirements digest mismatch.");
}
function signed<T extends object>(body: T): T & { digest: string } {
	return { ...body, digest: stableJsonDigest(body) };
}
export function validateExternalJobAdmission(value: unknown): ExternalJobAdmission {
	const a = record(value, ["version", "digest", "ownerSessionId", "parentSessionId", "runId", "provider", "cwd", "agent", "definitionDigest", "systemPromptDigest", "optionsDigest", "requirements"]);
	if (a.version !== 1) fail("Unknown external-job admission version.");
	for (const field of ["ownerSessionId", "parentSessionId", "runId", "provider", "cwd", "agent"]) text(a[field]);
	if (!path.isAbsolute(a.cwd as string)) fail("External-job cwd must be absolute.");
	for (const field of ["definitionDigest", "systemPromptDigest", "optionsDigest"]) digest(a[field]);
	const r = record(a.requirements, ["tools", "extensions", "capabilityCeiling", "nativeFeatures"]);
	const tools = record(r.tools, ["allowlist", "exclude", "required", "allowNestedSubagents"]);
	if (tools.allowlist !== null) strings(tools.allowlist);
	strings(tools.exclude); strings(tools.required);
	if (typeof tools.allowNestedSubagents !== "boolean") fail("Invalid nested subagent requirement.");
	const extensions = record(r.extensions, ["disableAmbient", "configured"]);
	strings(extensions.configured);
	if (typeof extensions.disableAmbient !== "boolean" || r.nativeFeatures !== "none") fail("Unsupported native requirements.");
	if (r.capabilityCeiling !== null) {
		const ceiling = parseSubagentCapabilityCeiling(r.capabilityCeiling);
		if (stableJsonDigest(ceiling) !== stableJsonDigest(r.capabilityCeiling)) fail("Noncanonical capability ceiling.");
	}
	// SAFETY: exact admission keys and every nested requirement member were validated above.
	const admission = value as ExternalJobAdmission;
	verifyDigest(admission);
	return admission;
}
export function validateExternalJobLaunchRequirements(value: unknown): ExternalJobLaunchRequirements {
	const c = record(value, ["version", "digest", "admission", "stepIndex", "promptDigest", "lineage"]);
	if (c.version !== 1) fail("Unknown external-job launch requirements version.");
	validateExternalJobAdmission(c.admission);
	if (!Number.isInteger(c.stepIndex) || (c.stepIndex as number) < 0) fail("Invalid external-job step binding.");
	digest(c.promptDigest);
	if (c.lineage !== null) {
		const l = record(c.lineage, ["sourceRunId", "sourceStepIndex", "parentProviderJobId", "requestId", "requestDigest", "parentRequirementsDigest"]);
		for (const field of ["sourceRunId", "parentProviderJobId", "requestId"]) text(l[field]);
		for (const field of ["requestDigest", "parentRequirementsDigest"]) digest(l[field]);
		if (!Number.isInteger(l.sourceStepIndex) || (l.sourceStepIndex as number) < 0) fail("Invalid external-job source step binding.");
	}
	// SAFETY: exact envelope keys, admission, digest shape and lineage members were validated above.
	const contract = value as ExternalJobLaunchRequirements;
	verifyDigest(contract);
	return contract;
}

export function assertExternalJobProviderRequirements(provider: ExternalJobProvider, requirements: ExternalJobRequirements): void {
	if (provider.launchRequirementsVersion === 1) return;
	if (provider.launchRequirementsVersion !== undefined) fail(`Provider '${provider.name}' declares an unknown launch requirements version.`);
	if (requirements.tools.allowlist !== null || requirements.tools.exclude.length || requirements.tools.allowNestedSubagents || requirements.extensions.disableAmbient || requirements.extensions.configured.length || requirements.capabilityCeiling !== null) {
		throw new ExternalJobProviderError(`Provider '${provider.name}' must opt in to launchRequirementsVersion: 1 to receive restricted jobs.`, { code: "launch-requirements-unsupported" });
	}
}

/** Keep the same rejection policy on single and workflow admission; external jobs do not implement native model execution. */
export function externalJobUnsupportedFeatures(agent: AgentConfig, input: {
	model?: unknown; thinking?: unknown; thinkingCeiling?: unknown; skills?: unknown; schema?: unknown; acceptance?: unknown; contract?: unknown; budget?: unknown; fast?: boolean; context?: string; permissions?: unknown; extensionBindings?: unknown; worktree?: boolean;
}): string[] {
	const unsupported: string[] = [];
	const profileModel = agent.model !== undefined && !(agent.modelSource?.type === "subagents.defaultModel" && agent.modelSource.model === agent.model);
	if (input.model !== undefined || profileModel || agent.modelProvider !== undefined || agent.fallbackModels?.length) unsupported.push("model override/profile model");
	if (input.thinking !== undefined || agent.thinking !== undefined || agent.maxThinking !== undefined || input.thinkingCeiling !== undefined) unsupported.push("thinking override/profile thinking/ceiling");
	if (input.skills !== undefined && input.skills !== false && (!Array.isArray(input.skills) || input.skills.length) || agent.skills?.length || agent.skillPath) unsupported.push("skills");
	if (agent.mcpDirectTools?.length) unsupported.push("MCP tools");
	if (input.schema !== undefined) unsupported.push("structured output");
	if (input.acceptance !== undefined || input.contract !== undefined || agent.defaultAcceptance !== undefined) unsupported.push("acceptance/agent contract");
	if (input.budget !== undefined || agent.toolBudget !== undefined) unsupported.push("tool budget");
	if (input.fast === true || agent.fast === true) unsupported.push("fast mode");
	if (input.context === "fork" || agent.defaultContext === "fork") unsupported.push("fork context");
	if (input.permissions || agent.permissions) unsupported.push("native Pi child permissions");
	if (input.extensionBindings !== undefined) unsupported.push("extension bindings");
	if (input.worktree) unsupported.push("managed worktree");
	return unsupported;
}

function intersectRequirements(current: ExternalJobRequirements, inherited?: ExternalJobRequirements): ExternalJobRequirements {
	if (!inherited) return current;
	const prior = inherited.tools.allowlist;
	const next = current.tools.allowlist;
	const allowlist = prior === null ? next : next === null ? prior : prior.filter((tool) => next.includes(tool));
	const exclude = [...new Set([...inherited.tools.exclude, ...current.tools.exclude])];
	const required = [...new Set([...inherited.tools.required, ...current.tools.required])];
	if (required.some((tool) => exclude.includes(tool) || allowlist !== null && !allowlist.includes(tool))) fail("New external-job requirements conflict with admitted inherited tools.");
	if (stableJsonDigest(current.extensions.configured) !== stableJsonDigest(inherited.extensions.configured) && (current.extensions.disableAmbient || current.extensions.configured.length)) fail("New external-job extensions conflict with admitted inherited extensions.");
	return {
		tools: { allowlist, exclude, required, allowNestedSubagents: current.tools.allowNestedSubagents && inherited.tools.allowNestedSubagents },
		extensions: { disableAmbient: current.extensions.disableAmbient || inherited.extensions.disableAmbient, configured: inherited.extensions.configured },
		capabilityCeiling: intersectSubagentCapabilityCeilings(current.capabilityCeiling ?? undefined, inherited.capabilityCeiling ?? undefined) ?? null,
		nativeFeatures: "none",
	};
}

export function admitExternalJob(input: { agent: AgentConfig; plan: PiLaunchToolPlan; ownerSessionId?: string; parentSessionId?: string; runId: string; cwd: string; systemPrompt: string | null | undefined; inherited?: ExternalJobLaunchRequirements }): ExternalJobAdmission {
	if (input.agent.runner?.type !== "external-job") fail("Expected an external-job profile.");
	text(input.ownerSessionId);
	const inherited = input.inherited ? validateExternalJobLaunchRequirements(input.inherited) : undefined;
	if (inherited && (inherited.admission.ownerSessionId !== input.ownerSessionId || inherited.admission.parentSessionId !== (input.parentSessionId ?? input.ownerSessionId) || inherited.admission.cwd !== input.cwd || inherited.admission.provider !== input.agent.runner.provider || inherited.admission.agent !== input.agent.name)) fail("External-job continuation owner, provider, cwd, or profile binding mismatch.");
	const plan = input.plan;
	const requirements = intersectRequirements({
		tools: { allowlist: plan.explicitToolAllowlist ? plan.effectiveToolAllowlist : null, exclude: plan.excludeTools, required: plan.requiredChildTools, allowNestedSubagents: plan.fanoutAuthorized },
		extensions: { disableAmbient: plan.disableAmbientExtensions, configured: plan.configuredExtensions },
		capabilityCeiling: plan.capabilityCeiling ?? null,
		nativeFeatures: "none",
	}, inherited?.admission.requirements);
	const provider = getExternalJobProvider(input.agent.runner.provider);
	if (provider) assertExternalJobProviderRequirements(provider, requirements);
	return signed({ version: 1 as const, ownerSessionId: input.ownerSessionId, parentSessionId: input.parentSessionId ?? input.ownerSessionId, runId: input.runId, provider: input.agent.runner.provider, cwd: input.cwd, agent: input.agent.name, definitionDigest: agentDefinitionDigest(input.agent), systemPromptDigest: stableJsonDigest(input.systemPrompt ?? ""), optionsDigest: stableJsonDigest(input.agent.runner.options ?? {}), requirements });
}

export function bindExternalJobLaunch(admission: ExternalJobAdmission, stepIndex: number, promptDigest: string, lineage: ExternalJobLaunchRequirements["lineage"]): ExternalJobLaunchRequirements {
	validateExternalJobAdmission(admission);
	return validateExternalJobLaunchRequirements(signed({ version: 1 as const, admission, stepIndex, promptDigest, lineage }));
}
export function assertExternalJobStartBinding(contract: ExternalJobLaunchRequirements, input: Omit<ExternalJobStartInput, "launchRequirements">, provider: string): void {
	const a = contract.admission;
	if (a.provider !== provider || a.parentSessionId !== input.sessionId || a.runId !== input.runId || a.cwd !== input.cwd || a.agent !== input.agent || a.optionsDigest !== stableJsonDigest(input.options) || contract.stepIndex !== input.stepIndex || contract.promptDigest !== input.promptDigest) fail("External-job launch requirements binding mismatch.");
}
export function assertCurrentExternalJobCeiling(contract: ExternalJobLaunchRequirements): void {
	const ceiling = intersectSubagentCapabilityCeilings(resolveCurrentSubagentCapabilityCeiling(contract.admission.ownerSessionId), resolveCurrentSubagentCapabilityCeiling(contract.admission.parentSessionId));
	if (!ceiling) return;
	const r = contract.admission.requirements;
	if (ceiling.allowedAgents && (!ceiling.allowedAgents.includes(contract.admission.agent) || !r.capabilityCeiling?.allowedAgents || r.capabilityCeiling.allowedAgents.some((agent) => !ceiling.allowedAgents!.includes(agent)))
		|| ceiling.denyExtensions && (!r.extensions.disableAmbient || r.extensions.configured.length)
		|| ceiling.allowedTools && (r.tools.allowlist === null || r.tools.allowlist.some((tool) => !ceiling.allowedTools!.includes(tool)))) fail("New capability ceiling conflicts with admitted external-job requirements; refusing dispatch/recovery.");
}
export function externalJobContractPath(asyncDir: string, stepIndex: number): string {
	return path.join(asyncDir, `external-job-${stepIndex}.requirements.json`);
}
export function readExternalJobContract(asyncDir: string, stepIndex: number): ExternalJobLaunchRequirements {
	const { providerJobId, ...contract } = JSON.parse(fs.readFileSync(externalJobContractPath(asyncDir, stepIndex), "utf8"));
	if (providerJobId !== undefined) text(providerJobId);
	return validateExternalJobLaunchRequirements(contract);
}
/** Exclusive creation prevents a retry from replacing the originally admitted contract. */
export function persistExternalJobContract(asyncDir: string, contract: ExternalJobLaunchRequirements): void {
	const file = externalJobContractPath(asyncDir, contract.stepIndex);
	try { fs.writeFileSync(file, JSON.stringify(contract), { flag: "wx", mode: 0o600 }); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		if (readExternalJobContract(asyncDir, contract.stepIndex).digest !== contract.digest) fail("Persisted external-job launch requirements mismatch.");
	}
}
/** Callback input is detached from durable state and recursively frozen. This is not a process sandbox. */
export function freezeExternalJobContract<T>(value: T): T {
	if (value && typeof value === "object") {
		for (const child of Object.values(value)) freezeExternalJobContract(child);
		Object.freeze(value);
	}
	return value;
}

/** The provider job identity is mutable once, outside the immutable launch digest. */
export function bindExternalJobProviderHandle(asyncDir: string, contract: ExternalJobLaunchRequirements, providerJobId: string): void {
	const file = externalJobContractPath(asyncDir, contract.stepIndex);
	const existing = JSON.parse(fs.readFileSync(file, "utf8"));
	if (readExternalJobContract(asyncDir, contract.stepIndex).digest !== contract.digest || existing.providerJobId !== undefined && existing.providerJobId !== providerJobId) fail("External-job provider job identity mismatch.");
	text(providerJobId);
	if (existing.providerJobId === undefined) writeAtomicJson(file, { ...contract, providerJobId });
}
export function assertExternalJobProviderHandle(asyncDir: string, contract: ExternalJobLaunchRequirements, providerJobId: string): void {
	const existing = JSON.parse(fs.readFileSync(externalJobContractPath(asyncDir, contract.stepIndex), "utf8"));
	if (existing.providerJobId !== providerJobId) fail("Missing or mismatched persisted external-job provider job identity.");
}
