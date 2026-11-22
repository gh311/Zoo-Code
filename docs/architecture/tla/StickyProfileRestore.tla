---- MODULE StickyProfileRestore ----
\* Models createTaskWithHistoryItemUnlocked in src/core/webview/ClineProvider.ts.
\* Source: the user starts a provider profile switch (activateProviderProfile) and a task restore (showTaskWithId). The task history item holds a saved profile name.
\* Sink: the profile that serves the restored task. The task constructor and the task header both read the global active profile.
\* Failure: a task restore reactivates the stale profile saved in the history item. A provider switch made after the task stopped is lost. The header then keeps the old context limit.
\* Invariant RestoreKeepsChosen: the active profile equals the profile the user chose.
\* Invariant StickyMatchesServing: while a task is current, its saved profile equals the active profile.
\* Mode Fixed is the fix. Mode Unfixed is the code before the fix. Mode NoRestick keeps the current profile but does not write it back to the task (a wrong partial fix).
\* Expected: Unfixed fails RestoreKeepsChosen. NoRestick fails StickyMatchesServing. Fixed holds both.
\* Result: Fixed holds both invariants. Unfixed fails RestoreKeepsChosen after StartTask, StopTask, SwitchProfile("b"), RestoreTask. NoRestick fails StickyMatchesServing on the same trace.
\* Not modeled: the profile list (a profile always exists), the mode-based restore path (it runs only when the task has no saved profile), the webview (it reads the active profile, an oracle), and the switch during a running task (the code already keeps that task in sync).
\* Cost: TLC runs in under 1 second. Agent time is not measured.
\* Findings: issue thread (root cause, fix direction) and the closed PR #973 review: covered=2 (F1 restore revert, F2 stale sticky name), added=0, gap=0. The PR review found no code issues.

EXTENDS Naturals

CONSTANT Mode

P == {"a", "b"}                \* provider profiles
T == {"None", "Stopped", "Current"}   \* the one task

VARIABLES chosen, active, sticky, task
vars == <<chosen, active, sticky, task>>

Init == /\ chosen = "a" /\ active = "a" /\ sticky = "a" /\ task = "None"

\* A new task starts with the active profile. It also replaces a stopped task.
StartTask ==
    /\ task # "Current"
    /\ task' = "Current"
    /\ sticky' = active
    /\ UNCHANGED <<chosen, active>>

StopTask ==
    /\ task = "Current"
    /\ task' = "Stopped"
    /\ UNCHANGED <<chosen, active, sticky>>

\* The user picks a profile. A switch during a running task also writes that task's saved profile.
SwitchProfile(p) ==
    /\ p \in P
    /\ chosen' = p /\ active' = p
    /\ sticky' = IF task = "Current" THEN p ELSE sticky
    /\ UNCHANGED task

\* The user restores a stopped task from history.
RestoreTask ==
    /\ task = "Stopped"
    /\ task' = "Current"
    /\ IF Mode = "Unfixed"
          THEN /\ active' = sticky /\ sticky' = sticky /\ UNCHANGED chosen
          ELSE IF Mode = "NoRestick"
               THEN UNCHANGED <<chosen, active, sticky>>
               ELSE /\ sticky' = active /\ UNCHANGED <<chosen, active>>

Next == StartTask \/ StopTask \/ RestoreTask \/ (\E p \in P : SwitchProfile(p))

Spec == Init /\ [][Next]_vars

TypeOK == /\ chosen \in P /\ active \in P /\ sticky \in P /\ task \in T

\* The active profile is the profile the user chose. A restore must not discard it.
RestoreKeepsChosen == chosen = active

\* While a task is current, its saved profile matches the profile that serves it.
StickyMatchesServing == task = "Current" => sticky = active
====
