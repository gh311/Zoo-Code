import { WebviewFocusTracker } from "../WebviewFocusTracker"
// npx vitest run core/webview/__tests__/ClineProvider.sticky-profile.spec.ts

import * as vscode from "vscode"
import { makeCompositeDisposable } from "../../../test-utils/vscode"
import { TelemetryService } from "@roo-code/telemetry"
import { ClineProvider } from "../ClineProvider"
import { Task } from "../../task/Task"
import { ContextProxy } from "../../config/ContextProxy"
import type { HistoryItem, ProviderName } from "@roo-code/types"
import { providerIdentifiers } from "@roo-code/types/provider-identifiers"

vi.mock("vscode", () => ({
	ExtensionContext: vi.fn(),
	OutputChannel: vi.fn(),
	WebviewView: vi.fn(),
	Disposable: { from: (...subscriptions: vscode.Disposable[]) => makeCompositeDisposable(...subscriptions) },
	Uri: {
		joinPath: vi.fn(),
		file: vi.fn(),
	},
	CodeActionKind: {
		QuickFix: { value: "quickfix" },
		RefactorRewrite: { value: "refactor.rewrite" },
	},
	commands: {
		executeCommand: vi.fn().mockResolvedValue(undefined),
	},
	window: {
		showInformationMessage: vi.fn(),
		showWarningMessage: vi.fn(),
		showErrorMessage: vi.fn(),
		onDidChangeActiveTextEditor: vi.fn(() => ({ dispose: vi.fn() })),
	},
	workspace: {
		getConfiguration: vi.fn().mockReturnValue({
			get: vi.fn().mockReturnValue([]),
			update: vi.fn(),
		}),
		onDidChangeConfiguration: vi.fn().mockImplementation(() => {
			return {
				dispose: vi.fn(),
			}
		}),
		onDidSaveTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
		onDidChangeTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
		onDidOpenTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
		onDidCloseTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
	},
	env: {
		uriScheme: "vscode",
		language: "en",
		appName: "Visual Studio Code",
	},
	ExtensionMode: {
		Production: 1,
		Development: 2,
		Test: 3,
	},
	version: "1.85.0",
}))

// Create a counter for unique task IDs.
let taskIdCounter = 0

vi.mock("../../task/Task", () => ({
	Task: vi.fn().mockImplementation(function (options) {
		return {
			taskId: options.taskId || `test-task-id-${++taskIdCounter}`,
			saveClineMessages: vi.fn(),
			clineMessages: [],
			apiConversationHistory: [],
			overwriteClineMessages: vi.fn(),
			overwriteApiConversationHistory: vi.fn(),
			abortTask: vi.fn(),
			handleWebviewAskResponse: vi.fn(),
			getTaskNumber: vi.fn().mockReturnValue(0),
			setTaskNumber: vi.fn(),
			setParentTask: vi.fn(),
			setRootTask: vi.fn(),
			emit: vi.fn(),
			parentTask: options.parentTask,
			updateApiConfiguration: vi.fn(),
			setTaskApiConfigName: vi.fn(),
			_taskApiConfigName: options.historyItem?.apiConfigName,
			taskApiConfigName: options.historyItem?.apiConfigName,
		}
	}),
}))

vi.mock("../../prompts/sections/custom-instructions")

vi.mock("../../../utils/safeWriteJson")

vi.mock("../../../api", () => ({
	buildApiHandler: vi.fn().mockReturnValue({
		getModel: vi.fn().mockReturnValue({
			id: "claude-3-sonnet",
		}),
	}),
}))

vi.mock("../../../integrations/workspace/WorkspaceTracker", () => ({
	default: vi.fn().mockImplementation(function () {
		return {
			initializeFilePaths: vi.fn(),
			dispose: vi.fn(),
		}
	}),
}))

vi.mock("../../diff/strategies/multi-search-replace", () => ({
	MultiSearchReplaceDiffStrategy: vi.fn().mockImplementation(function () {
		return {
			getName: () => "test-strategy",
			applyDiff: vi.fn(),
		}
	}),
}))

// A stable CloudService instance mock. A test can control getAllowList, so it
// can land a profile switch inside the await that getState() runs after it
// snapshots the provider settings (PR 2649 review round 2).
const cloudServiceMock = vi.hoisted(() => ({
	isAuthenticated: vi.fn().mockReturnValue(false),
	// The default keeps the prior harness behavior: getState() catches the
	// throw and falls back to the organization allow-all list.
	getAllowList: vi.fn<() => Promise<unknown>>(() => {
		throw new Error("getAllowList is not configured for this test")
	}),
}))

vi.mock("@roo-code/cloud", () => ({
	CloudService: {
		hasInstance: vi.fn().mockReturnValue(true),
		get instance() {
			return cloudServiceMock
		},
	},
	getRooCodeApiUrl: vi.fn().mockReturnValue("https://app.roocode.com"),
}))

vi.mock("../../../shared/modes", () => ({
	modes: [
		{
			slug: "code",
			name: "Code Mode",
			roleDefinition: "You are a code assistant",
			groups: ["read", "edit"],
		},
		{
			slug: "architect",
			name: "Architect Mode",
			roleDefinition: "You are an architect",
			groups: ["read", "edit"],
		},
	],
	getModeBySlug: vi.fn().mockReturnValue({
		slug: "code",
		name: "Code Mode",
		roleDefinition: "You are a code assistant",
		groups: ["read", "edit"],
	}),
	defaultModeSlug: "code",
}))

vi.mock("../../prompts/system", () => ({
	SYSTEM_PROMPT: vi.fn().mockResolvedValue("mocked system prompt"),
	codeMode: "code",
}))

vi.mock("../../../api/providers/fetchers/modelCache", () => ({
	getModels: vi.fn().mockResolvedValue({}),
	flushModels: vi.fn(),
}))

vi.mock("../../../integrations/misc/extract-text", () => ({
	extractTextFromFile: vi.fn().mockResolvedValue("Mock file content"),
}))

vi.mock("p-wait-for", () => ({
	default: vi.fn().mockImplementation(async () => Promise.resolve()),
}))

