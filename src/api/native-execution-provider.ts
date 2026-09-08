import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const NATIVE_EXECUTION_PROVIDER_VERSION = 1 as const;
export const NATIVE_EXECUTION_PROVIDER_EVENT = "pi-subagents:required-native-provider:v1";
export const REQUIRED_NATIVE_PROVIDER_ENV = "PI_SUBAGENT_REQUIRED_NATIVE_PROVIDER";

/** Durable runner identity. The provider transports the package runner, not a replacement role. */
export interface NativeExecutionBinding {
	version: 1;
	provider: string;
	ownerSessionId: string;
	parentSessionId: string;
	runId: string;
	configDigest: string;
	jobId: string;
	turnId: string;
	/** Absolute trusted module implementing host-side WT binding/claim/checkpoint operations. */
	driverModule: string;
	controlPath?: string;
	conversationDigest?: string;
	previousTurnId?: string;
	hostPid?: number;
	nativeId?: string;
	sessionFile?: string;
}

export interface NativeExecutionProvider {
	version: 1;
	name: string;
	/** Must reject unsupported placement before reservation. No role/tool rewriting. */
	prepare(input: { ownerSessionId: string; parentSessionId: string; runId: string; configDigest: string; config: Readonly<Record<string, unknown>>; previous?: NativeExecutionBinding }): NativeExecutionBinding;
	/** Cancel only an exactly matching prepared, unpublished turn. Must throw if uncertain. */
	cancelPrepared?(binding: NativeExecutionBinding, error: string): void;
	/** Start exactly this package-owned runner on a real terminal, without selecting/focusing it. */
	launch(input: { binding: NativeExecutionBinding; command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }): { pid: number };
	/** Queue a package-resolved turn to the already running host. Never launch another process. */
	continue?(input: { binding: NativeExecutionBinding; config: Record<string, unknown> }): {
		pid: number;
		/** Absence means published. An exception has an uncertain outcome. */
		publication?: "published" | "not-published" | "uncertain";
		error?: string;
	};
}

interface NativeProviderRegistration { dispose(): void }
interface NativeProviderRegistrationRequest {
	version: 1;
	provider: NativeExecutionProvider;
	result?: { ok: boolean; wtNativeProviderContract?: 1; error?: unknown; dispose?: () => void };
}

interface RequiredProvider {
	ownerSessionId: string;
	parentSessionId: string;
	provider: NativeExecutionProvider;
}

// Shared by separately loaded copies of this public module in one Pi process.
const registryKey = Symbol.for("pi-subagents.required-native-provider.v1");
function registry(): Map<string, RequiredProvider> {
	// SAFETY: This module owns the symbol; Symbol.for shares its registry across loader copies.
	const global = globalThis as typeof globalThis & { [registryKey]?: Map<string, RequiredProvider> };
	return global[registryKey] ??= new Map();
}

export function requiredNativeProvider(ownerSessionId: string): RequiredProvider | undefined {
	const required = registry().get(ownerSessionId);
	const durable = isAbsolute(ownerSessionId) ? `${existsSync(ownerSessionId) ? realpathSync(ownerSessionId) : ownerSessionId}.native-provider-required.json` : undefined;
	let saved: { version: number; provider: string; parentSessionId: string } | undefined;
	if (durable && existsSync(durable)) {
		if (statSync(durable).size > 4096) throw new Error("Required native provider session marker exceeds its bound.");
		saved = JSON.parse(readFileSync(durable, "utf8"));
		if (saved?.version !== 1 || !saved.provider || !saved.parentSessionId) throw new Error("Invalid durable native provider session marker.");
	}
	const marker = saved?.provider ?? process.env[REQUIRED_NATIVE_PROVIDER_ENV];
	if (saved && required && saved.parentSessionId !== required.parentSessionId) throw new Error("Required native provider durable parent identity mismatch.");
	if (marker && (!required || required.provider.name !== marker)) {
		throw new Error(`Required native execution provider '${marker}' is unavailable for this session; headless fallback is forbidden.`);
	}
	return required;
}

export function assertDefaultNativeLaunchAllowed(parentSessionId: string | undefined): void {
	if (process.env[REQUIRED_NATIVE_PROVIDER_ENV] || [...registry().values()].some((entry) => entry.parentSessionId === parentSessionId)) throw new Error("This parent requires its native interactive execution provider; default/headless child creation is forbidden.");
}

