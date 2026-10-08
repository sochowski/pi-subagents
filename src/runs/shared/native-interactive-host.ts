import * as fs from "node:fs";
import { createChildHostContextHook, type ChildHostContext } from "./child-host-context.ts";
import { randomUUID, createHash } from "node:crypto";
import type { NativeHumanIntervention } from "../../shared/types.ts";
import { extractTextFromContent } from "../../shared/utils.ts";
import type { ChildSessionEvent } from "./child-session.ts";
import type { NativeExecutionBinding } from "../../api/native-execution-provider.ts";
import type { AgentSessionRuntime, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createDefaultChildSessionFactory, type ChildSession, type ChildSessionFactory, type ChildSessionLaunch, type ChildHookExtension, type DefaultChildSessionFactoryOptions } from "./child-session.ts";

/** One runner, one TTY, one native writer. Attempt release does not close the TUI. */
export interface NativeInteractiveHost extends ChildSessionFactory {
	readonly child: ChildSession | undefined;
	readonly startupFailureSettled: boolean;
	beginContinuation(binding: NativeExecutionBinding, driver: NativeHostDriver): void;
	/** Explicit host shutdown, not a subagent tracking/cancellation operation. */
	close(): Promise<void>;
}

export interface NativeHostDriver {
	version: 1;
	/** Explicit authority for a NEW physical epoch, never a warm-host fallback. */
	recovery?: {
		version: 1;
		leaseId: string;
		expected: import("./native-checkpoint-inspection.ts").NativeCheckpointExpectation;
		sourceDigest: string;
		sidecarDigest: string;
		modelId: string;
		thinking: string;
		authorizeOpen(): Promise<void>;
	};
	/** Optional tool-free host orientation, refreshed on every turn including continuation. */
	context?: ChildHostContext;
	/** Tool-free WT inbox/lifecycle service, present even with ambient extensions disabled. */
	protocol?(pi: ExtensionAPI, control: { phase(): "active" | "idle" | "boundary" }): void;
	settle?(child: ChildSession): Promise<void>;
	failStartup?(message: string): Promise<void>;
	bind(child: ChildSession): Promise<void>;
	claim(child: ChildSession, prompt: string): Promise<void>;
	finish(child: ChildSession, error?: unknown): Promise<void>;
	checkpoint?(child: ChildSession): Promise<void>;
}

