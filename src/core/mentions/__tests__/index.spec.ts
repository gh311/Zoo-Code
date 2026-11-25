// npx vitest core/mentions/__tests__/index.spec.ts
//
// The budget tests run the REAL extractor end-to-end (no mock): its
// slicing and line numbering are part of the contract under test
// (review thread 4689231115). A text file never shows more than
// DEFAULT_LINE_LIMIT lines, so a fixture that must exceed the
// text-file limit is a notebook (.ipynb) — the extractor yields every
// cell line for those.

import { mkdtemp, writeFile, rm, readdir } from "fs/promises"
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

const makeLines = (n: number): string => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n")

// A notebook whose single code cell has n source lines. The real
// extractor numbers every extracted line; the trailing newline it
// appends shows up as one extra (empty) extracted line.
const makeNotebook = (n: number): string =>
	JSON.stringify({
		cells: [
			{
				cell_type: "code",
				source: Array.from({ length: n }, (_, i) => `notebook line ${i + 1}`),
			},
		],
	})

// Placeholder files, created sequentially. The budget walks entries in
// readdir order, and that order is filesystem-dependent — tests whose
// outcome depends on the walk order read the real order with readdir
// and assign notebook contents to the walked positions (all positions
// use .ipynb names, because extraction is by file extension).
async function makeTempFolder(fileNames: string[]): Promise<string> {
	const dir = await mkdtemp(path.join(tmpdir(), "mentions-folder-"))
	for (const name of fileNames) {
		await writeFile(path.join(dir, name), "")
	}
	return dir
}

// Full inlined-file header list: every "[read_file for '<path>']" entry in the
// order the folder was walked.
const inlinedHeaders = (content: string): string[] =>
	Array.from(content.matchAll(/\[read_file for '(.+?)'\]/g), (m) => m[1])

// The complete skipped-file list from the folder truncation note.
const skippedList = (content: string): string[] => {
	const match = content.match(/Skipped: (.+)/)
	return match ? match[1].split(", ") : []
}

