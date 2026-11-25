// npx vitest core/mentions/__tests__/index.notebook.spec.ts
//
// Unlike index.spec.ts, this file does NOT mock extract-text: the
// regressions below must run the REAL .ipynb extractor end-to-end
// through the folder-mention budget clipping path — and the recovery
// regression must follow the advertised read_file call against the
// REAL ReadFileTool (thread 4689231126).

import { mkdtemp, writeFile, rm } from "fs/promises"
import { tmpdir } from "os"
import path from "path"

import { parseMentions, MAX_FOLDER_TOTAL_LINES } from "../index"
import { DEFAULT_LINE_LIMIT } from "../../prompts/tools/native-tools/read_file"
import { ReadFileTool } from "../../tools/ReadFileTool"
import type { Task } from "../../task/Task"

// Mock vscode. ReadFileTool's approval path reads vscode.workspace, so
// the mock carries a workspace whose folders are held in a globalThis
// slot (hoisted factories cannot close over test-scope variables).
vi.mock("vscode", () => {
	const mock = ((globalThis as Record<string, unknown>).__mentionsVscodeMock ??= {
		window: { showErrorMessage: vi.fn() },
		workspace: { workspaceFolders: [] as Array<{ uri: { fsPath: string } }> },
	})
	return mock
})

// Mock i18n
vi.mock("../../../i18n", () => ({
	t: vi.fn((key: string) => key),
}))

// Minimal reader-boundary double for ReadFileTool.execute: approval is
// granted, no feedback, tracking is recorded but not asserted here.
const makeReadFileTask = (cwd: string) => ({
	cwd,
	api: { getModel: vi.fn().mockReturnValue({ info: { supportsImages: false } }) },
	consecutiveMistakeCount: 0,
	didToolFailInCurrentTurn: false,
	didRejectTool: false,
	activeToolContexts: new Map(),
	ask: vi.fn().mockResolvedValue({ response: "yesButtonClicked", text: undefined, images: undefined }),
	say: vi.fn().mockResolvedValue(undefined),
	sayAndCreateMissingParamError: vi.fn(),
	recordToolError: vi.fn(),
	rooIgnoreController: { validateAccess: vi.fn().mockReturnValue(true) },
	fileContextTracker: { trackFileContext: vi.fn().mockResolvedValue(undefined) },
	providerRef: { deref: vi.fn().mockReturnValue({ getState: vi.fn().mockResolvedValue({}) }) },
})

const makeNotebook = (n: number): string =>
	JSON.stringify({
		cells: [
			{
				cell_type: "code",
				source: Array.from({ length: n }, (_, i) => `notebook line ${i + 1}`),
			},
		],
	})

describe("parseMentions - notebook clipped to the folder budget (#1539)", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		const vscodeMock = (globalThis as Record<string, unknown>).__mentionsVscodeMock as {
			workspace: { workspaceFolders: Array<{ uri: { fsPath: string } }> }
		}
		vscodeMock.workspace.workspaceFolders = []
	})

	it("a notebook exceeding the budget is inlined truncated with a notice showing lines 1-4000 and offset=4001", async () => {
		// One code cell with more source lines than the folder budget; the
		// real extractor numbers every line and reports wasTruncated: false,
		// so the clip must overlay the truncation metadata itself.
		const notebookLines = MAX_FOLDER_TOTAL_LINES + 500
		const dir = await mkdtemp(path.join(tmpdir(), "mentions-notebook-"))
		await writeFile(path.join(dir, "big.ipynb"), makeNotebook(notebookLines))
		try {
			const result = await parseMentions(`@/${path.basename(dir)}`, tmpdir())
			const folderBlock = result.contentBlocks.find((b) => b.type === "folder")

			expect(folderBlock).toBeTruthy()
			const content = folderBlock!.content

			// The notebook is inlined (never skipped)…
			expect(content).toContain(`[read_file for '${path.basename(dir)}/big.ipynb']`)
			expect(content).not.toContain("were NOT inlined")
			// …with a per-file truncation notice describing the clipped range…
			expect(content).toContain(`Showing lines 1-${MAX_FOLDER_TOTAL_LINES} of ${notebookLines + 1} total lines`)
			expect(content).toContain(`offset=${MAX_FOLDER_TOTAL_LINES + 1}`)
			// …and the shown content is exactly the first 4000 numbered lines.
			expect(content).toContain(`${MAX_FOLDER_TOTAL_LINES} | notebook line ${MAX_FOLDER_TOTAL_LINES}`)
			expect(content).not.toContain(`notebook line ${MAX_FOLDER_TOTAL_LINES + 1}`)
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it("the advertised recovery call retrieves the omitted notebook content", async () => {
		// Regression (thread 4689231126): the truncation notice advertises a
		// read_file call; following it exactly must return the omitted
		// notebook lines. Before the fix, read_file sliced raw JSON lines,
		// so the advertised offset failed with "beyond file end".
		const notebookLines = MAX_FOLDER_TOTAL_LINES + 500
		const dir = await mkdtemp(path.join(tmpdir(), "mentions-notebook-recovery-"))
		await writeFile(path.join(dir, "big.ipynb"), makeNotebook(notebookLines))
		try {
			const result = await parseMentions(`@/${path.basename(dir)}`, tmpdir())
			const content = result.contentBlocks.find((b) => b.type === "folder")!.content

			// The truncation notice advertises the recovery call.
			const notice = content.match(/To read more: Use the read_file tool with offset=(\d+) and limit=(\d+)/)
			expect(notice).toBeTruthy()
			const advertisedOffset = Number(notice![1])
			const advertisedLimit = Number(notice![2])
			expect(advertisedOffset).toBe(MAX_FOLDER_TOTAL_LINES + 1)
			expect(advertisedLimit).toBe(DEFAULT_LINE_LIMIT)

			// Follow the advertised instructions exactly, against the real
			// ReadFileTool reading the same file.
			const vscodeMock = (globalThis as Record<string, unknown>).__mentionsVscodeMock as {
				workspace: { workspaceFolders: Array<{ uri: { fsPath: string } }> }
			}
			vscodeMock.workspace.workspaceFolders = [{ uri: { fsPath: dir } }]
			const task = makeReadFileTask(dir)
			const pushToolResult = vi.fn()
			await new ReadFileTool().execute(
				{ path: "big.ipynb", offset: advertisedOffset, limit: advertisedLimit },
				task as unknown as Task,
				{ pushToolResult, toolCallId: "recovery-test", askApproval: vi.fn(), handleError: vi.fn() },
			)

			expect(pushToolResult).toHaveBeenCalledTimes(1)
			const retrieved = pushToolResult.mock.calls[0]?.[0]
			expect(typeof retrieved).toBe("string")
			// the omitted notebook content is retrievable, in the advertised
			// extracted-line coordinates…
			expect(retrieved).toContain(`notebook line ${MAX_FOLDER_TOTAL_LINES + 1}`)
			expect(retrieved).toContain(`notebook line ${notebookLines}`)
			// …and the shown range is not repeated.
			expect(retrieved).not.toContain(`| notebook line ${MAX_FOLDER_TOTAL_LINES}\n`)
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})
})
