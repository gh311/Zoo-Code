---- MODULE FolderMentionBudgetMC ----
\* Model-checking settings and sabotage variants for FolderMentionBudget.
EXTENDS FolderMentionBudget
\* Sabotage 1 (NoCap.cfg): the budget gate is removed. Every file inlines.
BudgetGateNoCap(lines, count, total) == TRUE

\* Sabotage 2 (SkipNoNote.cfg): the skip path drops the file without adding
\* it to skipped and without raising the note.
SkipNoNote(f) ==
    /\ ~BudgetGate(size[f], inlined, totalLines)
    /\ ~(size[f] > MAX_LINES /\ inlined = 0)
    /\ remaining' = remaining \ {f}
    /\ note' = FALSE
    /\ UNCHANGED <<size, inlined, inlinedSet, totalLines, skipped>>

====