// The (~M lines) total from the folder truncation note.
const inlinedLineTotal = (content: string): number => {
	const match = content.match(/Inlined \d+ file\(s\) \(~(\d+) lines\)/)
	return match ? Number(match[1]) : Number.NaN
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
	})

	it("inlines at most MAX_FOLDER_FILES_INLINED files and lists the rest as skipped", async () => {
		const names = Array.from({ length: 25 }, (_, i) => `file${String(i).padStart(2, "0")}.txt`)
		const dir = await makeTempFolder(names)
		try {
			for (const name of names) {
				await writeFile(path.join(dir, name), `contents of ${name}\n`)
			}
			const result = await parseMentions(`@/${path.basename(dir)}`, tmpdir())
			const folderBlock = result.contentBlocks.find((b) => b.type === "folder")

			expect(folderBlock).toBeTruthy()
			const content = folderBlock!.content
			// exactly the budget's worth of files inlined; the walk order is
			// filesystem-dependent, so the partition is checked as sets
			const inlined = inlinedHeaders(content).map((header) => header.split("/").pop())
			expect(inlined).toHaveLength(MAX_FOLDER_FILES_INLINED)
			expect(skippedList(content)).toHaveLength(names.length - MAX_FOLDER_FILES_INLINED)
			expect([...inlined, ...skippedList(content)].sort()).toEqual([...names].sort())
			expect(content).toContain("IMPORTANT: Folder content truncated")
			expect(content).toContain(`Inlined ${MAX_FOLDER_FILES_INLINED} file(s)`)
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
		const dir = await makeTempFolder(names)
		try {
			for (const name of names) {
				await writeFile(path.join(dir, name), makeLines(linesPerFile))
			}
			const result = await parseMentions(`@/${path.basename(dir)}`, tmpdir())
			const folderBlock = result.contentBlocks.find((b) => b.type === "folder")
			const content = folderBlock!.content

			// the walk order is filesystem-dependent, so the partition is
			// checked as sets: 4 inlined, 2 skipped, nothing lost
			const inlined = inlinedHeaders(content).map((header) => header.split("/").pop())
			expect(inlined).toHaveLength(4)
			expect(skippedList(content)).toHaveLength(2)
			expect([...inlined, ...skippedList(content)].sort()).toEqual([...names].sort())
			expect(content).toContain("Inlined 4 file(s) (~4000 lines)")
			expect(inlinedLineTotal(content)).toBeLessThanOrEqual(MAX_FOLDER_TOTAL_LINES)
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it("a single oversized notebook is inlined truncated to the budget, never dropped", async () => {
		// A notebook: the only format whose extracted content can exceed
		// the text-file limit, so it is the one that reaches the clip.
		const totalLines = MAX_FOLDER_TOTAL_LINES + 500
		const dir = await makeTempFolder(["big.ipynb"])
		await writeFile(path.join(dir, "big.ipynb"), makeNotebook(totalLines))
		try {
			const result = await parseMentions(`@/${path.basename(dir)}`, tmpdir())
			const folderBlock = result.contentBlocks.find((b) => b.type === "folder")
			const content = folderBlock!.content

			// inlined (not skipped), but bounded to the budget
			expect(inlinedHeaders(content)).toEqual([`${path.basename(dir)}/big.ipynb`])
			expect(skippedList(content)).toEqual([])
			expect(content).not.toContain("were NOT inlined")
			// the per-file truncation notice matches the clipped range
			expect(content).toContain(`Showing lines 1-${MAX_FOLDER_TOTAL_LINES} of ${totalLines + 1} total lines`)
			expect(content).toContain(`offset=${MAX_FOLDER_TOTAL_LINES + 1}`)
			// the shown content is exactly the first 4000 numbered lines
			expect(content).toContain(`${MAX_FOLDER_TOTAL_LINES} | notebook line ${MAX_FOLDER_TOTAL_LINES}`)
			expect(content).not.toContain(`notebook line ${MAX_FOLDER_TOTAL_LINES + 1}`)
			const body = content.split("File: ")[1]
			// first element of the split is the file path; the rest is the clip
			expect(body.split("\n").slice(1)).toHaveLength(MAX_FOLDER_TOTAL_LINES)
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it("adds no truncation note when everything fits", async () => {
		const names = ["a.txt", "b.txt", "c.txt"]
		const dir = await makeTempFolder(names)
		try {
			for (const name of names) {
				await writeFile(path.join(dir, name), `small content of ${name}\n`)
			}
			const result = await parseMentions(`@/${path.basename(dir)}`, tmpdir())
			const folderBlock = result.contentBlocks.find((b) => b.type === "folder")
			const content = folderBlock!.content

			expect(inlinedHeaders(content).sort()).toEqual(names.map((name) => `${path.basename(dir)}/${name}`).sort())
			expect(skippedList(content)).toEqual([])
			expect(content).not.toContain("IMPORTANT: Folder content truncated")
			expect(content).toContain("small content of a.txt")
			expect(content).toContain("small content of c.txt")
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it("a file over the budget after a small one is skipped and named, never clipped", async () => {
		// Regression evidence (PR #2680 pre-merge check): a small file is
		// inlined first, then a file of MAX_FOLDER_TOTAL_LINES + 1 lines
		// follows. The oversized file must land in the Skipped list —
		// the single-file clip path only applies to the FIRST file.
		const dir = await makeTempFolder(["a.ipynb", "b.ipynb"])
		try {
			// Assign by the real walk order (readdir order is per-
			// filesystem): a small notebook first, the oversized one
			// second — both .ipynb, so each gets notebook extraction.
			const walked = await readdir(dir)
			expect(walked).toHaveLength(2)
			await writeFile(path.join(dir, walked[0]), makeNotebook(1))
			await writeFile(path.join(dir, walked[1]), makeNotebook(MAX_FOLDER_TOTAL_LINES + 1))

			const result = await parseMentions(`@/${path.basename(dir)}`, tmpdir())
			const folderBlock = result.contentBlocks.find((b) => b.type === "folder")
			const content = folderBlock!.content

			// the oversized file is listed in the Skipped: list...
			expect(skippedList(content)).toEqual([walked[1]])
			// ...not in the [read_file for ...] headers...
			expect(inlinedHeaders(content)).toEqual([`${path.basename(dir)}/${walked[0]}`])
			// ...the content does not contain a clipped range for it...
			expect(content).not.toContain(`Showing lines 1-${MAX_FOLDER_TOTAL_LINES}`)
			// ...and the inlined total stays within the budget.
			expect(content).toContain("Inlined 1 file(s) (~2 lines)")
			expect(inlinedLineTotal(content)).toBeLessThanOrEqual(MAX_FOLDER_TOTAL_LINES)
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it("a large file is skipped after a 2000-line file is inlined; a smaller file after it is still inlined", async () => {
		// Regression evidence (PR #2680 pre-merge check): the skip must
		// not consume the budget — a later, smaller file still inlines.
		const dir = await makeTempFolder(["a.ipynb", "b.ipynb", "c.ipynb"])
		try {
			// Assign by the real walk order (readdir order is per-
			// filesystem): 2000-line notebook, then the 3000-line
			// notebook, then the 500-line notebook. Each notebook's
			// trailing extracted newline adds one shown line, so the
			// inlined total is 2001 + 501 = 2502.
			const walked = await readdir(dir)
			expect(walked).toHaveLength(3)
			await writeFile(path.join(dir, walked[0]), makeNotebook(2000))
			await writeFile(path.join(dir, walked[1]), makeNotebook(3000))
			await writeFile(path.join(dir, walked[2]), makeNotebook(500))

			const result = await parseMentions(`@/${path.basename(dir)}`, tmpdir())
			const folderBlock = result.contentBlocks.find((b) => b.type === "folder")
			const content = folderBlock!.content

			// the smaller file appears in the headers, the large one in Skipped:
			expect(inlinedHeaders(content)).toEqual([
				`${path.basename(dir)}/${walked[0]}`,
				`${path.basename(dir)}/${walked[2]}`,
			])
			expect(skippedList(content)).toEqual([walked[1]])
			expect(content).toContain("Inlined 2 file(s) (~2502 lines)")
			expect(inlinedLineTotal(content)).toBeLessThanOrEqual(MAX_FOLDER_TOTAL_LINES)
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})
})
