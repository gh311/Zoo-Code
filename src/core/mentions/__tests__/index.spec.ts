// npx vitest core/mentions/__tests__/index.spec.ts

import { mkdtemp, writeFile, rm, mkdir } from "fs/promises"
import { tmpdir } from "os"
import path from "path"

import { parseMentions, openMention } from "../index"
import type { FileContextTracker } from "../../context-tracking/FileContextTracker"
import { RooIgnoreController } from "../../ignore/RooIgnoreController"
import { openFile } from "../../../integrations/misc/open-file"

// Mock vscode
vi.mock("vscode", () => ({
	window: {
		showErrorMessage: vi.fn(),
	},
	commands: {
		executeCommand: vi.fn(),
	},
	Uri: {
		file: (p: string) => ({ path: p, fsPath: p }),
	},
	env: {
		openExternal: vi.fn(),
	},
	RelativePattern: function (this: { base: string; pattern: string }, base: string, pattern: string) {
		this.base = base
		this.pattern = pattern
	},
	workspace: {
		createFileSystemWatcher: vi.fn(() => ({
			onDidChange: vi.fn(() => ({ dispose: vi.fn() })),
			onDidCreate: vi.fn(() => ({ dispose: vi.fn() })),
			onDidDelete: vi.fn(() => ({ dispose: vi.fn() })),
			dispose: vi.fn(),
		})),
	},
}))

// Mock i18n
vi.mock("../../../i18n", () => ({
	t: vi.fn((key: string) => key),
}))

// openMention shells out to VS Code; mock the opener so tests only observe
// the resolved path.
vi.mock("../../../integrations/misc/open-file", () => ({
	openFile: vi.fn(),
}))

const makeDir = async (prefix: string): Promise<string> => mkdtemp(path.join(tmpdir(), prefix))

// The webview emits an opened-tab mention as a single-slash,
// forward-slash value (openedFileMentionValue in
// webview-ui/src/utils/context-mentions.ts). mentionRegex needs a '/'
// or scheme:// after '@' and stops at unescaped backslashes, so a
// platform-native path.join value cannot serve as the mention input on
// Windows (PR #2681 thread 4689348729).
const mentionValueFor = (absPath: string): string => {
	const posix = absPath.split(path.sep).join("/")
	const trimmed = posix.replace(/^\/+/, "")
	return `//${trimmed}`
}

describe("parseMentions - URL mention handling", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("should replace URL mentions with quoted URL reference", async () => {
		const result = await parseMentions("Check @https://example.com", "/test")

		// URL mentions are now replaced with a quoted reference (no fetching)
		expect(result.text).toContain("'https://example.com'")
	})
})