/** Owner listener acknowledges support; a stock package cannot silently ignore the requirement. */
export function registerNativeExecutionProviderListener(pi: Pick<ExtensionAPI, "events">, current: () => { ownerSessionId: string; parentSessionId: string } | undefined): () => void {
	const owned = new Set<RequiredProvider>();
	const off = pi.events.on(NATIVE_EXECUTION_PROVIDER_EVENT, (raw) => {
		if (!raw || typeof raw !== "object") return;
		// SAFETY: Provisional event view only; identity, version and callable provider fields are checked before registry insertion.
		const request = raw as { version?: unknown; provider?: NativeExecutionProvider; result?: unknown };
		if (request.result !== undefined) return;
		try {
			const identity = current();
			const provider = request.provider;
			if (!identity || request.version !== 1 || provider?.version !== 1 || !/^[a-zA-Z0-9._-]{1,128}$/.test(provider.name) || typeof provider.prepare !== "function" || typeof provider.launch !== "function") throw new Error("Invalid required native provider registration or unavailable session owner.");
			if (registry().has(identity.ownerSessionId)) throw new Error("Session already has a required native execution provider.");
			const entry = { ...identity, provider };
			if (isAbsolute(identity.ownerSessionId)) {
				const file = `${existsSync(identity.ownerSessionId) ? realpathSync(identity.ownerSessionId) : identity.ownerSessionId}.native-provider-required.json`;
				const marker = JSON.stringify({ version: 1, provider: provider.name, parentSessionId: identity.parentSessionId });
				if (existsSync(file)) {
					if (statSync(file).size > 4096 || readFileSync(file, "utf8") !== marker) throw new Error("Required native provider differs from this session's durable requirement.");
				} else writeFileSync(file, marker, { flag: "wx", mode: 0o600 });
			}
			registry().set(identity.ownerSessionId, entry);
			owned.add(entry);
			request.result = { ok: true, wtNativeProviderContract: 1, dispose() {
				if (registry().get(entry.ownerSessionId) === entry) registry().delete(entry.ownerSessionId);
				owned.delete(entry);
			} };
		} catch (error) { request.result = { ok: false, error }; }
	});
	return () => {
		off();
		for (const entry of owned) if (registry().get(entry.ownerSessionId) === entry) registry().delete(entry.ownerSessionId);
		owned.clear();
	};
}

/** Call at session_start. Also install the guard below: Pi reports startup errors but continues. */
export function requireNativeExecutionProvider(pi: Pick<ExtensionAPI, "events">, provider: NativeExecutionProvider): NativeProviderRegistration {
	const request: NativeProviderRegistrationRequest = { version: 1, provider };
	pi.events.emit(NATIVE_EXECUTION_PROVIDER_EVENT, request);
	if (!request.result?.ok || typeof request.result.dispose !== "function") throw new Error("pi-subagents required-native-provider v1 acknowledgement missing or rejected; install the compatible package before delegating.", { cause: request.result?.error });
	return { dispose: request.result.dispose };
}

/** Independently loaded bootstrap: missing/stock packages remain zero-child failures. */
export function installRequiredNativeProviderBootstrap(pi: ExtensionAPI, provider: NativeExecutionProvider): void {
	let registration: NativeProviderRegistration | undefined;
	const previousMarker = process.env[REQUIRED_NATIVE_PROVIDER_ENV];
	let error = "Required native execution provider has not been acknowledged.";
	pi.on("session_start", () => {
		process.env[REQUIRED_NATIVE_PROVIDER_ENV] = provider.name;
		registration?.dispose();
		registration = undefined;
		try { registration = requireNativeExecutionProvider(pi, provider); }
		catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
	});
	pi.on("tool_call", (event) => {
		if (event.toolName === "subagent" && !registration) return { block: true, reason: error };
	});
	pi.on("session_shutdown", () => {
		registration?.dispose(); registration = undefined;
		if (process.env[REQUIRED_NATIVE_PROVIDER_ENV] === provider.name) {
			if (previousMarker === undefined) delete process.env[REQUIRED_NATIVE_PROVIDER_ENV];
			else process.env[REQUIRED_NATIVE_PROVIDER_ENV] = previousMarker;
		}
	});
}
