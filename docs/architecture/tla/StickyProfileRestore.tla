---- MODULE StickyProfileRestore ----
\* Models createTaskWithHistoryItemUnlocked in src/core/webview/ClineProvider.ts.
\* Source: the user starts a provider profile switch (activateProviderProfile) and a task restore (showTaskWithId). The task history item holds a saved profile name.
\* Sink: the profile that serves the restored task. The task constructor and the task header both read the global active profile.
\* Failure: a task restore reactivates the stale profile saved in the history item. A provider switch made after the task stopped is lost. The header then keeps the old context limit.
\* Interleaving: restores run on historyTaskCreationQueue. Profile switches run on providerProfileMutationQueue. No shared queue stops a switch during a restore. The switch cannot write the restoring task's saved name, because the task is not current until installation.
\* The restore is split at its await boundaries: evict the current task and read the modes, decide the profile, then install the task. SwitchProfile may run between the steps.
\* Invariant RestoreKeepsChosen: the active profile equals the profile the user chose.
\* Invariant StickyMatchesServing: while a task is current, its saved profile equals the active profile.
\* Mode Fixed is the fix. Mode Unfixed is the code before the fix. Mode NoRestick keeps the current profile but never writes it back to the task (a wrong partial fix).
\* Mode NoInstallRestick is the first fix as committed at c60d763ba: the decision re-sticks the task, the installation does not re-read the active profile. A switch between the two steps leaves the installed task with a stale saved name.
\* Expected: Unfixed fails RestoreKeepsChosen. NoRestick and NoInstallRestick fail StickyMatchesServing. Fixed holds both invariants for every interleaved order.
\* Result: Fixed holds both. Unfixed fails RestoreKeepsChosen after StartTask, StopTask, SwitchProfile("b"), RestoreBegin, RestoreDecide. NoRestick fails StickyMatchesServing on the same trace without a mid-restore switch. NoInstallRestick fails StickyMatchesServing only when SwitchProfile("a") runs between RestoreDecide and RestoreInstall, the trace found in PR 2649 review round 1. TLC state counts are in the Cost line.
\* Not modeled: the profile list (a profile always exists), the mode-based restore path (it runs only when the task has no saved profile), the webview (it reads the active profile, an oracle), the switch during a running task (the code already keeps that task in sync), and same-task rehydration from cancellation (PR 2649 review round 1; the code preserves the task-local profile and unit tests cover it).
\* Cost: TLC checks each mode in under 2 seconds. Fixed base: 16 states. Unfixed variant: 14 states (it fails early). NoRestick variant: 16 states. NoInstallRestick variant: 16 states. Agent time is not measured.
\* Findings: issue thread (root cause, fix direction) and PR #973 review: covered=2 (F1 restore revert, F2 stale sticky name). PR #2649 review round 1: covered=1 (F4 cancellation rehydration replaces a task-local profile, fixed in the code and unit tested), added=1 (F3 a switch between the restore decision and the installation leaves the saved name stale, a real code finding, fixed by the install-time re-stick and pinned by the NoInstallRestick variant), gap=0.

EXTENDS Naturals

CONSTANT Mode

P == {"a", "b"}                \* provider profiles
T == {"None", "Stopped", "Current"}   \* the one task
R == {"Idle", "Evicted", "Decided"}   \* the restore pipeline

VARIABLES chosen, active, sticky, task, phase
vars == <<chosen, active, sticky, task, phase>>

Init == /\ chosen = "a" /\ active = "a" /\ sticky = "a" /\ task = "None" /\ phase = "Idle"

\* A new task starts with the active profile. It also replaces a stopped task.
StartTask ==
    /\ phase = "Idle"
    /\ task # "Current"
    /\ task' = "Current"
    /\ sticky' = active
    /\ UNCHANGED <<chosen, active, phase>>

StopTask ==
    /\ phase = "Idle"
    /\ task = "Current"
    /\ task' = "Stopped"
    /\ UNCHANGED <<chosen, active, sticky, phase>>

\* The user picks a profile. A switch during a running task also writes that task's saved profile.
\* A switch during a pending restore cannot: the task is not current yet.
SwitchProfile(p) ==
    /\ p \in P
    /\ chosen' = p /\ active' = p
    /\ sticky' = IF task = "Current" THEN p ELSE sticky
    /\ UNCHANGED <<task, phase>>

\* The user restores a stopped task from history.
\* Step 1: await evictCurrentTask and getCustomModes. No profile state changes.
RestoreBegin ==
    /\ phase = "Idle"
    /\ task = "Stopped"
    /\ phase' = "Evicted"
    /\ UNCHANGED <<chosen, active, sticky, task>>

\* Step 2: the profile decision. It reads the active profile after the awaits.
\* Unfixed reactivates the stale saved profile. NoRestick keeps the active profile
\* but writes nothing back. The other modes re-stick the task to the active profile.
RestoreDecide ==
    /\ phase = "Evicted"
    /\ phase' = "Decided"
    /\ UNCHANGED task
    /\ IF Mode = "Unfixed"
          THEN /\ active' = sticky /\ sticky' = sticky /\ UNCHANGED chosen
          ELSE IF Mode = "NoRestick"
               THEN UNCHANGED <<chosen, active, sticky>>
               ELSE /\ sticky' = active /\ UNCHANGED <<chosen, active>>

\* Step 3: await getState, then install the task as current.
\* A switch may have run after the decision. Fixed re-reads the active profile
\* at installation and re-sticks the task to it. NoInstallRestick does not.
RestoreInstall ==
    /\ phase = "Decided"
    /\ phase' = "Idle"
    /\ task' = "Current"
    /\ IF Mode = "Fixed"
          THEN sticky' = active
          ELSE UNCHANGED sticky
    /\ UNCHANGED <<chosen, active>>

Next == StartTask \/ StopTask \/ RestoreBegin \/ RestoreDecide \/ RestoreInstall \/ (\E p \in P : SwitchProfile(p))

Spec == Init /\ [][Next]_vars

TypeOK == /\ chosen \in P /\ active \in P /\ sticky \in P /\ task \in T /\ phase \in R

\* The active profile is the profile the user chose. A restore must not discard it.
RestoreKeepsChosen == chosen = active

\* While a task is current, its saved profile matches the profile that serves it.
StickyMatchesServing == task = "Current" => sticky = active
====
