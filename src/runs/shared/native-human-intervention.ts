import { Type } from "typebox";
import type { NativeHumanIntervention } from "../../shared/types.ts";

const count = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
export const nativeHumanInterventionEffectsSchema = Type.Object({
	humanIntervention: Type.Object({
		source: Type.Literal("interactive"),
		accepted: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
		delivered: count,
		firstAcceptedAt: count,
		lastAcceptedAt: count,
	}),
});

/** Project only bounded host metadata from a persisted result, never user text. */
export function projectNativeHumanIntervention(intervention: NativeHumanIntervention): NativeHumanIntervention | undefined {
	if (intervention.delivered > intervention.accepted || intervention.lastAcceptedAt < intervention.firstAcceptedAt) return undefined;
	return { source: "interactive", accepted: intervention.accepted, delivered: intervention.delivered, firstAcceptedAt: intervention.firstAcceptedAt, lastAcceptedAt: intervention.lastAcceptedAt };
}

export function formatNativeHumanIntervention(intervention: NativeHumanIntervention | undefined): string {
	return intervention ? `Human intervention: ${intervention.accepted} accepted, ${intervention.delivered} delivered during this delegated turn; not an untouched delegation.` : "";
}
