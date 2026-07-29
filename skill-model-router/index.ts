// ~/.config/opencode/plugins/skill-model-router/index.ts
//
// "Model per skill" for opencode, in the style of Claude Code's `model:` frontmatter.
// Scans skills (project + global) and, for each SKILL.md that declares a model in
// `metadata.model`, registers a custom tool `skill_<name>` that executes that skill
// in a child session with that model (e.g. a local model from LM Studio / llama.cpp).
//
// Full documentation: README.md in this folder.
// Pure and testable logic: lib.ts (tests in lib.test.ts).

import { type Plugin, tool } from "@opencode-ai/plugin";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
	type RouterConfig,
	type SkillDef,
	buildChildPrompt,
	displayModel,
	isRouted,
	mergeConfig,
	parseSkill,
	routedModel,
	splitModel,
	toolName,
} from "./lib";

// ---------------------------------------------------------------------------
// I/O helpers
// ---------------------------------------------------------------------------

async function loadConfig(
	options?: Record<string, unknown>,
): Promise<RouterConfig> {
	let fileConfig = {};
	try {
		const raw = await readFile(
			fileURLToPath(new URL("./config.json", import.meta.url)),
			"utf8",
		);
		fileConfig = JSON.parse(raw);
	} catch {} // without config.json (or invalid): defaults
	return mergeConfig(fileConfig, options as any);
}

async function discoverSkills(dirs: string[]): Promise<Map<string, SkillDef>> {
	const skills = new Map<string, SkillDef>();
	for (const dir of dirs) {
		const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
		for (const e of entries) {
			if (!e.isDirectory() || skills.has(e.name)) continue;
			const raw = await readFile(
				path.join(dir, e.name, "SKILL.md"),
				"utf8",
			).catch(() => undefined);
			if (!raw) continue;
			const s = parseSkill(raw);
			if (s) skills.set(s.name, s);
		}
	}
	return skills;
}

