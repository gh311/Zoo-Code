// npx vitest core/mentions/__tests__/index.spec.ts

import { mkdtemp, writeFile, rm, mkdir } from "fs/promises"
import { tmpdir } from "os"
import path from "path"

import { parseMentions, openMention } from "../index"
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
			const result = await parseMentions(`@${absFile}`, taskCwd)
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
			await openMention(taskCwd, absFile)

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
