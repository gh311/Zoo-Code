// npx vitest core/mentions/__tests__/index.notebook.spec.ts
//
// Unlike index.spec.ts, this file does NOT mock extract-text: the regression
// below must run the REAL .ipynb extractor end-to-end through the
// folder-mention budget clipping path.

import { mkdtemp, writeFile, rm } from "fs/promises"
import { tmpdir } from "os"
import path from "path"

import { parseMentions, MAX_FOLDER_TOTAL_LINES } from "../index"

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

describe("parseMentions - notebook clipped to the folder budget (#1539)", () => {
	it("a notebook exceeding the budget is inlined truncated with a notice showing lines 1-4000 and offset=4001", async () => {
		// One code cell with more source lines than the folder budget; the
		// real extractor numbers every line and reports wasTruncated: false,
		// so the clip must overlay the truncation metadata itself.
		const notebookLines = MAX_FOLDER_TOTAL_LINES + 500
		const notebook = {
			cells: [
				{
					cell_type: "code",
					source: Array.from({ length: notebookLines }, (_, i) => `notebook line ${i + 1}`),
				},
			],
		}
		const dir = await mkdtemp(path.join(tmpdir(), "mentions-notebook-"))
		await writeFile(path.join(dir, "big.ipynb"), JSON.stringify(notebook))
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
})