export function createNativeInteractiveHost(options: Pick<DefaultChildSessionFactoryOptions, "loadPiCodingAgent"> & { binding?: NativeExecutionBinding; driver?: NativeHostDriver } = {}): NativeInteractiveHost {
	let claimed = false;
	let startupFailureSettled = false;
	let humanInputAllowed = false;
	let executing = false;
	let refreshingHooks = false;
	let humanIntervention: NativeHumanIntervention | undefined;
	let interventionMarker = randomUUID();
	let interventionFailure: unknown;
	const listeners = new Set<(event: ChildSessionEvent) => void>();
	let child: ChildSession | undefined;
	let runtime: AgentSessionRuntime | undefined;
	let continuation = false;
	let resourceContract: string | undefined;
	let modelContract: string | undefined;
	let installedHooks: ChildHookExtension[] | undefined;
	let onExtensionError: ChildSessionLaunch["onExtensionError"];
	const resources = (launch: ChildSessionLaunch) => JSON.stringify({ cwd: launch.cwd, model: launch.model, tools: launch.tools, excludeTools: launch.excludeTools, extensionPaths: launch.extensionPaths, ambientExtensions: launch.ambientExtensions, noSkills: launch.noSkills, noContextFiles: launch.noContextFiles, systemPrompt: launch.systemPrompt, appendSystemPrompt: launch.appendSystemPrompt, processEnv: launch.processEnv, capabilityCeiling: launch.runtime.capabilityCeiling, thinkingCeiling: launch.runtime.thinkingCeiling });
	const currentModel = () => runtime && JSON.stringify({ provider: runtime.session.model?.provider, id: runtime.session.model?.id, thinking: runtime.session.thinkingLevel, tools: runtime.session.getActiveToolNames() });
	const recovery = options.driver?.recovery;
	const factory = createDefaultChildSessionFactory({
		...options,
		...(recovery ? { nativeRecovery: recovery } : {}),
		retainSession: true,
		async sessionHost(pi, result, services) {
			if (recovery) {
				const session = result.session;
				if (`${session.model?.provider}/${session.model?.id}` !== recovery.modelId || session.thinkingLevel !== recovery.thinking) throw new Error("Cold SDK changed its observed model/thinking; no fallback.");
				// Block extension/UI prompts during startup BEFORE InteractiveMode
				// binds session_start handlers. An old queue is never resumed.
				const prompt = session.prompt.bind(session);
				session.prompt = async (...args) => { if (!executing && !humanInputAllowed) throw new Error("Cold native host has no newly claimed model dispatch permit."); return prompt(...args); };
				const steer = session.steer.bind(session);
				session.steer = async (...args) => { if (!executing && !humanInputAllowed) throw new Error("Cold native boundary does not accept queued steering."); return steer(...args); };
				const followUp = session.followUp.bind(session);
				session.followUp = async (...args) => { if (!executing && !humanInputAllowed) throw new Error("Cold native boundary does not accept queued follow-up."); return followUp(...args); };
			}
			// This constructor adopts the very session created above. A runtime
			// replacement is forbidden: WT owns one exact native conversation.
			runtime = new pi.AgentSessionRuntime(result.session, services, async () => {
				throw new Error("Retained native host cannot replace its conversation.");
			}, services.diagnostics, result.modelFallbackMessage);
			const bindExtensions = result.session.bindExtensions.bind(result.session);
			result.session.bindExtensions = async (binding) => bindExtensions({ ...binding, onError(error) {
				onExtensionError?.({ extensionPath: error.extensionPath, event: error.event, error: error.error });
				binding?.onError?.(error);
			} });
			const mode = new pi.InteractiveMode(runtime, { migratedProviders: [], initialMessages: [] });
			await mode.init();
			const session = result.session;
			// TUI controls do not go through input. Keep the admitted configuration
			// fixed while tracked, but permit runner-owned hook refresh and idle use.
			const controlsLocked = () => !humanInputAllowed && modelContract !== undefined;
			const rejectedControl = () => session.extensionRunner.getUIContext().notify("Tracked delegation keeps its admitted model, thinking, tools and resources. Text input can steer the task.", "warning");
			const setModel = session.setModel.bind(session);
			session.setModel = async (...args) => { if (controlsLocked()) { rejectedControl(); return; } await setModel(...args); };
			const cycleModel = session.cycleModel.bind(session);
			session.cycleModel = async (...args) => { if (controlsLocked()) { rejectedControl(); return undefined; } return cycleModel(...args); };
			const setThinking = session.setThinkingLevel.bind(session);
			session.setThinkingLevel = (...args) => { if (controlsLocked()) { rejectedControl(); return; } setThinking(...args); };
			const cycleThinking = session.cycleThinkingLevel.bind(session);
			session.cycleThinkingLevel = (...args) => { if (controlsLocked()) { rejectedControl(); return undefined; } return cycleThinking(...args); };
			const setTools = session.setActiveToolsByName.bind(session);
			session.setActiveToolsByName = (...args) => { if (controlsLocked() && !refreshingHooks) { rejectedControl(); return; } setTools(...args); };
			const reload = session.reload.bind(session);
			session.reload = async (...args) => { if (controlsLocked() && !refreshingHooks) { rejectedControl(); return; } await reload(...args); };
			result.session.subscribe((event) => {
				if (event.type === "message_start" && event.message.role === "user" && humanIntervention) {
					const text = extractTextFromContent(event.message.content);
					if (text.startsWith(`[Human intervention ${interventionMarker}:`)) {
						humanIntervention = { ...humanIntervention, delivered: humanIntervention.delivered + 1 };
						for (const listener of listeners) listener({ type: "native_human_intervention", humanIntervention: { ...humanIntervention } });
					}
				}
				if (event.type === "agent_end" && humanInputAllowed && child) void options.driver?.checkpoint?.(child).catch((error) => { console.error("Retained native checkpoint failed; refusing to keep an untracked host alive.", error); process.exit(1); });
			});
			void mode.run().catch(async () => { await runtime?.dispose(); });
		},
	});
	return {
		get child() { return child; },
		get startupFailureSettled() { return startupFailureSettled; },
		beginContinuation(binding, driver) {
			const previous = options.binding;
			if (!humanInputAllowed || continuation || !child || !previous || binding.jobId !== previous.jobId || binding.previousTurnId !== previous.turnId || binding.provider !== previous.provider || binding.parentSessionId !== previous.parentSessionId || binding.ownerSessionId !== previous.ownerSessionId || binding.nativeId !== child.sessionId || binding.sessionFile !== child.sessionFile) throw new Error("Retained native continuation identity or turn order mismatch.");
			humanInputAllowed = false;
			humanIntervention = undefined;
			interventionFailure = undefined;
			interventionMarker = randomUUID();
			continuation = true;
			options.binding = binding;
			options.driver = driver;
		},
		async create(launch) {
			if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Native interactive host requires a real terminal; headless fallback is forbidden.");
			if (claimed && !continuation) throw new Error("Native interactive host already owns a conversation; opening a second SDK writer is forbidden.");
			if ((!continuation && !recovery && launch.storage.kind === "file" && fs.existsSync(launch.storage.sessionFile)) || launch.storage.kind === "memory") throw new Error("Native interactive host initial launch requires a fresh persistent conversation.");
			if (recovery && !continuation && (recovery.version !== 1 || options.binding?.nativeId !== recovery.expected.nativeId || options.binding?.sessionFile !== recovery.expected.sessionFile || !options.binding?.previousTurnId)) throw new Error("Explicit cold host requires its exact admitted original native binding and tool set.");
			claimed = true;
			onExtensionError = launch.onExtensionError;
			// Host guards are additional hooks, not ambient WT tools. Role hooks
			// and their closure-backed captures remain in this runner process.
			const guarded = { ...launch, hooks: [...launch.hooks, createChildHostContextHook((input) => options.driver?.context?.(input)), {
				name: "pi-subagents:retained-native-identity",
				factory(pi: ExtensionAPI) {
					options.driver?.protocol?.(pi, { phase: () => humanInputAllowed ? "idle" : executing && runtime?.session.isStreaming ? "active" : "boundary" });
					pi.on("session_before_switch", () => ({ cancel: true }));
					pi.on("session_before_fork", () => ({ cancel: true }));
					pi.on("session_before_tree", () => ({ cancel: true }));
					pi.on("input", async (event, ctx) => {
						if (humanInputAllowed || event.source === "extension") return;
						const session = runtime?.session;
						if (!executing || !session?.isStreaming || event.source !== "interactive") {
							ctx.ui.notify("Input not queued: native dispatch/reload or result publication is in progress. Retry when the task is running or tracking is released.", "warning");
							setTimeout(() => { ctx.ui.setEditorText(event.text); }, 0);
							return { action: "handled" };
						}
						try {
							const accepted = (humanIntervention?.accepted ?? 0) + 1;
							const text = `[Human intervention ${interventionMarker}:${accepted}; not a parent instruction; existing role, capabilities and acceptance still apply]\n${event.text}`;
							// Enqueue synchronously before yielding: returning continue would
							// allow the original run to settle between input and SDK preflight.
							const queued = session.steer(text, event.images);
							const now = Date.now();
							humanIntervention = { source: "interactive", accepted, delivered: humanIntervention?.delivered ?? 0, firstAcceptedAt: humanIntervention?.firstAcceptedAt ?? now, lastAcceptedAt: now };
							pi.appendEntry("pi-subagents:human-intervention", { ...humanIntervention, jobId: options.binding?.jobId, turnId: options.binding?.turnId, marker: interventionMarker });
							for (const listener of listeners) listener({ type: "native_human_intervention", humanIntervention: { ...humanIntervention } });
							await queued;
							ctx.ui.notify("Human intervention queued as steering for this delegated task; recorded in its result.", "info");
						} catch (error) {
							// Input hook errors are otherwise fail-open in Pi. Never fall
							// through to an uncontrolled prompt after a tracking failure.
							interventionFailure = error;
							ctx.ui.notify("Human steering could not be recorded/delivered; this delegated turn will fail. Inspect the transcript before retrying.", "error");
							void session.abort();
						}
						return { action: "handled" };
					});
				},
			}] };
			let created: ChildSession;
			const continuing = continuation;
			continuation = false;
			if (continuing) {
				if (!child || !runtime || !installedHooks || resources(launch) !== resourceContract || currentModel() !== modelContract || launch.storage.kind !== "file" || launch.storage.sessionFile !== child.sessionFile) throw new Error("Retained native resource/model/tool contract changed; continuation rejected.");
				await runtime.session.waitForIdle();
				// Reload hooks on the SAME AgentSession/SessionManager. New captures
				// and supervisor metadata are local; no second SDK writer is created.
				installedHooks.splice(0, installedHooks.length, ...guarded.hooks);
				refreshingHooks = true;
				try { await runtime.session.reload(); } finally { refreshingHooks = false; }
				if (currentModel() !== modelContract) throw new Error("Retained native runtime changed during hook refresh.");
				created = child;
			} else {
				installedHooks = guarded.hooks;
				try { created = await factory.create(guarded); }
				catch (error) { try { await options.driver?.failStartup?.(String(error)); startupFailureSettled = true; } finally { await runtime?.dispose(); } throw error; }
				resourceContract = resources(launch);
				modelContract = currentModel();
			}
			if (options.binding) {
				if (!created.sessionFile || !options.driver) throw new Error("Native host requires a durable transcript and binding driver.");
				const recordFile = `${created.sessionFile}.native-host.json`;
				const record = JSON.stringify({ ...options.binding, hostPid: process.pid, nativeId: created.sessionId, sessionFile: created.sessionFile, ...(recovery ? { coldEpoch: { version: 1, leaseId: recovery.leaseId } } : {}) });
				if (recovery && !continuing) {
					if (created.sessionId !== recovery.expected.nativeId || created.sessionFile !== recovery.expected.sessionFile || created.nativeLeaf !== recovery.expected.leaf) throw new Error("Actual cold SDK identity/leaf changed before publication.");
					if (createHash("sha256").update(fs.readFileSync(recordFile)).digest("hex") !== recovery.sidecarDigest) throw new Error("Original cold host record changed before publication.");
					const temporary = `${recordFile}.${recovery.leaseId}.tmp`;
					fs.writeFileSync(temporary, record, { flag: "wx", mode: 0o600 });
					fs.renameSync(temporary, recordFile);
				} else fs.writeFileSync(recordFile, record, { flag: continuing ? "w" : "wx", mode: 0o600 });
				if (!continuing) {
					try { await options.driver.bind(created); }
					catch (error) { try { await options.driver.failStartup?.(String(error)); startupFailureSettled = true; } finally { await runtime?.dispose(); } throw error; }
				}
			}
			child = created;
			let dispatched = false;
			return {
				...created,
				get messages() { return created.messages; },
				get nativeLeaf() { return created.nativeLeaf; },
				get humanIntervention() { return humanIntervention ? { ...humanIntervention } : undefined; },
				get hasPendingNativeWork() { return executing; },
				subscribe(listener) {
					listeners.add(listener);
					const unsubscribe = created.subscribe(listener);
					return () => { listeners.delete(listener); unsubscribe(); };
				},
				async prompt(text) {
					if (dispatched) throw new Error("Native host turn already dispatched; replay is forbidden.");
					dispatched = true;
					try { await options.driver?.claim(created, text); }
					catch (error) { await options.driver?.failStartup?.(String(error)); throw error; }
					let failure: unknown;
					executing = true;
					try {
						await created.prompt(text);
						await runtime?.session.waitForIdle();
						if (interventionFailure !== undefined) throw interventionFailure;
						if (runtime?.session.pendingMessageCount || humanIntervention && humanIntervention.accepted !== humanIntervention.delivered) throw new Error("Native human steering was not fully delivered; refusing successful completion.");
					} catch (error) { failure = error; }
					finally { executing = false; }
					try { await options.driver?.settle?.(created); } catch (error) { failure ??= error; }
					await options.driver?.finish({ ...created, humanIntervention: humanIntervention ? { ...humanIntervention } : undefined }, failure);
					if (failure !== undefined) throw failure;
				},
			};
		},
		async dispose() { humanInputAllowed = true; },
		async close() { await runtime?.dispose(); },
	};
}
