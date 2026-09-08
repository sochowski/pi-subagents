import assert from "node:assert/strict";
import { test } from "node:test";
import { formatNativeHumanIntervention, projectNativeHumanIntervention } from "../../src/runs/shared/native-human-intervention.ts";
import { toWaitCompletion } from "../../src/runs/background/wait-completions.ts";

const humanIntervention = { source: "interactive", accepted: 2, delivered: 2, firstAcceptedAt: 100, lastAcceptedAt: 200 };

test("native human intervention survives slim parent completion without copying input or other effects", () => {
	const completion = toWaitCompletion({ results: [{ agent: "reviewer", success: true, effects: { humanIntervention: { ...humanIntervention, text: "private human input" }, fileMutation: { expected: false } } }] }, "run");
	assert.deepEqual(completion.results?.[0]?.effects, { humanIntervention });
	assert.equal(completion.results?.[0]?.success, true);
	assert.ok(!JSON.stringify(completion).includes("private human input"));
	assert.match(formatNativeHumanIntervention(completion.results?.[0]?.effects?.humanIntervention), /Human intervention: 2 accepted, 2 delivered.*not an untouched delegation/);
});

test("native human intervention rejects malformed or unbounded persisted metadata", () => {
	for (const invalid of [undefined, null, [], {}, { humanIntervention: { ...humanIntervention, source: "extension" } }, { humanIntervention: { ...humanIntervention, accepted: 0 } }, { humanIntervention: { ...humanIntervention, delivered: 3 } }, { humanIntervention: { ...humanIntervention, accepted: Infinity } }, { humanIntervention: { ...humanIntervention, accepted: 1.5 } }, { humanIntervention: { ...humanIntervention, lastAcceptedAt: 99 } }]) {
		assert.equal(toWaitCompletion({ results: [{ effects: invalid }] }, "run").results?.[0]?.effects, undefined);
	}
	assert.equal(formatNativeHumanIntervention(undefined), "");
});

test("native human intervention reports accepted but undelivered input honestly", () => {
	const effects = projectNativeHumanIntervention({ ...humanIntervention, source: "interactive", delivered: 1 });
	assert.match(formatNativeHumanIntervention(effects), /2 accepted, 1 delivered/);
});
