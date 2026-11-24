// npx vitest core/mentions/__tests__/index.spec.ts

import { mkdtemp, writeFile, rm } from "fs/promises"
import { tmpdir } from "os"
import path from "path"

import { parseMentions, MAX_FOLDER_FILES_INLINED, MAX_FOLDER_TOTAL_LINES } from "../index"

// Mock vscode
vi.mock("vscode", () => ({
	window: {
		showErrorMessage: vi.fn(),
	},
}))

// Mock i18n
vi.mock("../../../i18n", () => ({
	t: vi.fn((key: string) => key),
}))

// Controlled extract-text: the budget logic must be tested deterministically,
// independent of file encodings. Contents are keyed by absolute path.
// A globalThis-held Map keeps ONE shared instance across the hoisted vi.mock
// factory and the test scope.
const FILE_CONTENTS: Map<string, string> = ((globalThis as Record<string, unknown>).__mentionsFileContents ??= new Map<
	string,
	string
>()) as Map<string, string>

vi.mock("../../../integrations/misc/extract-text", () => ({
	extractTextFromFileWithMetadata: vi.fn(async (absoluteFilePath: string) => ({
		content: FILE_CONTENTS.get(absoluteFilePath) ?? "",
	})),
}))

const makeLines = (n: number): string => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n")

async function makeTempFolder(fileNames: string[], contentFor: (name: string) => string): Promise<string> {
	const dir = await mkdtemp(path.join(tmpdir(), "mentions-folder-"))
	await Promise.all(
		fileNames.map(async (name) => {
			await writeFile(path.join(dir, name), contentFor(name))
			// The extract-text mock reads from this map, keyed by absolute path.
			FILE_CONTENTS.set(path.join(dir, name), contentFor(name))
		}),
	)
	return dir
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

describe("parseMentions - folder mention inline budget (#1539)", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		FILE_CONTENTS.clear()
	})

	it("inlines at most MAX_FOLDER_FILES_INLINED files and lists the rest as skipped", async () => {
		const names = Array.from({ length: 25 }, (_, i) => `file${String(i).padStart(2, "0")}.txt`)
		const dir = await makeTempFolder(names, (name) => `contents of ${name}\n`)
		try {
			const result = await parseMentions(`@/${path.basename(dir)}`, tmpdir())
			const folderBlock = result.contentBlocks.find((b) => b.type === "folder")

			expect(folderBlock).toBeTruthy()
			const content = folderBlock!.content
			// exactly the budget's worth of files inlined
			expect(content.match(/\[read_file for '/g)?.length).toBe(MAX_FOLDER_FILES_INLINED)
			expect(content).toContain("IMPORTANT: Folder content truncated")
			expect(content).toContain(`Inlined ${MAX_FOLDER_FILES_INLINED} file(s)`)
			// the 5 overflow files are named in the skip list
			const skippedNames = names.slice(MAX_FOLDER_FILES_INLINED)
			for (const name of skippedNames) {
				expect(content).toContain(name)
			}
			// and the model is told how to recover them
			expect(content).toContain("use read_file")
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it("enforces the aggregate line budget across files", async () => {
		const linesPerFile = 1000
		// 6 files x 1000 lines: budget 4000 lines → 4 inlined, 2 skipped
		const names = Array.from({ length: 6 }, (_, i) => `big${i}.txt`)
		const dir = await makeTempFolder(names, () => makeLines(linesPerFile))
		try {
			const result = await parseMentions(`@/${path.basename(dir)}`, tmpdir())
			const folderBlock = result.contentBlocks.find((b) => b.type === "folder")
			const content = folderBlock!.content

			expect(content.match(/\[read_file for '/g)?.length).toBe(4)
			expect(content).toContain("Inlined 4 file(s) (~4000 lines)")
			expect(content).toContain("Skipped: big4.txt, big5.txt")
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it("a single oversized file is inlined truncated to the budget, never dropped", async () => {
		const names = ["huge.txt"]
		const dir = await makeTempFolder(names, () => makeLines(MAX_FOLDER_TOTAL_LINES + 500))
		try {
			const result = await parseMentions(`@/${path.basename(dir)}`, tmpdir())
			const folderBlock = result.contentBlocks.find((b) => b.type === "folder")
			const content = folderBlock!.content

			// inlined (not skipped), but bounded to the budget
			expect(content).not.toContain("were NOT inlined")
			const body = content.split("File: ")[1]
			const bodyLines = body.split("\n").length
			expect(bodyLines).toBeLessThanOrEqual(MAX_FOLDER_TOTAL_LINES + 2)
			expect(content).toContain("line 1\n")
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it("adds no truncation note when everything fits", async () => {
		const names = ["a.txt", "b.txt", "c.txt"]
		const dir = await makeTempFolder(names, (name) => `small content of ${name}\n`)
		try {
			const result = await parseMentions(`@/${path.basename(dir)}`, tmpdir())
			const folderBlock = result.contentBlocks.find((b) => b.type === "folder")
			const content = folderBlock!.content

			expect(content).not.toContain("IMPORTANT: Folder content truncated")
			expect(content).toContain("small content of a.txt")
			expect(content).toContain("small content of c.txt")
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})
})