async function providerHealthy(
	client: any,
	providerID: string,
	timeoutMs: number,
): Promise<boolean> {
	try {
		const cfg = await client.config.get();
		const baseURL: string | undefined =
			cfg.data?.provider?.[providerID]?.options?.baseURL;
		if (!baseURL) return true; // provider cloud: without local endpoint to health-check, assume it's healthy
		const res = await fetch(`${baseURL.replace(/\/$/, "")}/models`, {
			signal: AbortSignal.timeout(timeoutMs),
		});
		return res.ok;
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export const SkillModelRouter: Plugin = async (
	{ client, directory },
	options,
) => {
	const cfg = await loadConfig(options);

	const toast = async (message: string, variant: "info" | "warning") => {
		if (!cfg.toast.enabled) return;
		// The toast only exists when there is a TUI; it fails in headless/server mode and we ignore it.
		try {
			await client.tui.showToast({
				body: {
					title: "skill-model-router",
					message,
					variant,
					duration: cfg.toast.duration,
				},
			});
		} catch {}
	};

	const skills = await discoverSkills([
		path.join(directory, ".opencode", "skills"),
		path.join(homedir(), ".config", "opencode", "skills"),
	]);

	// reasoning_effort per child session: the prompt API does not accept model
	// options per request, so we inject them into the child session's LLM call
	// via the chat.params hook (the same passthrough used by the agents'
	// reasoningEffort field).
	const effortBySession = new Map<string, string>();

	// Sesiones hijas activas del router: sus permission asks se deniegan
	// automaticamente (nadie mira la sesion hija; un "ask" pendiente la
	// bloquearia para siempre y el tool call se quedaria colgado).
	const childSessions = new Set<string>();

	const routed = [...skills.values()].filter(isRouted);
	const byTool = new Map(routed.map((s) => [toolName(s.name), s] as const));

	// ---------------------------------------------------------------------
	// Prompt stash (display.hidePrompt)
	//
	// opencode's TUI renders plugin tools with a hardcoded generic
	// `name [key=value]` header and ignores the tool part's title, so the only
	// lever we have over that line is the arguments themselves. In
	// `tool.execute.before` we therefore swap the `prompt` argument for a short
	// `model` argument; the real prompt is parked here and handed to execute().
	//
	// execute()'s ToolContext does not declare a callID, so we key by callID
	// when the runtime happens to expose one and fall back to a per
	// session+tool FIFO otherwise. The FIFO can only mismatch if the SAME skill
	// tool is invoked twice concurrently in the same session, in which case the
	// two prompts swap places — no data is lost.
	// ---------------------------------------------------------------------
	const STASH_TTL_MS = 10 * 60 * 1000;
	const stash = new Map<string, { prompt: string; at: number }>();
	const queues = new Map<string, string[]>();

	const stashPrompt = (sessionID: string, tool: string, callID: string, prompt: string) => {
		const cutoff = Date.now() - STASH_TTL_MS;
		for (const [k, v] of stash) if (v.at < cutoff) stash.delete(k);
		stash.set(callID, { prompt, at: Date.now() });
		const key = `${sessionID}:${tool}`;
		const queue = queues.get(key);
		if (queue) queue.push(callID);
		else queues.set(key, [callID]);
	};

	const takePrompt = (sessionID: string, tool: string, callID?: string): string | undefined => {
		const key = `${sessionID}:${tool}`;
		const queue = queues.get(key);
		// Exact match when the runtime exposes a callID; otherwise the oldest
		// queued call whose entry is still alive (TTL pruning can leave stale ids).
		let id: string | undefined;
		if (callID && stash.has(callID)) id = callID;
		else if (queue) while (queue.length > 0 && !stash.has(queue[0]!)) queue.shift();
		id ??= queue?.[0];
		if (queue) {
			const at = id ? queue.indexOf(id) : -1;
			if (at >= 0) queue.splice(at, 1);
			if (queue.length === 0) queues.delete(key);
		}
		if (!id) return undefined;
		const entry = stash.get(id);
		stash.delete(id);
		return entry?.prompt;
	};

	// Tools deshabilitados en las sesiones hijas: los propios skill_* (evita
	// recursion) y task (una skill ruteada es texto-entra/texto-sale, no un
	// orquestador de subagentes).
	const disabledTools: Record<string, boolean> = Object.fromEntries([
		...routed.map((s) => [toolName(s.name), false] as const),
		["task", false] as const,
	]);

	const tools: Record<string, ReturnType<typeof tool>> = {};

	for (const skill of routed) {
		tools[toolName(skill.name)] = tool({
			description: [
				`${skill.description} (skill "${skill.name}", runs on ${routedModel(skill) ?? "the session's default model"}${skill.fallback ? `, falls back to ${skill.fallback}` : ""})`,
				...(cfg.display.hidePrompt
					? [
							"",
							"Recorded call: once dispatched, this tool call is rewritten in the",
							"history to show `model=<the model that ran>` instead of `prompt`.",
							"The prompt was delivered in full — it is redacted from the record for",
							"readability. Never re-send a call because its prompt looks missing.",
						]
					: []),
			].join("\n"),
			args: {
				prompt: tool.schema
					.string()
					.describe(
						"Full task or question for this skill. Include all necessary context: the child session cannot see this conversation.",
					),
			},
			async execute(args, ctx) {
				// With display.hidePrompt on, `prompt` was stripped from args by
				// the tool.execute.before hook and parked in the stash.
				const task =
					typeof args.prompt === "string" && args.prompt
						? args.prompt
						: takePrompt(
								ctx.sessionID,
								toolName(skill.name),
								(ctx as { callID?: string }).callID,
							);
				if (!task) {
					ctx.metadata({ title: `${skill.name} (no prompt)` });
					return `Error: no prompt reached skill "${skill.name}". If this persists, set "display": { "hidePrompt": false } in the skill-model-router config.json.`;
				}
				const text = buildChildPrompt(skill, skills, task);

				// 1. Model selection with health-check and fallback. If no model is
				//    pinned (metadata.model absent or "default"), the child session
				//    is created without an explicit model and opencode uses the
				//    globally selected model.
				const pinned = routedModel(skill);
				const primary = pinned ? splitModel(pinned) : undefined;
				const fallback = skill.fallback
					? splitModel(skill.fallback)
					: undefined;
				const primaryHealthy = primary
					? await providerHealthy(
							client,
							primary.providerID,
							cfg.healthcheck.timeout * 1000,
						)
					: true;
				type Candidate = {
					model?: { providerID: string; modelID: string };
					label: string;
					role: "primary" | "fallback";
				};
				const candidates: Candidate[] = [];
				if (primaryHealthy)
					candidates.push({
						model: primary,
						label: pinned ?? "default (session model)",
						role: "primary",
					});
				if (fallback)
					candidates.push({
						model: fallback,
						label: skill.fallback!,
						role: "fallback",
					});
				if (candidates.length === 0) {
					ctx.metadata({
						title: `${skill.name} (unavailable: ${primary!.providerID} unreachable)`,
					});
					await toast(
						`${skill.name}: ${primary!.providerID} unreachable, no fallback`,
						"warning",
					);
					return `Error: provider "${primary!.providerID}" for skill "${skill.name}" is unreachable and no metadata.fallback_model is declared. Is the local model server running?`;
				}

				// 2. Runs in a child session; if the candidate fails or exceeds the
				//    generation.timeout, the generation is aborted and the next candidate is tried.
				const errors: string[] = [];
				for (const candidate of candidates) {
					const { model, label: full } = candidate;
					const isFallback = candidate.role === "fallback";
					const why = isFallback
						? primaryHealthy
							? `fallback: ${pinned ?? "session model"} failed`
							: `fallback: ${primary!.providerID} unreachable`
						: "primary";

					// parentID: la sesion nace como hija de la sesion que invoca el
					// tool -> no aparece en la lista raiz de /sessions (el TUI filtra
					// parentID === undefined) y es navegable como las del task tool.
					const session = await client.session.create({
						body: {
							parentID: ctx.sessionID,
							title: `skill:${skill.name} (${full})`,
						},
					});
					const id = session.data?.id;
					if (!id) {
						errors.push(`${full}: could not create child session`);
						continue;
					}
					if (skill.reasoningEffort)
						effortBySession.set(id, skill.reasoningEffort);
					childSessions.add(id);

					let result;
					try {
						result = await client.session.prompt({
							path: { id },
							body: {
								...(model ? { model } : {}),
								tools: disabledTools,
								parts: [{ type: "text", text }],
							},
							...(cfg.generation.timeout > 0
								? { signal: AbortSignal.timeout(cfg.generation.timeout * 1000) }
								: {}),
						});
					} catch (e: any) {
						// Timeout or network error: abort the generation on the server so
						// it does not continue running in the background, and try the next one.
						await client.session.abort({ path: { id } }).catch(() => {});
						const timedOut =
							e?.name === "TimeoutError" || e?.name === "AbortError";
						errors.push(
							`${full}: ${timedOut ? `timed out after ${cfg.generation.timeout}s` : String(e)}`,
						);
						continue;
					} finally {
						effortBySession.delete(id);
						childSessions.delete(id);
					}
					if (result.error) {
						errors.push(`${full}: ${JSON.stringify(result.error)}`);
						continue;
					}
					const info: any = result.data?.info;
					const output = (result.data?.parts ?? [])
						.filter((p: any) => p.type === "text")
						.map((p: any) => p.text)
						.join("\n");
					if (output) {
						// Title of the tool part (visible in the status line and in metadata;
						// the "generic" TUI renderer doesn't paint it in the header, as of today).
						ctx.metadata({
							title: `${skill.name} (${full}${isFallback ? ", fallback" : ""})`,
							// `prompt` is kept here on purpose: with display.hidePrompt on
							// it is no longer in the recorded args, and the metadata is the
							// only machine-readable copy on the parent-session side (the
							// human-readable one is the child session itself).
							metadata: { skill: skill.name, model: full, via: why, prompt: task },
						});
						await toast(
							`${skill.name} → ${full}${isFallback ? ` (${why})` : ""}`,
							isFallback ? "warning" : "info",
						);
						return output;
					}
					// No text came back: surface the real reason from the assistant
					// message (e.g. "model not loaded" from the local provider).
					const detail = info?.error
						? ` — ${JSON.stringify(info.error).slice(0, 300)}`
						: "";
					errors.push(`${full}: empty output${detail}`);
				}
				ctx.metadata({ title: `${skill.name} (failed on all models)` });
				await toast(
					`${skill.name}: all models failed — ${errors[0]?.slice(0, 140) ?? "unknown"}`,
					"warning",
				);
				return `Error running skill "${skill.name}". Attempts:\n${errors.join("\n")}`;
			},
		});
	}

	return {
		tool: tools,
		// Keeps the prompt out of the TUI's generic tool header: swaps the
		// `prompt` argument for a short `model` one and parks the real prompt in
		// the stash for execute(). Mutate properties only — replacing
		// output.args wholesale is ignored by the core.
		"tool.execute.before": async (input, output) => {
			if (!cfg.display.hidePrompt) return;
			const skill = byTool.get(input.tool);
			if (!skill) return;
			const prompt = output.args?.prompt;
			if (typeof prompt !== "string" || !prompt) return;
			stashPrompt(input.sessionID, input.tool, input.callID, prompt);
			delete output.args.prompt;
			output.args.model = displayModel(skill);
		},
		// Injects reasoning_effort into LLM calls of our child sessions.
		"chat.params": async (input, output) => {
			const effort = effortBySession.get(input.sessionID);
			if (effort && output?.options) output.options.reasoningEffort = effort;
		},
		// Deniega los permission asks de las sesiones hijas del router: no hay
		// humano mirandolas, y un ask pendiente colgaria el tool call para
		// siempre. El modelo recibe el deny y responde solo con texto.
		"permission.ask": async (input, output) => {
			if (childSessions.has(input.sessionID)) output.status = "deny";
		},
	};
};
