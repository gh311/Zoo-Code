---- MODULE FolderMentionBudget ----
\* Models getFileOrFolderContentWithMetadata's directory branch in
EXTENDS Naturals, FiniteSets
\* src/core/mentions/index.ts (folder mentions, #1539).
\* Source: a folder listing (the set of readable text files with their shown
\* line counts; readdir order is an oracle — TLC tries every order).
\* Sink: the folder mention content block, which persists in
\* apiConversationHistory and re-enters every later request.
\* Failure 1: one folder mention inlines more lines than the aggregate budget.
\* Failure 2: a file in the listing is neither inlined nor listed as skipped.
\* Failure 3: a file is skipped silently (no truncation note in the block).
\* Invariants: BudgetNeverExceeded, FileCapRespected, NoSilentLoss,
\* NoteMatchesSkips.
\* Expected before the run: Fixed holds. Sabotages fail: NoCap lets
\* totalLines pass MAX_LINES; SkipNoNote leaves a dropped file out of
\* skipped, so NoSilentLoss fails.
\* Result: Fixed holds in 2165 states; NoCap fails in 93 states
\* (BudgetNeverExceeded); SkipNoNote fails in 1894 states (NoSilentLoss).
\* Not modeled: ignore rules (rooIgnoreController is a pre-filter, orthogonal
\* to the budget); binary detection (skip-on-binary, not budget-related);
\* the per-file DEFAULT_LINE_LIMIT (an oracle input: size already IS the
\* shown line count).
\* Cost: TLC runs in a few seconds with 4 files.
\* Review (PR #2668-followup, #1539): 0 covered, 0 added, 0 gap. First
\* version written with the fix.

CONSTANT MAX_LINES   \* the aggregate line budget (MAX_FOLDER_TOTAL_LINES = 4000 in code)
CONSTANT MAX_FILES   \* the file-count cap (MAX_FOLDER_FILES_INLINED = 20 in code)

VARIABLES
    remaining,   \* files not yet processed (set of ids)
    size,        \* oracle: shown line count per file
    inlined,     \* count of files inlined
    inlinedSet,  \* which files were inlined
    totalLines,  \* total lines entering the sink
    skipped,     \* which files were skipped (must be listed in the note)
    note         \* the truncation note is present

FILES == {1, 2, 3, 4}
SIZES == {1, 2, 5}   \* 5 > MAX_LINES exercises the oversized path

Init ==
    /\ remaining = FILES
    /\ size \in [FILES -> SIZES]
    /\ inlined = 0
    /\ inlinedSet = {}
    /\ totalLines = 0
    /\ skipped = {}
    /\ note = FALSE

\* The budget gate as the code implements it. Sabotaged in the MC module.
BudgetGate(lines, count, total) ==
    /\ lines <= MAX_LINES
    /\ count < MAX_FILES
    /\ total + lines <= MAX_LINES

\* A single oversized file is inlined truncated to the budget share.
OversizeTruncate(f) ==
    /\ size[f] > MAX_LINES
    /\ inlined = 0
    /\ remaining' = remaining \ {f}
    /\ inlined' = inlined + 1
    /\ inlinedSet' = inlinedSet \cup {f}
    /\ totalLines' = MAX_LINES
    /\ UNCHANGED <<size, skipped, note>>

Inline(f) ==
    /\ BudgetGate(size[f], inlined, totalLines)
    /\ remaining' = remaining \ {f}
    /\ inlined' = inlined + 1
    /\ inlinedSet' = inlinedSet \cup {f}
    /\ totalLines' = totalLines + size[f]
    /\ UNCHANGED <<size, skipped, note>>

\* Any file that cannot fit is skipped and MUST be named in the note.
Skip(f) ==
    /\ ~BudgetGate(size[f], inlined, totalLines)
    /\ ~(size[f] > MAX_LINES /\ inlined = 0)
    /\ remaining' = remaining \ {f}
    /\ skipped' = skipped \cup {f}
    /\ note' = TRUE
    /\ UNCHANGED <<size, inlined, inlinedSet, totalLines>>

Next == \E f \in remaining : Inline(f) \/ OversizeTruncate(f) \/ Skip(f)

Spec == Init /\ [][Next]_<<remaining, size, inlined, inlinedSet, totalLines, skipped, note>>

TypeOK ==
    /\ totalLines <= MAX_LINES
    /\ inlined <= Cardinality(FILES)
    /\ note \in BOOLEAN

\* Safety Rule 1: the sink never receives more than the aggregate budget.
BudgetNeverExceeded == totalLines <= MAX_LINES

\* Safety Rule 2: the count cap is respected.
FileCapRespected == inlined <= MAX_FILES

\* Safety Rule 3: every file in the listing is accounted for in the block —
\* inlined or named as skipped. No file vanishes silently.
NoSilentLoss == (remaining = {}) => \A f \in FILES : f \in inlinedSet \/ f \in skipped

\* Safety Rule 4: a note is present iff files were skipped.
NoteMatchesSkips == (remaining = {}) => (skipped # {} <=> note)

====