vi.mock("fs/promises", () => ({
	mkdir: vi.fn().mockResolvedValue(undefined),
	writeFile: vi.fn().mockResolvedValue(undefined),
	readFile: vi.fn().mockResolvedValue(""),
	readdir: vi.fn().mockResolvedValue([]),
	unlink: vi.fn().mockResolvedValue(undefined),
	rmdir: vi.fn().mockResolvedValue(undefined),
	access: vi.fn().mockResolvedValue(undefined),
	rm: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("../../../utils/storage", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../utils/storage")>()
	return {
		...actual,
		getStorageBasePath: vi.fn().mockImplementation((defaultPath: string) => {
			return defaultPath
		}),
		getSettingsDirectoryPath: vi.fn().mockResolvedValue("/test/settings/path"),
		getTaskDirectoryPath: vi.fn().mockResolvedValue("/test/task/path"),
	}
})

vi.mock("@roo-code/telemetry", () => ({
	TelemetryService: {
		hasInstance: vi.fn().mockReturnValue(true),
		createInstance: vi.fn(),
		get instance() {
			return {
				trackEvent: vi.fn(),
				trackError: vi.fn(),
				setProvider: vi.fn(),
				captureModeSwitch: vi.fn(),
			}
		},
	},
}))

describe("ClineProvider - Sticky Provider Profile", () => {
	let provider: ClineProvider
	let mockContext: vscode.ExtensionContext
	let mockOutputChannel: vscode.OutputChannel
	let mockWebviewView: vscode.WebviewView
	let mockPostMessage: any
	let originalRooCliRuntimeEnv: string | undefined

	beforeEach(async () => {
		vi.clearAllMocks()
		taskIdCounter = 0
		originalRooCliRuntimeEnv = process.env.ROO_CLI_RUNTIME
		delete process.env.ROO_CLI_RUNTIME

		if (!TelemetryService.hasInstance()) {
			TelemetryService.createInstance([])
		}

		const globalState: Record<string, string | undefined> = {
			mode: "code",
			currentApiConfigName: "default-profile",
		}

		const secrets: Record<string, string | undefined> = {}

		mockContext = {
			extensionPath: "/test/path",
			extensionUri: { fsPath: "/test/path" } as vscode.Uri,
			globalState: {
				get: vi.fn().mockImplementation((key: string) => {
					return globalState[key]
				}),
				update: vi.fn().mockImplementation((key: string, value: string | undefined) => {
					globalState[key] = value
					return Promise.resolve()
				}),
				keys: vi.fn().mockImplementation(() => {
					return Object.keys(globalState)
				}),
			},
			secrets: {
				get: vi.fn().mockImplementation((key: string) => {
					return secrets[key]
				}),
				store: vi.fn().mockImplementation((key: string, value: string | undefined) => {
					secrets[key] = value
					return Promise.resolve()
				}),
				delete: vi.fn().mockImplementation((key: string) => {
					delete secrets[key]
					return Promise.resolve()
				}),
			},
			workspaceState: {
				get: vi.fn().mockReturnValue(undefined),
				update: vi.fn().mockResolvedValue(undefined),
				keys: vi.fn().mockReturnValue([]),
			},
			subscriptions: [],
			extension: {
				packageJSON: { version: "1.0.0" },
			},
			globalStorageUri: {
				fsPath: "/test/storage/path",
			},
		} as unknown as vscode.ExtensionContext

		mockOutputChannel = {
			appendLine: vi.fn(),
			clear: vi.fn(),
			dispose: vi.fn(),
		} as unknown as vscode.OutputChannel

		mockPostMessage = vi.fn()

		mockWebviewView = {
			webview: {
				postMessage: mockPostMessage,
				html: "",
				options: {},
				onDidReceiveMessage: vi.fn(),
				asWebviewUri: vi.fn(),
				cspSource: "vscode-webview://test-csp-source",
			},
			visible: true,
			onDidDispose: vi.fn().mockImplementation(() => {
				return { dispose: vi.fn() }
			}),
			onDidChangeVisibility: vi.fn().mockImplementation(() => {
				return { dispose: vi.fn() }
			}),
		} as unknown as vscode.WebviewView

		provider = new ClineProvider(
			mockContext,
			mockOutputChannel,
			"sidebar",
			new ContextProxy(mockContext),
			new WebviewFocusTracker(),
		)

		// Wait for the async TaskHistoryStore initialization to complete
		await new Promise((resolve) => setTimeout(resolve, 10))

		// Mock getMcpHub method
		provider.getMcpHub = vi.fn().mockReturnValue({
			listTools: vi.fn().mockResolvedValue([]),
			callTool: vi.fn().mockResolvedValue({ content: [] }),
			listResources: vi.fn().mockResolvedValue([]),
			readResource: vi.fn().mockResolvedValue({ contents: [] }),
			getAllServers: vi.fn().mockReturnValue([]),
		})
	})

	afterEach(() => {
		if (originalRooCliRuntimeEnv === undefined) {
			delete process.env.ROO_CLI_RUNTIME
		} else {
			process.env.ROO_CLI_RUNTIME = originalRooCliRuntimeEnv
		}
	})

	describe("activateProviderProfile", () => {
		beforeEach(async () => {
			await provider.resolveWebviewView(mockWebviewView)
		})

		it("should save provider profile to task metadata when switching profiles", async () => {
			// Create a mock task
			const mockTask = {
				taskId: "test-task-id",
				_taskApiConfigName: "default-profile",
				setTaskApiConfigName: vi.fn(),
				emit: vi.fn(),
				saveClineMessages: vi.fn(),
				clineMessages: [],
				apiConversationHistory: [],
				updateApiConfiguration: vi.fn(),
			}

			// Add task to provider stack
			await provider.addClineToStack(mockTask as any)

			// Populate the store so persistStickyProviderProfileToCurrentTask finds the task
			await provider.taskHistoryStore.upsert({
				id: mockTask.taskId,
				ts: Date.now(),
				task: "Test task",
				number: 1,
				tokensIn: 0,
				tokensOut: 0,
				totalCost: 0,
			})

			// Mock updateTaskHistory to track calls
			const updateTaskHistorySpy = vi.spyOn(provider, "updateTaskHistory").mockImplementation(() => {
				return Promise.resolve([])
			})

			// Mock providerSettingsManager.activateProfile
			vi.spyOn(provider.providerSettingsManager, "activateProfile").mockResolvedValue({
				name: "new-profile",
				id: "new-profile-id",
				apiProvider: providerIdentifiers.anthropic,
			})

			// Mock providerSettingsManager.listConfig
			vi.spyOn(provider.providerSettingsManager, "listConfig").mockResolvedValue([
				{ name: "new-profile", id: "new-profile-id", apiProvider: providerIdentifiers.anthropic },
			])

			// Switch provider profile
			await provider.activateProviderProfile({ name: "new-profile" })

			// Verify task history was updated with new provider profile
			expect(updateTaskHistorySpy).toHaveBeenCalledWith(
				expect.objectContaining({
					id: mockTask.taskId,
					apiConfigName: "new-profile",
				}),
			)

			// Verify task's setTaskApiConfigName was called
			expect(mockTask.setTaskApiConfigName).toHaveBeenCalledWith("new-profile")
		})

		it.each([
			{ expectedCurrentTaskId: "test-task-id", applies: true },
			{ expectedCurrentTaskId: "other-task-id", applies: false },
		])(
			"expectedCurrentTaskId $expectedCurrentTaskId rebuilds and sticky-writes the current task: $applies",
			async ({ expectedCurrentTaskId, applies }) => {
				const currentTask = {
					taskId: "test-task-id",
					setTaskApiConfigName: vi.fn<(name: string) => void>(),
					updateApiConfiguration: vi.fn<(settings: unknown) => void>(),
					emit: vi.fn(),
				}
				// Supplies only the members that profile activation touches on the current task.
				vi.spyOn(provider, "getCurrentTask").mockReturnValue(currentTask as unknown as Task)
				await provider.taskHistoryStore.upsert({
					id: currentTask.taskId,
					ts: Date.now(),
					task: "Test task",
					number: 1,
					tokensIn: 0,
					tokensOut: 0,
					totalCost: 0,
				})
				const updateTaskHistorySpy = vi.spyOn(provider, "updateTaskHistory").mockResolvedValue([])
				vi.spyOn(provider.providerSettingsManager, "activateProfile").mockResolvedValue({
					name: "new-profile",
					id: "new-profile-id",
					apiProvider: providerIdentifiers.anthropic,
				})

				await provider.activateProviderProfile({ name: "new-profile" }, { expectedCurrentTaskId })

				expect(currentTask.updateApiConfiguration).toHaveBeenCalledTimes(applies ? 1 : 0)
				expect(currentTask.setTaskApiConfigName).toHaveBeenCalledTimes(applies ? 1 : 0)
				const stickyWrite = expect.objectContaining({ id: currentTask.taskId, apiConfigName: "new-profile" })
				if (applies) {
					expect(updateTaskHistorySpy).toHaveBeenCalledWith(stickyWrite)
				} else {
					expect(updateTaskHistorySpy).not.toHaveBeenCalled()
				}
			},
		)

		it.each([true, false])(
			"writes the mode default only when persistModeConfig is %s",
			async (persistModeConfig) => {
				vi.spyOn(provider.providerSettingsManager, "activateProfile").mockResolvedValue({
					name: "new-profile",
					id: "new-profile-id",
					apiProvider: providerIdentifiers.anthropic,
				})
				const setModeConfigSpy = vi.spyOn(provider.providerSettingsManager, "setModeConfig").mockResolvedValue()
				await provider.contextProxy.setValue("mode", "architect")

				await provider.activateProviderProfile(
					{ name: "new-profile" },
					{ persistModeConfig, expectedCurrentTaskId: "test-task-id" },
				)

				if (persistModeConfig) {
					expect(setModeConfigSpy).toHaveBeenCalledExactlyOnceWith("architect", "new-profile-id")
				} else {
					expect(setModeConfigSpy).not.toHaveBeenCalled()
				}
			},
		)

		it("should update task's taskApiConfigName property when switching profiles", async () => {
			// Create a mock task with initial profile
			const mockTask = {
				taskId: "test-task-id",
				_taskApiConfigName: "default-profile",
				setTaskApiConfigName: vi.fn().mockImplementation(function (this: any, name: string) {
					this._taskApiConfigName = name
				}),
				emit: vi.fn(),
				saveClineMessages: vi.fn(),
				clineMessages: [],
				apiConversationHistory: [],
				updateApiConfiguration: vi.fn(),
			}

			// Add task to provider stack
			await provider.addClineToStack(mockTask as any)

			// Mock getGlobalState to return task history
			vi.spyOn(provider as any, "getGlobalState").mockReturnValue([
				{
					id: mockTask.taskId,
					ts: Date.now(),
					task: "Test task",
					number: 1,
					tokensIn: 0,
					tokensOut: 0,
					cacheWrites: 0,
					cacheReads: 0,
					totalCost: 0,
				},
			])

			// Mock updateTaskHistory
			vi.spyOn(provider, "updateTaskHistory").mockImplementation(() => {
				return Promise.resolve([])
			})

			// Mock providerSettingsManager.activateProfile
			vi.spyOn(provider.providerSettingsManager, "activateProfile").mockResolvedValue({
				name: "new-profile",
				id: "new-profile-id",
				apiProvider: providerIdentifiers.openrouter,
			})

			// Mock providerSettingsManager.listConfig
			vi.spyOn(provider.providerSettingsManager, "listConfig").mockResolvedValue([
				{ name: "new-profile", id: "new-profile-id", apiProvider: providerIdentifiers.openrouter },
			])

			// Switch provider profile
			await provider.activateProviderProfile({ name: "new-profile" })

			// Verify task's _taskApiConfigName property was updated
			expect(mockTask._taskApiConfigName).toBe("new-profile")
		})

		it("should update in-memory task profile even if task history item does not exist yet", async () => {
			await provider.resolveWebviewView(mockWebviewView)

			const mockTask = {
				taskId: "test-task-id",
				_taskApiConfigName: "default-profile",
				setTaskApiConfigName: vi.fn().mockImplementation(function (this: any, name: string) {
					this._taskApiConfigName = name
				}),
				emit: vi.fn(),
				saveClineMessages: vi.fn(),
				clineMessages: [],
				apiConversationHistory: [],
				updateApiConfiguration: vi.fn(),
			}

			await provider.addClineToStack(mockTask as any)

			// No history item exists yet
			vi.spyOn(provider as any, "getGlobalState").mockReturnValue([])

			const updateTaskHistorySpy = vi.spyOn(provider, "updateTaskHistory").mockImplementation(() => {
				return Promise.resolve([])
			})

			vi.spyOn(provider.providerSettingsManager, "activateProfile").mockResolvedValue({
				name: "new-profile",
				id: "new-profile-id",
				apiProvider: providerIdentifiers.openrouter,
			})

			vi.spyOn(provider.providerSettingsManager, "listConfig").mockResolvedValue([
				{ name: "new-profile", id: "new-profile-id", apiProvider: providerIdentifiers.openrouter },
			])

			await provider.activateProviderProfile({ name: "new-profile" })

			// In-memory should still update, even without a history item.
			expect(mockTask._taskApiConfigName).toBe("new-profile")
			// No history item => no updateTaskHistory call.
			expect(updateTaskHistorySpy).not.toHaveBeenCalled()
		})
	})

	describe("createTaskWithHistoryItem", () => {
		it("should restore provider profile from history item when reopening task outside CLI runtime", async () => {
			await provider.resolveWebviewView(mockWebviewView)

			// Create a history item with saved provider profile
			const historyItem: HistoryItem = {
				id: "test-task-id",
				number: 1,
				ts: Date.now(),
				task: "Test task",
				tokensIn: 100,
				tokensOut: 200,
				cacheWrites: 0,
				cacheReads: 0,
				totalCost: 0.001,
				mode: "code",
				apiConfigName: "saved-profile", // Saved provider profile
			}

			// Mock activateProviderProfile to track calls
			const activateProviderProfileSpy = vi
				.spyOn(provider, "activateProviderProfile")
				.mockResolvedValue(undefined)

			// Mock providerSettingsManager.listConfig
			vi.spyOn(provider.providerSettingsManager, "listConfig").mockResolvedValue([
				{ name: "saved-profile", id: "saved-profile-id", apiProvider: providerIdentifiers.anthropic },
			])

			// Initialize task with history item
			await provider.createTaskWithHistoryItem(historyItem)

			// Verify provider profile was restored via activateProviderProfile (restore-only: don't persist mode config)
			expect(activateProviderProfileSpy).toHaveBeenCalledWith(
				{ name: "saved-profile" },
				{ persistModeConfig: false, persistTaskHistory: false, expectedCurrentTaskId: historyItem.id },
			)
		})

		it("keeps the user's current provider profile when it differs from the task's stale saved profile (#970)", async () => {
			await provider.resolveWebviewView(mockWebviewView)

			// The task last ran on "saved-profile" (a 128k provider). The user stopped
			// the task, then switched to "current-profile" (a 256k provider).
			const historyItem: HistoryItem = {
				id: "test-task-id",
				number: 1,
				ts: Date.now(),
				task: "Test task",
				tokensIn: 100,
				tokensOut: 200,
				cacheWrites: 0,
				cacheReads: 0,
				totalCost: 0.001,
				mode: "code",
				apiConfigName: "saved-profile",
			}

			await provider.contextProxy.setValue("currentApiConfigName", "current-profile")
			// Seed the active settings the current profile's activation would have
			// written: a distinct provider and model, so stale settings supplied under
			// the correct profile name cannot pass the assertions below
			// (PR 2649 review round 1).
			await provider.contextProxy.setValue("apiProvider", providerIdentifiers.openai)
			await provider.contextProxy.setValue("apiModelId", "gpt-current-256k")

			const activateProviderProfileSpy = vi
				.spyOn(provider, "activateProviderProfile")
				.mockResolvedValue(undefined)

			vi.spyOn(provider.providerSettingsManager, "listConfig").mockResolvedValue([
				{ name: "saved-profile", id: "saved-profile-id", apiProvider: providerIdentifiers.anthropic },
				{ name: "current-profile", id: "current-profile-id", apiProvider: providerIdentifiers.openai },
			])

			await provider.createTaskWithHistoryItem(historyItem)

			// The stale profile must not be reactivated over the user's choice.
			expect(activateProviderProfileSpy).not.toHaveBeenCalledWith({ name: "saved-profile" }, expect.anything())

			// The task's saved profile is corrected, so the restored task and its
			// header context limit follow the user's current profile. The
			// correction lives on the copy handed to the Task (round 4: the
			// cached entry is never mutated in place).
			const taskOptions = vi.mocked(Task).mock.calls.at(-1)?.[0]
			expect(taskOptions?.historyItem?.apiConfigName).toBe("current-profile")

			// The restored task serves the current profile's exact settings, never
			// the saved profile's configuration.
			expect(taskOptions?.apiConfiguration?.apiProvider).toBe(providerIdentifiers.openai)
			expect(taskOptions?.apiConfiguration?.apiModelId).toBe("gpt-current-256k")
			expect(taskOptions?.apiConfiguration?.apiModelId).not.toBe("claude-saved-128k")
		})

		it("restores the saved profile when the user has not switched since the task stopped", async () => {
			await provider.resolveWebviewView(mockWebviewView)

			const historyItem: HistoryItem = {
				id: "test-task-id",
				number: 1,
				ts: Date.now(),
				task: "Test task",
				tokensIn: 100,
				tokensOut: 200,
				cacheWrites: 0,
				cacheReads: 0,
				totalCost: 0.001,
				mode: "code",
				apiConfigName: "saved-profile",
			}

			// The user's active profile still matches the task's saved profile.
			await provider.contextProxy.setValue("currentApiConfigName", "saved-profile")
			// The saved profile's active settings, as its earlier activation wrote them.
			await provider.contextProxy.setValue("apiProvider", providerIdentifiers.anthropic)
			await provider.contextProxy.setValue("apiModelId", "claude-saved-128k")

			const activateProviderProfileSpy = vi
				.spyOn(provider, "activateProviderProfile")
				.mockResolvedValue(undefined)

			vi.spyOn(provider.providerSettingsManager, "listConfig").mockResolvedValue([
				{ name: "saved-profile", id: "saved-profile-id", apiProvider: providerIdentifiers.anthropic },
			])

			await provider.createTaskWithHistoryItem(historyItem)

			expect(activateProviderProfileSpy).toHaveBeenCalledWith(
				{ name: "saved-profile" },
				{ persistModeConfig: false, persistTaskHistory: false, expectedCurrentTaskId: historyItem.id },
			)
			expect(historyItem.apiConfigName).toBe("saved-profile")

			// The restored task serves the saved profile's exact settings.
			const taskOptions = vi.mocked(Task).mock.calls.at(-1)?.[0]
			expect(taskOptions?.apiConfiguration?.apiProvider).toBe(providerIdentifiers.anthropic)
			expect(taskOptions?.apiConfiguration?.apiModelId).toBe("claude-saved-128k")
		})

		// Property test from the StickyProfileRestore invariants: for every
		// (saved, current) profile pair, a restore serves and re-sticks the
		// user's current profile, never the stale saved one.
		it("property: a restore never serves a profile other than the user's current one (#970)", async () => {
			await provider.resolveWebviewView(mockWebviewView)

			const profiles = ["profile-a", "profile-b", "profile-c"]
			// Each profile carries distinct active settings, so a restore that
			// supplies another profile's configuration under the correct name
			// fails the assertions below (PR 2649 review round 1).
			const settingsFor: Record<string, { apiProvider: ProviderName; apiModelId: string }> = {
				"profile-a": { apiProvider: providerIdentifiers.anthropic, apiModelId: "model-a-128k" },
				"profile-b": { apiProvider: providerIdentifiers.openai, apiModelId: "model-b-256k" },
				"profile-c": { apiProvider: providerIdentifiers.openrouter, apiModelId: "model-c-512k" },
			}
			vi.spyOn(provider.providerSettingsManager, "listConfig").mockResolvedValue(
				profiles.map((name) => ({ name, id: `${name}-id`, apiProvider: providerIdentifiers.anthropic })),
			)

			for (const saved of profiles) {
				for (const current of profiles) {
					await provider.contextProxy.setValue("currentApiConfigName", current)
					await provider.contextProxy.setValue("apiProvider", settingsFor[current].apiProvider)
					await provider.contextProxy.setValue("apiModelId", settingsFor[current].apiModelId)

					const historyItem: HistoryItem = {
						id: `task-${profiles.indexOf(saved)}-${profiles.indexOf(current)}`,
						number: 1,
						ts: Date.now(),
						task: "Test task",
						tokensIn: 100,
						tokensOut: 200,
						cacheWrites: 0,
						cacheReads: 0,
						totalCost: 0.001,
						mode: "code",
						apiConfigName: saved,
					}

					const activateProviderProfileSpy = vi
						.spyOn(provider, "activateProviderProfile")
						.mockResolvedValue(undefined)

					await provider.createTaskWithHistoryItem(historyItem)

					// RestoreKeepsChosen: every profile activation the restore makes
					// targets the user's current profile.
					for (const call of activateProviderProfileSpy.mock.calls) {
						expect("name" in call[0] && call[0].name).toBe(current)
					}

					// StickyMatchesServing: the restored task's saved profile equals
					// the profile that serves it. The name correction travels on
					// the copy handed to the Task (round 4: no in-place mutation).
					const taskOptions = vi.mocked(Task).mock.calls.at(-1)?.[0]
					expect(taskOptions?.historyItem?.apiConfigName).toBe(current)

					// The restored task serves the current profile's exact settings,
					// never the saved profile's configuration.
					expect(taskOptions?.apiConfiguration?.apiProvider).toBe(settingsFor[current].apiProvider)
					expect(taskOptions?.apiConfiguration?.apiModelId).toBe(settingsFor[current].apiModelId)
					if (saved !== current) {
						expect(taskOptions?.apiConfiguration?.apiModelId).not.toBe(settingsFor[saved].apiModelId)
					}

					activateProviderProfileSpy.mockRestore()
				}
			}
		})

		it("re-sticks to the profile selected while the restore was in flight (#970 review round 1)", async () => {
			await provider.resolveWebviewView(mockWebviewView)

			// The task last ran on "saved-profile"; the user switched to
			// "current-profile" after it stopped.
			const historyItem: HistoryItem = {
				id: "test-task-id",
				number: 1,
				ts: Date.now(),
				task: "Test task",
				tokensIn: 100,
				tokensOut: 200,
				cacheWrites: 0,
				cacheReads: 0,
				totalCost: 0.001,
				mode: "code",
				apiConfigName: "saved-profile",
			}
			await provider.contextProxy.setValue("currentApiConfigName", "current-profile")

			vi.spyOn(provider.providerSettingsManager, "listConfig").mockResolvedValue([
				{ name: "saved-profile", id: "saved-profile-id", apiProvider: providerIdentifiers.anthropic },
				{ name: "current-profile", id: "current-profile-id", apiProvider: providerIdentifiers.openai },
				{ name: "switched-profile", id: "switched-profile-id", apiProvider: providerIdentifiers.openrouter },
			])
			const activateProviderProfileSpy = vi
				.spyOn(provider, "activateProviderProfile")
				.mockResolvedValue(undefined)

			// Profile switches run on providerProfileMutationQueue while restores
			// run on historyTaskCreationQueue, so a switch can interleave between
			// the restore's profile decision and its getState await. Simulate that
			// switch: the user picks "switched-profile" while the restore is in
			// flight, and the switch cannot write the restoring task's saved name
			// because the task is not current yet.
			const realGetState = provider.getState.bind(provider)
			const getStateSpy = vi.spyOn(provider, "getState").mockImplementation(async (options) => {
				await provider.contextProxy.setValue("currentApiConfigName", "switched-profile")
				return realGetState(options)
			})

			await provider.createTaskWithHistoryItem(historyItem)

			getStateSpy.mockRestore()

			// The decision kept the user's profile and activated nothing stale.
			expect(activateProviderProfileSpy).not.toHaveBeenCalledWith({ name: "saved-profile" }, expect.anything())

			// The installed task is re-stuck to the profile selected while the
			// restore was in flight, so its saved name matches what serves it.
			// The name travels on the copy handed to the Task (round 4).
			const taskOptions = vi.mocked(Task).mock.calls.at(-1)?.[0]
			expect(taskOptions?.historyItem?.apiConfigName).toBe("switched-profile")
			expect(taskOptions?.historyItem?.apiConfigName).not.toBe("current-profile")
		})

		it("serves the settings of the profile selected during the getState allow-list await (#970 review round 2)", async () => {
			await provider.resolveWebviewView(mockWebviewView)

			// The task last ran on "saved-profile"; the user switched to
			// "current-profile" after it stopped. The restore's decision keeps
			// "current-profile" and re-sticks the task to it.
			const historyItem: HistoryItem = {
				id: "test-task-id",
				number: 1,
				ts: Date.now(),
				task: "Test task",
				tokensIn: 100,
				tokensOut: 200,
				cacheWrites: 0,
				cacheReads: 0,
				totalCost: 0.001,
				mode: "code",
				apiConfigName: "saved-profile",
			}
			await provider.contextProxy.setValue("currentApiConfigName", "current-profile")
			// The current profile's settings, as its activation wrote them.
			await provider.contextProxy.setValue("apiProvider", providerIdentifiers.openai)
			await provider.contextProxy.setValue("apiModelId", "gpt-current-256k")

			vi.spyOn(provider.providerSettingsManager, "listConfig").mockResolvedValue([
				{ name: "saved-profile", id: "saved-profile-id", apiProvider: providerIdentifiers.anthropic },
				{ name: "current-profile", id: "current-profile-id", apiProvider: providerIdentifiers.openai },
				{ name: "switched-profile", id: "switched-profile-id", apiProvider: providerIdentifiers.openrouter },
			])
			const activateProviderProfileSpy = vi
				.spyOn(provider, "activateProviderProfile")
				.mockResolvedValue(undefined)

			// The real getState() snapshots the provider settings, then awaits
			// CloudService.instance.getAllowList(). A profile switch runs on
			// providerProfileMutationQueue and can complete during that await,
			// after the snapshot. Land the switch inside the await: the serving
			// name then returns the new profile while the snapshot still holds
			// the old profile's settings.
			cloudServiceMock.getAllowList.mockImplementationOnce(async () => {
				await provider.contextProxy.setValue("currentApiConfigName", "switched-profile")
				await provider.contextProxy.setValue("apiProvider", providerIdentifiers.openrouter)
				await provider.contextProxy.setValue("apiModelId", "switched-512k")
			})

			await provider.createTaskWithHistoryItem(historyItem)

			// The decision kept the user's profile and activated nothing stale.
			expect(activateProviderProfileSpy).not.toHaveBeenCalledWith({ name: "saved-profile" }, expect.anything())

			// The installed task records the profile selected during the await...
			// (on the copy handed to the Task — round 4: no in-place mutation)
			const taskOptions = vi.mocked(Task).mock.calls.at(-1)?.[0]
			expect(taskOptions?.historyItem?.apiConfigName).toBe("switched-profile")

			// ...and serves that profile's settings, never the stale snapshot's.
			// The name and the configuration come from one installation point.
			expect(taskOptions?.apiConfiguration?.apiProvider).toBe(providerIdentifiers.openrouter)
			expect(taskOptions?.apiConfiguration?.apiModelId).toBe("switched-512k")
			expect(taskOptions?.apiConfiguration?.apiModelId).not.toBe("gpt-current-256k")
		})

		it("install-point fallback keeps the current non-retired provider when the serving profile has no apiProvider (#970 review round 3)", async () => {
			await provider.resolveWebviewView(mockWebviewView)

			const historyItem: HistoryItem = {
				id: "test-task-id",
				number: 1,
				ts: Date.now(),
				task: "Test task",
				tokensIn: 100,
				tokensOut: 200,
				cacheWrites: 0,
				cacheReads: 0,
				totalCost: 0.001,
				mode: "code",
				apiConfigName: "saved-profile",
			}
			await provider.contextProxy.setValue("currentApiConfigName", "current-profile")
			await provider.contextProxy.setValue("apiProvider", providerIdentifiers.openai)

			vi.spyOn(provider.providerSettingsManager, "listConfig").mockResolvedValue([
				{ name: "saved-profile", id: "saved-profile-id", apiProvider: providerIdentifiers.anthropic },
				{ name: "current-profile", id: "current-profile-id" },
				{ name: "switched-profile", id: "switched-profile-id" },
			])

			// The serving profile's settings carry no apiProvider, and each
			// read returns a fresh object, as an activation-written profile
			// would produce.
			const getProviderSettingsSpy = vi
				.spyOn(provider.contextProxy, "getProviderSettings")
				.mockImplementation(
					() => ({ apiModelId: "no-provider-model" }) as ReturnType<ContextProxy["getProviderSettings"]>,
				)

			// A profile switch lands inside the getState allow-list await,
			// after the restore re-stuck the task to "current-profile". The
			// installation point then takes the mismatch branch, and the
			// fallback — not the mocked settings — must supply the provider.
			cloudServiceMock.getAllowList.mockImplementationOnce(async () => {
				await provider.contextProxy.setValue("currentApiConfigName", "switched-profile")
			})

			await provider.createTaskWithHistoryItem(historyItem)

			getProviderSettingsSpy.mockRestore()

			const taskOptions = vi.mocked(Task).mock.calls.at(-1)?.[0]
			expect(taskOptions?.historyItem?.apiConfigName).toBe("switched-profile")
			// The serving settings carry no apiProvider; the fallback keeps
			// the current non-retired provider instead of installing a task
			// with an unset provider.
			expect(taskOptions?.apiConfiguration?.apiProvider).toBe(providerIdentifiers.openai)
		})

		it("install-point fallback defaults to Anthropic when no non-retired provider is set (#970 review round 3)", async () => {
			await provider.resolveWebviewView(mockWebviewView)

			const historyItem: HistoryItem = {
				id: "test-task-id",
				number: 1,
				ts: Date.now(),
				task: "Test task",
				tokensIn: 100,
				tokensOut: 200,
				cacheWrites: 0,
				cacheReads: 0,
				totalCost: 0.001,
				mode: "code",
				apiConfigName: "saved-profile",
			}
			await provider.contextProxy.setValue("currentApiConfigName", "current-profile")
			await provider.contextProxy.setValue("apiProvider", undefined)

			vi.spyOn(provider.providerSettingsManager, "listConfig").mockResolvedValue([
				{ name: "saved-profile", id: "saved-profile-id", apiProvider: providerIdentifiers.anthropic },
				{ name: "current-profile", id: "current-profile-id" },
			])

			// The switch lands during the getState allow-list await and
			// leaves the serving profile without an apiProvider.
			cloudServiceMock.getAllowList.mockImplementationOnce(async () => {
				await provider.contextProxy.setValue("currentApiConfigName", "switched-profile")
				await provider.contextProxy.setValue("apiProvider", undefined)
			})

			await provider.createTaskWithHistoryItem(historyItem)

			const taskOptions = vi.mocked(Task).mock.calls.at(-1)?.[0]
			expect(taskOptions?.historyItem?.apiConfigName).toBe("switched-profile")
			// With no provider set anywhere, the fallback installs the same
			// Anthropic default getState() applies.
			expect(taskOptions?.apiConfiguration?.apiProvider).toBe(providerIdentifiers.anthropic)
		})

		it("install-point fallback treats a retired serving provider as unset (#970 review round 3)", async () => {
			await provider.resolveWebviewView(mockWebviewView)

			const historyItem: HistoryItem = {
				id: "test-task-id",
				number: 1,
				ts: Date.now(),
				task: "Test task",
				tokensIn: 100,
				tokensOut: 200,
				cacheWrites: 0,
				cacheReads: 0,
				totalCost: 0.001,
				mode: "code",
				apiConfigName: "saved-profile",
			}
			await provider.contextProxy.setValue("currentApiConfigName", "current-profile")

			vi.spyOn(provider.providerSettingsManager, "listConfig").mockResolvedValue([
				{ name: "saved-profile", id: "saved-profile-id", apiProvider: providerIdentifiers.anthropic },
				{ name: "current-profile", id: "current-profile-id" },
			])

			// The switch lands on a profile whose stored provider was later
			// retired. Sanitization preserves retired providers, so the
			// fallback itself must filter it like getState() does.
			cloudServiceMock.getAllowList.mockImplementationOnce(async () => {
				await provider.contextProxy.setValue("currentApiConfigName", "switched-profile")
				await provider.contextProxy.setValue("apiProvider", "groq")
			})

			await provider.createTaskWithHistoryItem(historyItem)

			const taskOptions = vi.mocked(Task).mock.calls.at(-1)?.[0]
			expect(taskOptions?.historyItem?.apiConfigName).toBe("switched-profile")
			expect(taskOptions?.apiConfiguration?.apiProvider).toBe(providerIdentifiers.anthropic)
		})

		it("reads the serving name and settings at one synchronous point across the history write (#970 review round 5)", async () => {
			await provider.resolveWebviewView(mockWebviewView)

			const historyItem: HistoryItem = {
				id: "test-task-id",
				number: 1,
				ts: Date.now(),
				task: "Test task",
				tokensIn: 100,
				tokensOut: 200,
				cacheWrites: 0,
				cacheReads: 0,
				totalCost: 0.001,
				mode: "code",
				apiConfigName: "saved-profile",
			}
			// Decision point sees no drift: the saved name still matches.
			await provider.contextProxy.setValue("currentApiConfigName", "saved-profile")

			vi.spyOn(provider.providerSettingsManager, "listConfig").mockResolvedValue([
				{ name: "saved-profile", id: "saved-profile-id", apiProvider: providerIdentifiers.anthropic },
				{ name: "switched-profile", id: "switched-profile-id", apiProvider: providerIdentifiers.openai },
				{ name: "final-profile", id: "final-profile-id", apiProvider: providerIdentifiers.openrouter },
			])

			// Switch #1 lands during the getState allow-list await: the
			// installation point must re-stick to switched-profile.
			cloudServiceMock.getAllowList.mockImplementationOnce(async () => {
				await provider.contextProxy.setValue("currentApiConfigName", "switched-profile")
				await provider.contextProxy.setValue("apiProvider", providerIdentifiers.openai)
				await provider.contextProxy.setValue("apiModelId", "switched-256k")
			})

			// Switch #2 lands during the re-stick's own history write. The
			// captured pair stays consistent, and the post-write reconcile
			// must adopt the latest completed selection as one pair.
			vi.spyOn(provider, "updateTaskHistory").mockImplementationOnce(async (item) => {
				await provider.contextProxy.setValue("currentApiConfigName", "final-profile")
				await provider.contextProxy.setValue("apiProvider", providerIdentifiers.openrouter)
				await provider.contextProxy.setValue("apiModelId", "switched-512k")
				return [item]
			})

			await provider.createTaskWithHistoryItem(historyItem)

			const taskOptions = vi.mocked(Task).mock.calls.at(-1)?.[0]
			// The reconcile pass adopted the latest completed selection.
			expect(taskOptions?.historyItem?.apiConfigName).toBe("final-profile")
			// ...as one consistent pair, not mixed with the earlier capture.
			expect(taskOptions?.apiConfiguration?.apiProvider).toBe(providerIdentifiers.openrouter)
			expect(taskOptions?.apiConfiguration?.apiModelId).toBe("switched-512k")
			expect(taskOptions?.apiConfiguration?.apiModelId).not.toBe("switched-256k")
		})

		it("chases a selection that lands during the reconcile write, bounded (#970 review round 7)", async () => {
			await provider.resolveWebviewView(mockWebviewView)

			const historyItem: HistoryItem = {
				id: "test-task-id",
				number: 1,
				ts: Date.now(),
				task: "Test task",
				tokensIn: 100,
				tokensOut: 200,
				cacheWrites: 0,
				cacheReads: 0,
				totalCost: 0.001,
				mode: "code",
				apiConfigName: "saved-profile",
			}
			await provider.contextProxy.setValue("currentApiConfigName", "saved-profile")

			vi.spyOn(provider.providerSettingsManager, "listConfig").mockResolvedValue([
				{ name: "saved-profile", id: "saved-profile-id", apiProvider: providerIdentifiers.anthropic },
				{ name: "switched-profile", id: "switched-profile-id", apiProvider: providerIdentifiers.openai },
				{ name: "final-profile", id: "final-profile-id", apiProvider: providerIdentifiers.openrouter },
			])

			cloudServiceMock.getAllowList.mockImplementationOnce(async () => {
				await provider.contextProxy.setValue("currentApiConfigName", "switched-profile")
				await provider.contextProxy.setValue("apiProvider", providerIdentifiers.openai)
				await provider.contextProxy.setValue("apiModelId", "switched-256k")
			})

			// Every history write drifts the selection forward: write #1
			// sees switched→final, write #2 sees final→switched again, and
			// write #3 stops the bounded loop. The task must carry the last
			// captured pair, and the loop must terminate.
			let writeCount = 0
			vi.spyOn(provider, "updateTaskHistory").mockImplementation(async (item) => {
				writeCount += 1
				const next = writeCount % 2 === 1 ? "final-profile" : "switched-profile"
				await provider.contextProxy.setValue("currentApiConfigName", next)
				await provider.contextProxy.setValue(
					"apiProvider",
					next === "final-profile" ? providerIdentifiers.openrouter : providerIdentifiers.openai,
				)
				return [item]
			})

			await provider.createTaskWithHistoryItem(historyItem)

			// The fixture is deterministic: every write drifts the selection,
			// so the bounded loop runs exactly three rounds. Round 3 captures
			// switched-profile with its openai settings before its own write
			// sets final-profile — the loop then stops at the bound.
			expect(writeCount).toBe(3)
			const taskOptions = vi.mocked(Task).mock.calls.at(-1)?.[0]
			// The task carries the round-3 captured pair.
			expect(taskOptions?.historyItem?.apiConfigName).toBe("switched-profile")
			expect(taskOptions?.apiConfiguration?.apiProvider).toBe(providerIdentifiers.openai)
		})

		it("keeps the task on the current profile when the re-stick write fails at the keep-current path (#970 review round 8)", async () => {
			await provider.resolveWebviewView(mockWebviewView)

			// Same fixture as the keep-current test: the task last ran on
			// "saved-profile"; the user has since switched to "current-profile".
			const historyItem: HistoryItem = {
				id: "test-task-id",
				number: 1,
				ts: Date.now(),
				task: "Test task",
				tokensIn: 100,
				tokensOut: 200,
				cacheWrites: 0,
				cacheReads: 0,
				totalCost: 0.001,
				mode: "code",
				apiConfigName: "saved-profile",
			}
			await provider.contextProxy.setValue("currentApiConfigName", "current-profile")
			await provider.contextProxy.setValue("apiProvider", providerIdentifiers.openai)
			await provider.contextProxy.setValue("apiModelId", "gpt-current-256k")

			vi.spyOn(provider.providerSettingsManager, "listConfig").mockResolvedValue([
				{ name: "saved-profile", id: "saved-profile-id", apiProvider: providerIdentifiers.anthropic },
				{ name: "current-profile", id: "current-profile-id", apiProvider: providerIdentifiers.openai },
			])

			// The re-stick write fails at the store.
			const logSpy = vi.spyOn(provider, "log")
			vi.spyOn(provider, "updateTaskHistory").mockRejectedValue(new Error("disk full"))

			await provider.createTaskWithHistoryItem(historyItem)

			// The failure is logged with the re-stuck name, and restoration
			// continues on the in-memory re-stuck name.
			expect(logSpy).toHaveBeenCalledWith(
				expect.stringContaining("Failed to persist re-stuck provider profile 'current-profile'"),
			)

			const taskOptions = vi.mocked(Task).mock.calls.at(-1)?.[0]
			expect(taskOptions?.historyItem?.apiConfigName).toBe("current-profile")
			// The task serves the current profile's exact settings.
			expect(taskOptions?.apiConfiguration?.apiProvider).toBe(providerIdentifiers.openai)
			expect(taskOptions?.apiConfiguration?.apiModelId).toBe("gpt-current-256k")
		})

		it("installs the re-stuck pair when the re-stick write fails at the install point (#970 review round 8)", async () => {
			await provider.resolveWebviewView(mockWebviewView)

			const historyItem: HistoryItem = {
				id: "test-task-id",
				number: 1,
				ts: Date.now(),
				task: "Test task",
				tokensIn: 100,
				tokensOut: 200,
				cacheWrites: 0,
				cacheReads: 0,
				totalCost: 0.001,
				mode: "code",
				apiConfigName: "saved-profile",
			}
			await provider.contextProxy.setValue("currentApiConfigName", "saved-profile")

			vi.spyOn(provider.providerSettingsManager, "listConfig").mockResolvedValue([
				{ name: "saved-profile", id: "saved-profile-id", apiProvider: providerIdentifiers.anthropic },
				{ name: "switched-profile", id: "switched-profile-id", apiProvider: providerIdentifiers.openai },
			])

			// A switch lands mid-restore; every bounded-round write then
			// rejects at the store.
			cloudServiceMock.getAllowList.mockImplementationOnce(async () => {
				await provider.contextProxy.setValue("currentApiConfigName", "switched-profile")
				await provider.contextProxy.setValue("apiProvider", providerIdentifiers.openai)
				await provider.contextProxy.setValue("apiModelId", "switched-256k")
			})

			const logSpy = vi.spyOn(provider, "log")
			vi.spyOn(provider, "updateTaskHistory").mockRejectedValue(new Error("disk full"))

			await provider.createTaskWithHistoryItem(historyItem)

			// The failing write logs once, but restoration is not aborted:
			// the round already re-stuck the in-memory name, so the next
			// round sees no difference and the loop terminates.
			const persistFailures = logSpy.mock.calls.filter(([m]) =>
				String(m).includes("Failed to persist re-stuck provider profile 'switched-profile'"),
			)
			expect(persistFailures.length).toBe(1)

			// The Task still installs with the re-stuck name and the captured
			// serving settings.
			const taskOptions = vi.mocked(Task).mock.calls.at(-1)?.[0]
			expect(taskOptions?.historyItem?.apiConfigName).toBe("switched-profile")
			expect(taskOptions?.apiConfiguration?.apiProvider).toBe(providerIdentifiers.openai)
			expect(taskOptions?.apiConfiguration?.apiModelId).toBe("switched-256k")
		})

		it("persists the re-stuck profile name through the store write path without mutating the cached entry (#970 review round 4)", async () => {
			await provider.resolveWebviewView(mockWebviewView)

			const historyItem: HistoryItem = {
				id: "test-task-id",
				number: 1,
				ts: Date.now(),
				task: "Test task",
				tokensIn: 100,
				tokensOut: 200,
				cacheWrites: 0,
				cacheReads: 0,
				totalCost: 0.001,
				mode: "code",
				apiConfigName: "saved-profile",
			}
			// The object the caller (and the history cache) holds.
			const cachedRef = historyItem
			await provider.contextProxy.setValue("currentApiConfigName", "current-profile")

			vi.spyOn(provider.providerSettingsManager, "listConfig").mockResolvedValue([
				{ name: "saved-profile", id: "saved-profile-id", apiProvider: providerIdentifiers.anthropic },
				{ name: "current-profile", id: "current-profile-id", apiProvider: providerIdentifiers.openai },
				{ name: "switched-profile", id: "switched-profile-id", apiProvider: providerIdentifiers.openrouter },
			])

			// Spy WITHOUT stubbing: the real store write path must run.
			const updateTaskHistorySpy = vi.spyOn(provider, "updateTaskHistory")

			cloudServiceMock.getAllowList.mockImplementationOnce(async () => {
				await provider.contextProxy.setValue("currentApiConfigName", "switched-profile")
				await provider.contextProxy.setValue("apiProvider", providerIdentifiers.openrouter)
				await provider.contextProxy.setValue("apiModelId", "switched-512k")
			})

			await provider.createTaskWithHistoryItem(historyItem)

			const taskOptions = vi.mocked(Task).mock.calls.at(-1)?.[0]
			// The installed Task carries the re-stuck name...
			expect(taskOptions?.historyItem?.apiConfigName).toBe("switched-profile")

			// ...while the cached entry object was never mutated in place.
			expect(cachedRef.apiConfigName).toBe("saved-profile")

			// The re-stuck name went through the store's write path —
			// the final write records the serving profile...
			expect(updateTaskHistorySpy).toHaveBeenLastCalledWith(
				expect.objectContaining({ id: "test-task-id", apiConfigName: "switched-profile" }),
			)
			// ...and the store's persisted/cached record carries it.
			expect(provider.taskHistoryStore.get("test-task-id")?.apiConfigName).toBe("switched-profile")
		})

		it("should not restore an empty task apiConfigName profile from history", async () => {
			await provider.resolveWebviewView(mockWebviewView)

			const historyItem: HistoryItem = {
				id: "test-task-id",
				number: 1,
				ts: Date.now(),
				task: "Test task",
				tokensIn: 100,
				tokensOut: 200,
				cacheWrites: 0,
				cacheReads: 0,
				totalCost: 0.001,
				mode: "ask",
				apiConfigName: "default",
			}

			const activateProviderProfileSpy = vi
				.spyOn(provider, "activateProviderProfile")
				.mockResolvedValue(undefined)

			vi.spyOn(provider.providerSettingsManager, "listConfig").mockResolvedValue([
				{ name: "default", id: "default-id" },
			])

			await provider.createTaskWithHistoryItem(historyItem)

			expect(activateProviderProfileSpy).not.toHaveBeenCalled()
		})

		it("should skip restoring task apiConfigName from history in CLI runtime", async () => {
			await provider.resolveWebviewView(mockWebviewView)
			process.env.ROO_CLI_RUNTIME = "1"

			const historyItem: HistoryItem = {
				id: "test-task-id",
				number: 1,
				ts: Date.now(),
				task: "Test task",
				tokensIn: 100,
				tokensOut: 200,
				cacheWrites: 0,
				cacheReads: 0,
				totalCost: 0.001,
				apiConfigName: "saved-profile",
			}

			const activateProviderProfileSpy = vi
				.spyOn(provider, "activateProviderProfile")
				.mockResolvedValue(undefined)
			const logSpy = vi.spyOn(provider, "log")

			vi.spyOn(provider.providerSettingsManager, "listConfig").mockResolvedValue([
				{ name: "saved-profile", id: "saved-profile-id", apiProvider: providerIdentifiers.anthropic },
			])

			await provider.createTaskWithHistoryItem(historyItem)

			expect(activateProviderProfileSpy).not.toHaveBeenCalledWith({ name: "saved-profile" }, expect.anything())
			expect(logSpy).toHaveBeenCalledWith(
				expect.stringContaining("Skipping restore of provider profile 'saved-profile'"),
			)
		})

		it("should skip restoring mode-based provider config from history in CLI runtime", async () => {
			await provider.resolveWebviewView(mockWebviewView)
			process.env.ROO_CLI_RUNTIME = "1"

			const historyItem: HistoryItem = {
				id: "test-task-id",
				number: 1,
				ts: Date.now(),
				task: "Test task",
				tokensIn: 100,
				tokensOut: 200,
				cacheWrites: 0,
				cacheReads: 0,
				totalCost: 0.001,
				mode: "code",
			}

			const activateProviderProfileSpy = vi
				.spyOn(provider, "activateProviderProfile")
				.mockResolvedValue(undefined)

			vi.spyOn(provider.providerSettingsManager, "getModeConfigId").mockResolvedValue("mode-config-id")
			vi.spyOn(provider.providerSettingsManager, "listConfig").mockResolvedValue([
				{ name: "mode-profile", id: "mode-config-id", apiProvider: providerIdentifiers.anthropic },
			])

			await provider.createTaskWithHistoryItem(historyItem)

			expect(activateProviderProfileSpy).not.toHaveBeenCalled()
		})

		it("restores the mode-based profile without persisting it as a mode default or touching another task", async () => {
			provider["initialModeConfigIds"] = Promise.resolve({ code: "mode-config-id" })
			await provider.resolveWebviewView(mockWebviewView)
			const historyItem: HistoryItem = {
				id: "test-task-id",
				number: 1,
				ts: Date.now(),
				task: "Test task",
				tokensIn: 0,
				tokensOut: 0,
				totalCost: 0,
				mode: "code",
			}
			const activateProviderProfileSpy = vi
				.spyOn(provider, "activateProviderProfile")
				.mockResolvedValue(undefined)
			vi.spyOn(provider.providerSettingsManager, "getModeConfigId").mockResolvedValue("mode-config-id")
			vi.spyOn(provider.providerSettingsManager, "listConfig").mockResolvedValue([
				{ name: "mode-profile", id: "mode-config-id", apiProvider: providerIdentifiers.anthropic },
			])
			vi.spyOn(provider.providerSettingsManager, "getProfile").mockResolvedValue({
				name: "mode-profile",
				id: "mode-config-id",
				apiProvider: providerIdentifiers.anthropic,
			})

			await provider.createTaskWithHistoryItem(historyItem)

			expect(activateProviderProfileSpy).toHaveBeenCalledWith(
				{ name: "mode-profile" },
				{ persistModeConfig: false, expectedCurrentTaskId: historyItem.id },
			)
		})

		it("should use current profile if history item has no saved apiConfigName", async () => {
			await provider.resolveWebviewView(mockWebviewView)

			// Create a history item without saved provider profile
			const historyItem: HistoryItem = {
				id: "test-task-id",
				number: 1,
				ts: Date.now(),
				task: "Test task",
				tokensIn: 100,
				tokensOut: 200,
				cacheWrites: 0,
				cacheReads: 0,
				totalCost: 0.001,
				// No apiConfigName field
			}

			// Mock activateProviderProfile to track calls
			const activateProviderProfileSpy = vi
				.spyOn(provider, "activateProviderProfile")
				.mockResolvedValue(undefined)

			// Initialize task with history item
			await provider.createTaskWithHistoryItem(historyItem)

			// Verify activateProviderProfile was NOT called for apiConfigName restoration
			// (it might be called for mode-based config, but not for direct apiConfigName)
			const callsForApiConfigName = activateProviderProfileSpy.mock.calls.filter(
				(call) => call[0] && "name" in call[0] && call[0].name === historyItem.apiConfigName,
			)
			expect(callsForApiConfigName.length).toBe(0)
		})

		it("should override mode-based config with task's apiConfigName", async () => {
			await provider.resolveWebviewView(mockWebviewView)

			// Create a history item with both mode and apiConfigName
			const historyItem: HistoryItem = {
				id: "test-task-id",
				number: 1,
				ts: Date.now(),
				task: "Test task",
				tokensIn: 100,
				tokensOut: 200,
				cacheWrites: 0,
				cacheReads: 0,
				totalCost: 0.001,
				mode: "architect", // Mode has a different preferred profile
				apiConfigName: "task-specific-profile", // Task's actual profile
			}

			// Track all activateProviderProfile calls
			const activateCalls: string[] = []
			vi.spyOn(provider, "activateProviderProfile").mockImplementation(async (args) => {
				if ("name" in args) {
					activateCalls.push(args.name)
				}
			})

			// Mock providerSettingsManager methods
			vi.spyOn(provider.providerSettingsManager, "getModeConfigId").mockResolvedValue("mode-config-id")
			vi.spyOn(provider.providerSettingsManager, "listConfig").mockResolvedValue([
				{ name: "mode-preferred-profile", id: "mode-config-id", apiProvider: providerIdentifiers.anthropic },
				{ name: "task-specific-profile", id: "task-profile-id", apiProvider: providerIdentifiers.openai },
			])

			// Initialize task with history item
			await provider.createTaskWithHistoryItem(historyItem)

			// Verify task's apiConfigName was activated LAST (overriding mode-based config)
			expect(activateCalls[activateCalls.length - 1]).toBe("task-specific-profile")
		})

		it("should handle missing provider profile gracefully", async () => {
			await provider.resolveWebviewView(mockWebviewView)

			// Create a history item with a provider profile that no longer exists
			const historyItem: HistoryItem = {
				id: "test-task-id",
				number: 1,
				ts: Date.now(),
				task: "Test task",
				tokensIn: 100,
				tokensOut: 200,
				cacheWrites: 0,
				cacheReads: 0,
				totalCost: 0.001,
				apiConfigName: "deleted-profile", // Profile that doesn't exist
			}

			// Mock providerSettingsManager.listConfig to return empty (profile doesn't exist)
			vi.spyOn(provider.providerSettingsManager, "listConfig").mockResolvedValue([])

			// Mock log to verify warning is logged
			const logSpy = vi.spyOn(provider, "log")

			// Initialize task with history item - should not throw
			await expect(provider.createTaskWithHistoryItem(historyItem)).resolves.not.toThrow()

			// Verify a warning was logged
			expect(logSpy).toHaveBeenCalledWith(
				expect.stringContaining("Provider profile 'deleted-profile' from history no longer exists"),
			)
		})
	})

	describe("cancelTaskInternal", () => {
		it("preserves the task-local profile when rehydrating the cancelled current task (#970 review round 1)", async () => {
			await provider.resolveWebviewView(mockWebviewView)

			// A delegated child can run a mode-specific task-local profile while the
			// global profile stays unchanged (selectHandoffExecutionContext in
			// src/core/task/providerHandoff.ts). The child is current when the user
			// cancels it, so cancelTaskInternal rehydrates the same task in place.
			const historyItem: HistoryItem = {
				id: "child-task",
				number: 1,
				ts: Date.now(),
				task: "Child task",
				tokensIn: 0,
				tokensOut: 0,
				cacheWrites: 0,
				cacheReads: 0,
				totalCost: 0,
				mode: "code",
				apiConfigName: "child-profile",
			}
			await provider.taskHistoryStore.upsert(historyItem)

			const childTask = {
				taskId: "child-task",
				instanceId: "child-instance-1",
				rootTask: undefined,
				parentTask: undefined,
				parentTaskId: undefined,
				setAbortReason: vi.fn(),
				cancelCurrentRequest: vi.fn(),
				abortTask: vi.fn().mockResolvedValue(undefined),
				requestAbandon: vi.fn(),
				emit: vi.fn(),
			}
			await provider.addClineToStack(childTask as unknown as Task)

			// The global profile never changed: it is still the profile the parent
			// runs on, and it differs from the child's task-local profile.
			await provider.contextProxy.setValue("currentApiConfigName", "global-profile")

			vi.spyOn(provider.providerSettingsManager, "listConfig").mockResolvedValue([
				{ name: "child-profile", id: "child-profile-id", apiProvider: providerIdentifiers.anthropic },
				{ name: "global-profile", id: "global-profile-id", apiProvider: providerIdentifiers.openai },
			])
			const activateProviderProfileSpy = vi
				.spyOn(provider, "activateProviderProfile")
				.mockResolvedValue(undefined)

			await (provider as unknown as { cancelTaskInternal: (task: Task) => Promise<void> }).cancelTaskInternal(
				childTask as unknown as Task,
			)

			// Cancellation rehydrates the SAME task, so the keep-current override
			// must not fire: the task-local profile is restored, not replaced by
			// the unchanged global profile.
			expect(activateProviderProfileSpy).toHaveBeenCalledWith(
				{ name: "child-profile" },
				expect.objectContaining({ persistTaskHistory: false }),
			)
			expect(activateProviderProfileSpy).not.toHaveBeenCalledWith({ name: "global-profile" }, expect.anything())

			// The rehydrated task keeps the task-local profile name.
			expect(historyItem.apiConfigName).toBe("child-profile")
			const taskOptions = vi.mocked(Task).mock.calls.at(-1)?.[0]
			expect(taskOptions?.historyItem?.apiConfigName).toBe("child-profile")
			expect(taskOptions?.historyItem?.apiConfigName).not.toBe("global-profile")
		})
	})

	describe("Task metadata persistence", () => {
		it("should include apiConfigName in task metadata when saving", async () => {
			await provider.resolveWebviewView(mockWebviewView)

			// Create a mock task with provider profile
			const mockTask = {
				taskId: "test-task-id",
				_taskApiConfigName: "test-profile",
				setTaskApiConfigName: vi.fn(),
				emit: vi.fn(),
				saveClineMessages: vi.fn(),
				clineMessages: [],
				apiConversationHistory: [],
				updateApiConfiguration: vi.fn(),
			}

			// Populate the store so persistStickyProviderProfileToCurrentTask finds the task
			await provider.taskHistoryStore.upsert({
				id: mockTask.taskId,
				ts: Date.now(),
				task: "Test task",
				number: 1,
				tokensIn: 0,
				tokensOut: 0,
				totalCost: 0,
			})

			// Mock updateTaskHistory to capture the updated history item
			let updatedHistoryItem: any
			vi.spyOn(provider, "updateTaskHistory").mockImplementation((item) => {
				updatedHistoryItem = item
				return Promise.resolve([item])
			})

			// Add task to provider stack
			await provider.addClineToStack(mockTask as any)

			// Mock providerSettingsManager.activateProfile
			vi.spyOn(provider.providerSettingsManager, "activateProfile").mockResolvedValue({
				name: "new-profile",
				id: "new-profile-id",
				apiProvider: providerIdentifiers.anthropic,
			})

			// Mock providerSettingsManager.listConfig
			vi.spyOn(provider.providerSettingsManager, "listConfig").mockResolvedValue([
				{ name: "new-profile", id: "new-profile-id", apiProvider: providerIdentifiers.anthropic },
			])

			// Trigger a profile switch
			await provider.activateProviderProfile({ name: "new-profile" })

			// Verify apiConfigName was included in the updated history item
			expect(updatedHistoryItem).toBeDefined()
			expect(updatedHistoryItem.apiConfigName).toBe("new-profile")
		})
	})

	describe("Multiple workspaces isolation", () => {
		it("should preserve task profile when switching profiles in another workspace", async () => {
			// This test verifies that each task retains its designated provider profile
			// so that switching profiles in one workspace doesn't alter other tasks

			await provider.resolveWebviewView(mockWebviewView)

			// Create task 1 with profile A
			const task1 = {
				taskId: "task-1",
				_taskApiConfigName: "profile-a",
				setTaskApiConfigName: vi.fn().mockImplementation(function (this: any, name: string) {
					this._taskApiConfigName = name
				}),
				emit: vi.fn(),
				saveClineMessages: vi.fn(),
				clineMessages: [],
				apiConversationHistory: [],
				updateApiConfiguration: vi.fn(),
			}

			// Add task 1 to stack
			await provider.addClineToStack(task1 as any)

			// Mock getGlobalState to return task history for both tasks
			const taskHistory = [
				{
					id: "task-1",
					ts: Date.now(),
					task: "Task 1",
					number: 1,
					tokensIn: 0,
					tokensOut: 0,
					cacheWrites: 0,
					cacheReads: 0,
					totalCost: 0,
					apiConfigName: "profile-a",
				},
				{
					id: "task-2",
					ts: Date.now(),
					task: "Task 2",
					number: 2,
					tokensIn: 0,
					tokensOut: 0,
					cacheWrites: 0,
					cacheReads: 0,
					totalCost: 0,
					apiConfigName: "profile-b",
				},
			]

			// Populate the store
			for (const item of taskHistory) {
				await provider.taskHistoryStore.upsert(item as any)
			}

			// Mock updateTaskHistory
			vi.spyOn(provider, "updateTaskHistory").mockImplementation((item) => {
				const index = taskHistory.findIndex((h) => h.id === item.id)
				if (index >= 0) {
					taskHistory[index] = { ...taskHistory[index], ...item }
				}
				return Promise.resolve(taskHistory)
			})

			// Mock providerSettingsManager.activateProfile
			vi.spyOn(provider.providerSettingsManager, "activateProfile").mockResolvedValue({
				name: "profile-c",
				id: "profile-c-id",
				apiProvider: providerIdentifiers.anthropic,
			})

			// Mock providerSettingsManager.listConfig
			vi.spyOn(provider.providerSettingsManager, "listConfig").mockResolvedValue([
				{ name: "profile-a", id: "profile-a-id", apiProvider: providerIdentifiers.anthropic },
				{ name: "profile-b", id: "profile-b-id", apiProvider: providerIdentifiers.openai },
				{ name: "profile-c", id: "profile-c-id", apiProvider: providerIdentifiers.anthropic },
			])

			// Switch task 1's profile to profile C
			await provider.activateProviderProfile({ name: "profile-c" })

			// Verify task 1's profile was updated
			expect(task1._taskApiConfigName).toBe("profile-c")
			expect(taskHistory[0].apiConfigName).toBe("profile-c")

			// Verify task 2's profile remains unchanged
			expect(taskHistory[1].apiConfigName).toBe("profile-b")
		})
	})

	describe("Error handling", () => {
		it("should handle errors gracefully when saving profile fails", async () => {
			await provider.resolveWebviewView(mockWebviewView)

			// Create a mock task
			const mockTask = {
				taskId: "test-task-id",
				_taskApiConfigName: "default-profile",
				setTaskApiConfigName: vi.fn(),
				emit: vi.fn(),
				saveClineMessages: vi.fn(),
				clineMessages: [],
				apiConversationHistory: [],
				updateApiConfiguration: vi.fn(),
			}

			// Add task to provider stack
			await provider.addClineToStack(mockTask as any)

			// Populate the store
			await provider.taskHistoryStore.upsert({
				id: mockTask.taskId,
				ts: Date.now(),
				task: "Test task",
				number: 1,
				tokensIn: 0,
				tokensOut: 0,
				totalCost: 0,
			})

			// Mock updateTaskHistory to throw error
			vi.spyOn(provider, "updateTaskHistory").mockRejectedValue(new Error("Save failed"))

			// Mock providerSettingsManager.activateProfile
			vi.spyOn(provider.providerSettingsManager, "activateProfile").mockResolvedValue({
				name: "new-profile",
				id: "new-profile-id",
				apiProvider: providerIdentifiers.anthropic,
			})

			// Mock providerSettingsManager.listConfig
			vi.spyOn(provider.providerSettingsManager, "listConfig").mockResolvedValue([
				{ name: "new-profile", id: "new-profile-id", apiProvider: providerIdentifiers.anthropic },
			])

			// Mock log to verify error is logged
			const logSpy = vi.spyOn(provider, "log")

			// Switch provider profile - should not throw
			await expect(provider.activateProviderProfile({ name: "new-profile" })).resolves.not.toThrow()

			// Verify error was logged
			expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Failed to persist provider profile switch"))
		})

		it("should handle null/undefined apiConfigName gracefully", async () => {
			await provider.resolveWebviewView(mockWebviewView)

			// Create a history item with null apiConfigName
			const historyItem: HistoryItem = {
				id: "test-task-id",
				number: 1,
				ts: Date.now(),
				task: "Test task",
				tokensIn: 100,
				tokensOut: 200,
				cacheWrites: 0,
				cacheReads: 0,
				totalCost: 0.001,
				apiConfigName: null as any, // Invalid apiConfigName
			}

			// Mock activateProviderProfile to track calls
			const activateProviderProfileSpy = vi
				.spyOn(provider, "activateProviderProfile")
				.mockResolvedValue(undefined)

			// Initialize task with history item - should not throw
			await expect(provider.createTaskWithHistoryItem(historyItem)).resolves.not.toThrow()

			// Verify activateProviderProfile was not called with null
			expect(activateProviderProfileSpy).not.toHaveBeenCalledWith({ name: null })
		})
	})

	describe("Profile restoration with activateProfile failure", () => {
		it("should continue task restoration even if activateProviderProfile fails", async () => {
			await provider.resolveWebviewView(mockWebviewView)

			// Create a history item with saved provider profile
			const historyItem: HistoryItem = {
				id: "test-task-id",
				number: 1,
				ts: Date.now(),
				task: "Test task",
				tokensIn: 100,
				tokensOut: 200,
				cacheWrites: 0,
				cacheReads: 0,
				totalCost: 0.001,
				apiConfigName: "failing-profile",
			}

			// Mock providerSettingsManager.listConfig to return the profile
			vi.spyOn(provider.providerSettingsManager, "listConfig").mockResolvedValue([
				{ name: "failing-profile", id: "failing-profile-id", apiProvider: providerIdentifiers.anthropic },
			])

			// Mock activateProviderProfile to throw error
			vi.spyOn(provider, "activateProviderProfile").mockRejectedValue(new Error("Activation failed"))

			// Mock log to verify error is logged
			const logSpy = vi.spyOn(provider, "log")

			// Initialize task with history item - should not throw even though activation fails
			await expect(provider.createTaskWithHistoryItem(historyItem)).resolves.not.toThrow()

			// Verify error was logged
			expect(logSpy).toHaveBeenCalledWith(
				expect.stringContaining("Failed to restore API configuration 'failing-profile' for task"),
			)
		})
	})
})
