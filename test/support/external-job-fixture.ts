import * as fs from "node:fs";
import * as path from "node:path";
import { bindExternalJobProviderHandle, readExternalJobContract, admitExternalJob, bindExternalJobLaunch, persistExternalJobContract } from "../../src/runs/shared/external-job-contract.ts";
import { resolvePiLaunchToolPlan } from "../../src/runs/shared/child-tool-plan.ts";
import { externalJobPromptDigest, runExternalJob } from "../../src/runs/shared/external-job-runner.ts";
import { requestExternalJobOperation } from "../../src/runs/shared/external-job-bridge.ts";

/** Current attested inputs for pre-existing bridge lifecycle tests; security tests use the raw API. */
export function externalJobFixture(input: any) {
	const options = input.options ?? {};
	const sessionId = input.sessionId ?? "fixture-owner";
	const admission = admitExternalJob({ agent: { name: input.agent, filePath: "fixture.md", runner: { type: "external-job", provider: input.provider, options } } as any, plan: resolvePiLaunchToolPlan({}), ownerSessionId: sessionId, runId: input.runId, cwd: input.cwd, systemPrompt: "" });
	const followUp = input.followUp ? { ...input.followUp, requestDigest: /^[a-f0-9]{64}$/.test(input.followUp.requestDigest) ? input.followUp.requestDigest : externalJobPromptDigest(input.followUp.requestDigest), parentRequirementsDigest: "a".repeat(64) } : undefined;
	const promptDigest = externalJobPromptDigest(input.prompt);
	const launchRequirements = bindExternalJobLaunch(admission, input.stepIndex, promptDigest, followUp ?? null);
	return { ...input, options, sessionId, admission, promptDigest, launchRequirements, ...(followUp ? { followUp } : {}) };
}

export function runAttestedExternalJob(input: any) {
	const fixture = externalJobFixture(input);
	// These older lifecycle tests hand-author status files. Upgrade those fixtures,
	// rather than adding an unversioned recovery path to production code.
	const statusFile = path.join(input.asyncDir, "status.json");
	if (fs.existsSync(statusFile)) {
		try {
			const status = JSON.parse(fs.readFileSync(statusFile, "utf8"));
			if (status.steps?.[input.stepIndex]?.externalJob) {
				status.steps[input.stepIndex].externalJob.launchRequirements = fixture.launchRequirements;
				persistExternalJobContract(input.asyncDir, fixture.launchRequirements);
				if (status.steps[input.stepIndex].externalJob.providerJobId) bindExternalJobProviderHandle(input.asyncDir, fixture.launchRequirements, status.steps[input.stepIndex].externalJob.providerJobId);
				fs.writeFileSync(statusFile, JSON.stringify(status));
			}
		} catch { /* Deliberately malformed status fixtures remain malformed. */ }
	}
	return runExternalJob(fixture);
}

export function attestedBridgeRequest(asyncDir: string, request: any) {
	const dispatch = request.start ?? request.followUp;
	const fixture = externalJobFixture(dispatch ? { ...dispatch, stepIndex: Number.parseInt(externalJobPromptDigest(`${dispatch.runId}:${dispatch.prompt}`).slice(0, 8), 16), provider: request.provider, ...(request.followUp ? { followUp: Object.fromEntries(["sourceRunId", "sourceStepIndex", "parentProviderJobId", "requestId", "requestDigest"].map((key) => [key, dispatch[key]])) } : {}) } : { provider: request.provider, runId: "fixture-run", cwd: asyncDir, agent: "fixture-agent", stepIndex: 0, prompt: "fixture" });
	persistExternalJobContract(asyncDir, fixture.launchRequirements);
	if (!dispatch && request.providerJobId) bindExternalJobProviderHandle(asyncDir, fixture.launchRequirements, request.providerJobId);
	return dispatch ? { ...request, [request.start ? "start" : "followUp"]: { ...dispatch, ...fixture, ...(fixture.followUp ?? {}) } } : { ...request, context: { launchRequirements: fixture.launchRequirements } };
}
export function requestAttestedExternalJobOperation(asyncDir: string, request: any, ...rest: any[]) {
	return requestExternalJobOperation(asyncDir, attestedBridgeRequest(asyncDir, request), ...rest);
}

export function writeExternalJobFixtureFile(file: string, data: string, encoding?: any): void {
	if (file.includes(`${path.sep}external-job-requests${path.sep}`) && file.endsWith(".json")) {
		const request = JSON.parse(data);
		if (request.operation && (request.start || request.followUp)) {
			const asyncDir = file.split(`${path.sep}external-job-requests${path.sep}`)[0]!;
			data = JSON.stringify(attestedBridgeRequest(asyncDir, request));
		}
	}
	if (file.endsWith(`${path.sep}handle.json`)) {
		const claim = JSON.parse(fs.readFileSync(path.join(path.dirname(file), "request.json"), "utf8"));
		const contract = (claim.start ?? claim.followUp).launchRequirements;
		const asyncDir = file.split(`${path.sep}external-job-requests${path.sep}`)[0]!;
		bindExternalJobProviderHandle(asyncDir, readExternalJobContract(asyncDir, contract.stepIndex), JSON.parse(data).providerJobId);
	}
	fs.writeFileSync(file, data, encoding);
}