describe("parseMentions - mention path resolution (#1271)", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("resolves an absolute mention to the original file when the cwd-relative path does not exist", async () => {
		// A tab opened OUTSIDE the workspace: the webview emits its absolute
		// path as a single-slash mention '@/…' (openedFileMentionValue), so
		// the resolver must not pin it under the task cwd.
		const taskCwd = await makeDir("mentions-cwd-")
		const outsideDir = await makeDir("mentions-outside-")
		const absFile = path.join(outsideDir, "notes.txt")
		await writeFile(absFile, "absolute tab content\n")
		try {
			const result = await parseMentions(`@${mentionValueFor(absFile)}`, taskCwd)
			const fileBlock = result.contentBlocks.find((b) => b.type === "file")

			expect(fileBlock).toBeTruthy()
			// The mention resolved to the tab's absolute file, not to
			// taskCwd/mentions-outside-…/notes.txt.
			expect(fileBlock!.content).toContain("absolute tab content")
			expect(fileBlock!.content).not.toContain("Error:")
		} finally {
			await Promise.all([
				rm(taskCwd, { recursive: true, force: true }),
				rm(outsideDir, { recursive: true, force: true }),
			])
		}
	})

	it("returns the resolved absolute path in the mention block for a fallback read", async () => {
		// Thread 4690050706: the returned path and the read_file header
		// must name the file that supplied the content, or a later read
		// of the mention value targets the wrong file under the cwd.
		const taskCwd = await makeDir("serve-cwd-")
		const outsideDir = await makeDir("serve-outside-")
		const absFile = path.join(outsideDir, "notes.txt")
		await writeFile(absFile, "served tab content\n")
		try {
			const result = await parseMentions(`@${mentionValueFor(absFile)}`, taskCwd)
			const fileBlock = result.contentBlocks.find((b) => b.type === "file")

			expect(fileBlock).toBeTruthy()
			expect(path.isAbsolute(fileBlock!.path!)).toBe(true)
			expect(path.normalize(fileBlock!.path!)).toBe(path.normalize(absFile))
			expect(fileBlock!.content).toContain(`[read_file for '${fileBlock!.path}']`)
		} finally {
			await Promise.all([
				rm(taskCwd, { recursive: true, force: true }),
				rm(outsideDir, { recursive: true, force: true }),
			])
		}
	})

	it("keeps the relative mention path in the block for a cwd-relative workspace read", async () => {
		const ws = await makeDir("serve-ws-")
		await mkdir(path.join(ws, "src"))
		await writeFile(path.join(ws, "src", "file.ts"), "workspace version\n")
		try {
			const result = await parseMentions("@/src/file.ts", ws)
			const fileBlock = result.contentBlocks.find((b) => b.type === "file")

			expect(fileBlock).toBeTruthy()
			expect(fileBlock!.path).toBe("src/file.ts")
			expect(fileBlock!.content).toContain("[read_file for 'src/file.ts']")
		} finally {
			await rm(ws, { recursive: true, force: true })
		}
	})

	it("resolves the tab's absolute file even when a cwd-relative shadow exists", async () => {
		// Thread 4685318951: the tab mention is root-anchored, so the
		// open tab's file must win over a same-tailed file under the
		// task cwd. A cwd-relative resolver reads the shadow instead.
		const taskCwd = await makeDir("shadow-cwd-")
		const outsideDir = await makeDir("shadow-outside-")
		const absFile = path.join(outsideDir, "notes.txt")
		await writeFile(absFile, "absolute tab content\n")
		// The shadow: taskCwd/<the stripped absolute tail> — the path the
		// cwd-relative attempt would resolve the stripped mention to.
		const shadowRel = absFile.split(path.sep).slice(1).join(path.sep)
		await mkdir(path.dirname(path.join(taskCwd, shadowRel)), { recursive: true })
		await writeFile(path.join(taskCwd, shadowRel), "shadow content\n")
		try {
			const result = await parseMentions(`@${mentionValueFor(absFile)}`, taskCwd)
			const fileBlock = result.contentBlocks.find((b) => b.type === "file")

			expect(fileBlock).toBeTruthy()
			expect(fileBlock!.content).toContain("absolute tab content")
			expect(fileBlock!.content).not.toContain("shadow content")
			expect(path.isAbsolute(fileBlock!.path!)).toBe(true)
			expect(path.normalize(fileBlock!.path!)).toBe(path.normalize(absFile))
		} finally {
			await Promise.all([
				rm(taskCwd, { recursive: true, force: true }),
				rm(outsideDir, { recursive: true, force: true }),
			])
		}
	})

	it("keeps '@/src/file.ts' cwd-relative when the workspace file exists", async () => {
		const ws = await makeDir("mentions-ws-")
		await mkdir(path.join(ws, "src"))
		await writeFile(path.join(ws, "src", "file.ts"), "workspace version\n")
		try {
			const result = await parseMentions("@/src/file.ts", ws)
			const fileBlock = result.contentBlocks.find((b) => b.type === "file")

			expect(fileBlock).toBeTruthy()
			expect(fileBlock!.content).toContain("workspace version")
		} finally {
			await rm(ws, { recursive: true, force: true })
		}
	})

	it("denies a fallback-resolved mention when a root-anchored .rooignore rule covers the file", async () => {
		// cwd = workDir with rule '/secret.txt'; the secret lives at
		// workDir/secret.txt and the tab mentions it absolutely, so the
		// cwd-relative shadow does not exist and the resolver falls back
		// to the raw absolute tab path. validateAccess must check that
		// resolved path — the relative mention value would resolve to
		// workDir/…/secret.txt and never match the root-anchored rule.
		const workDir = await makeDir("roo-ignore-cwd-")
		const secret = path.join(workDir, "secret.txt")
		await writeFile(secret, "must not reach the context\n")
		await writeFile(path.join(workDir, ".rooignore"), "/secret.txt\n")
		const controller = new RooIgnoreController(workDir)
		await controller.initialize()
		try {
			const result = await parseMentions(`@${mentionValueFor(secret)}`, workDir, undefined, controller)
			const fileBlock = result.contentBlocks.find((b) => b.type === "file")

			expect(fileBlock).toBeTruthy()
			expect(fileBlock!.content).toContain("Note: File is ignored by .rooignore.")
			expect(fileBlock!.content).not.toContain("must not reach the context")
		} finally {
			await rm(workDir, { recursive: true, force: true })
		}
	})
	it("fails cleanly for the Windows drive form on POSIX, as before the fallback", async () => {
		// On win32, '/C:/Users/…' keeps its drive and resolves through the
		// cwd-relative attempt; on POSIX the file simply does not exist, and
		// the fallback must not read an unrelated file.
		const ws = await makeDir("mentions-win-")
		try {
			const result = await parseMentions("@/C:/Users/me/notes.txt", ws)
			const fileBlock = result.contentBlocks.find((b) => b.type === "file")

			expect(fileBlock).toBeTruthy()
			expect(fileBlock!.content).toContain("Failed to access path")
		} finally {
			await rm(ws, { recursive: true, force: true })
		}
	})
})

describe("openMention - absolute fallback (#1271)", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("opens the tab's absolute file for an absolute mention outside the cwd", async () => {
		const taskCwd = await makeDir("open-cwd-")
		const outsideDir = await makeDir("open-outside-")
		const absFile = path.join(outsideDir, "notes.txt")
		await writeFile(absFile, "x\n")
		try {
			await openMention(taskCwd, mentionValueFor(absFile))

			expect(openFile).toHaveBeenCalledWith(absFile)
		} finally {
			await Promise.all([
				rm(taskCwd, { recursive: true, force: true }),
				rm(outsideDir, { recursive: true, force: true }),
			])
		}
	})

	it("opens the tab's absolute file even when a cwd-relative shadow exists", async () => {
		// Thread 4685318951: the same priority as the parse path — the
		// root-anchored tab mention opens the tab's file, not the
		// same-tailed shadow under the task cwd.
		const taskCwd = await makeDir("open-shadow-cwd-")
		const outsideDir = await makeDir("open-shadow-outside-")
		const absFile = path.join(outsideDir, "notes.txt")
		await writeFile(absFile, "x\n")
		const shadowRel = absFile.split(path.sep).slice(1).join(path.sep)
		await mkdir(path.dirname(path.join(taskCwd, shadowRel)), { recursive: true })
		await writeFile(path.join(taskCwd, shadowRel), "shadow\n")
		try {
			await openMention(taskCwd, mentionValueFor(absFile))

			expect(openFile).toHaveBeenCalledWith(absFile)
		} finally {
			await Promise.all([
				rm(taskCwd, { recursive: true, force: true }),
				rm(outsideDir, { recursive: true, force: true }),
			])
		}
	})

	it("opens the cwd-relative file when it exists (workspace contract)", async () => {
		const ws = await makeDir("open-ws-")
		await mkdir(path.join(ws, "src"))
		const relFile = path.join(ws, "src", "file.ts")
		await writeFile(relFile, "x\n")
		try {
			await openMention(ws, "/src/file.ts")

			expect(openFile).toHaveBeenCalledWith(relFile)
		} finally {
			await rm(ws, { recursive: true, force: true })
		}
	})
})

describe("parseMentions - file context tracking identity (#1271)", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("tracks the resolved absolute path when the mention resolves through the absolute fallback", async () => {
		const taskCwd = await makeDir("track-cwd-")
		const outsideDir = await makeDir("track-outside-")
		const absFile = path.join(outsideDir, "notes.txt")
		await writeFile(absFile, "tracked tab content\n")
		const tracker = { trackFileContext: vi.fn(async () => {}) } satisfies Pick<
			FileContextTracker,
			"trackFileContext"
		>
		try {
			await parseMentions(`@${mentionValueFor(absFile)}`, taskCwd, tracker)

			// FileContextTracker re-resolves relative values against the
			// workspace cwd, so the fallback read must be tracked by its
			// resolved absolute identity, not the relative mention value.
			expect(tracker.trackFileContext).toHaveBeenCalled()
			const trackedPath = (tracker.trackFileContext as unknown as { mock: { calls: unknown[][] } }).mock
				.calls[0][0] as string
			expect(path.isAbsolute(trackedPath!)).toBe(true)
			expect(path.normalize(trackedPath!)).toBe(path.normalize(absFile))
		} finally {
			await Promise.all([
				rm(taskCwd, { recursive: true, force: true }),
				rm(outsideDir, { recursive: true, force: true }),
			])
		}
	})

	it("keeps the relative mention path for ordinary workspace files", async () => {
		const ws = await makeDir("track-ws-")
		await mkdir(path.join(ws, "src"))
		await writeFile(path.join(ws, "src", "file.ts"), "workspace version\n")
		const tracker = { trackFileContext: vi.fn(async () => {}) } satisfies Pick<
			FileContextTracker,
			"trackFileContext"
		>
		try {
			await parseMentions("@/src/file.ts", ws, tracker)

			expect(tracker.trackFileContext).toHaveBeenCalledWith("src/file.ts", "file_mentioned")
		} finally {
			await rm(ws, { recursive: true, force: true })
		}
	})
})
