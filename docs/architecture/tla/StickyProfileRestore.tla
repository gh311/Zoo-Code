---- MODULE StickyProfileRestore ----
\* Models createTaskWithHistoryItemUnlocked in src/core/webview/ClineProvider.ts.
\* Source: the user starts a provider profile switch (activateProviderProfile) and a task restore (showTaskWithId). The task history item holds a saved profile name.
\* Sink: the profile that serves the restored task. The task constructor and the task header both read the global active profile.
\* Failure: a task restore reactivates the stale profile saved in the history item. A provider switch made after the task stopped is lost. The header then keeps the old context limit.
\* Interleaving: restores run on historyTaskCreationQueue. Profile switches run on providerProfileMutationQueue. No shared queue stops a switch during a restore. The switch cannot write the restoring task's saved name, because the task is not current until installation.
\* The restore is split at its await boundaries: evict the current task and read the modes, decide the profile (differing names: keep the current profile; matching names: re-list the profiles and activate the saved one), then install the task. SwitchProfile may run between any two steps.
\* Invariant RestoreKeepsChosen: the active profile equals the profile the user chose.
\* Invariant StickyMatchesServing: while a task is current, its saved profile equals the active profile.
\* Mode Fixed is the fix. Mode Unfixed is the code before the fix. Mode NoRestick keeps the current profile but never writes it back to the task (a wrong partial fix).
\* Mode NoInstallRestick is the first fix as committed at c60d763ba: the decision re-sticks the task, the installation does not re-read the active profile. A switch between the two steps leaves the installed task with a stale saved name.
\* Activation controls the matching-profile activation step, added in round 2. Guarded applies the activation only when no switch landed after the decision (the code guard is a separate follow-up). Unguarded is the merged code: the activation writes the active profile without a concurrent-switch guard. Off disables the step, so the round-1 sabotage configs keep their round-1 traces.
\* Expected: Unfixed fails RestoreKeepsChosen. NoRestick and NoInstallRestick fail StickyMatchesServing. ActivationOverwrite fails RestoreKeepsChosen: the merged code's activation overwrites a concurrent switch. Fixed with a guarded activation holds both invariants for every interleaved order.
\* Result: Fixed holds both. Unfixed fails RestoreKeepsChosen after StartTask, StopTask, SwitchProfile("b"), RestoreBegin, RestoreDecide. NoRestick fails StickyMatchesServing on the same trace without a mid-restore switch. NoInstallRestick fails StickyMatchesServing only when SwitchProfile("a") runs between RestoreDecide and RestoreInstall, the trace found in PR 2649 review round 1. ActivationOverwrite fails RestoreKeepsChosen when SwitchProfile("b") runs between RestoreDecide and RestoreActivate on the matching path: the activation rewrites the active profile to the saved one and discards the switch. The write is in activateProviderProfileUnlocked: it sets currentApiConfigName without a guard on expectedCurrentTaskId, a race that predates this PR (the activation branch is outside this PR's diff). TLC state counts are in the Cost line.
\* Not modeled: the profile list (a profile always exists), the mode-based restore path (it runs only when the task has no saved profile), the webview (it reads the active profile, an oracle), the switch during a running task (the code already keeps that task in sync), same-task rehydration from cancellation (PR 2649 review round 1; the code preserves the task-local profile and unit tests cover it), and the code shape of the activation guard (the follow-up; Guarded states the property it must give).
\* Cost: TLC checks each mode in under 2 seconds. Fixed base: 24 states. Unfixed variant: 14 states. NoRestick variant: 17 states. NoInstallRestick variant: 17 states. ActivationOverwrite variant: 19 states. Agent time is not measured.
\* Findings: issue thread (root cause, fix direction) and PR #973 review: covered=2 (F1 restore revert, F2 stale sticky name). PR #2649 review round 1: covered=1 (F4 cancellation rehydration replaces a task-local profile, fixed in the code and unit tested), added=1 (F3 a switch between the restore decision and the installation leaves the saved name stale, a real code finding, fixed by the install-time re-stick and pinned by the NoInstallRestick variant), gap=0. PR #2649 review round 2: covered=1 (F5 the spec could not reach the matching-profile activation order; the RestoreActivate step and the ActivationOverwrite variant now pin it, and TLC shows RestoreKeepsChosen fails on the unguarded order, a race that predates this PR, so the code guard is a separate follow-up), added=1 (F6 a switch that completes during the getState allow-list await re-sticks the name while the task keeps the stale settings, a real code finding, fixed by the one-point install read and unit tested), gap=0.

EXTENDS Naturals

CONSTANT Mode
CONSTANT Activation

P == {"a", "b"}                \* provider profiles
T == {"None", "Stopped", "Current"}   \* the one task
R == {"Idle", "Evicted", "Decided", "Activating"}   \* the restore pipeline
M == {"None", "Match", "Differ"}   \* the decision path

VARIABLES chosen, active, sticky, task, phase, match
vars == <<chosen, active, sticky, task, phase, match>>

Init == /\ chosen = "a" /\ active = "a" /\ sticky = "a" /\ task = "None" /\ phase = "Idle" /\ match = "None"

\* A new task starts with the active profile. It also replaces a stopped task.
StartTask ==
    /\ phase = "Idle"
    /\ task # "Current"
    /\ task' = "Current"
    /\ sticky' = active
    /\ UNCHANGED <<chosen, active, phase, match>>

StopTask ==
    /\ phase = "Idle"
    /\ task = "Current"
    /\ task' = "Stopped"
    /\ UNCHANGED <<chosen, active, sticky, phase, match>>

\* The user picks a profile. A switch during a running task also writes that task's saved profile.
\* A switch during a pending restore cannot: the task is not current yet.
SwitchProfile(p) ==
    /\ p \in P
    /\ chosen' = p /\ active' = p
    /\ sticky' = IF task = "Current" THEN p ELSE sticky
    /\ UNCHANGED <<task, phase, match>>

\* The user restores a stopped task from history.
\* Step 1: await evictCurrentTask and getCustomModes. No profile state changes.
RestoreBegin ==
    /\ phase = "Idle"
    /\ task = "Stopped"
    /\ phase' = "Evicted"
    /\ UNCHANGED <<chosen, active, sticky, task, match>>

\* Step 2: the profile decision. It reads the active profile after the awaits.
\* Unfixed reactivates the stale saved profile. NoRestick keeps the active profile
\* but writes nothing back. The other modes re-stick the task to the active profile.
\* Match records the path the code took: the saved name equals the current one, or it does not.
RestoreDecide ==
    /\ phase = "Evicted"
    /\ phase' = "Decided"
    /\ UNCHANGED task
    /\ match' = IF sticky = active THEN "Match" ELSE "Differ"
    /\ IF Mode = "Unfixed"
          THEN /\ active' = sticky /\ sticky' = sticky /\ UNCHANGED chosen
          ELSE IF Mode = "NoRestick"
               THEN UNCHANGED <<chosen, active, sticky>>
               ELSE /\ sticky' = active /\ UNCHANGED <<chosen, active>>

\* Step 2b: the matching-profile activation. The code awaits listConfig, then
\* activates the saved profile. The activation writes the active profile without
\* a guard on a switch that completed during the await. Unguarded (the merged
\* code) overwrites that switch. Guarded (the follow-up) applies the write only
\* when no switch landed. Off keeps the round-1 model.
RestoreActivate ==
    /\ Activation # "Off"
    /\ phase = "Decided"
    /\ match = "Match"
    /\ phase' = "Activating"
    /\ IF Activation = "Unguarded" \/ active = sticky
          THEN active' = sticky
          ELSE UNCHANGED active
    /\ UNCHANGED <<chosen, sticky, task, match>>

\* Step 3: await getState, then install the task as current.
\* A switch may have run after the decision or the activation. Fixed re-reads
\* the active profile at installation and re-sticks the task to it.
\* NoInstallRestick does not. The matching path must pass through the activation.
RestoreInstall ==
    /\ phase = "Activating" \/ (phase = "Decided" /\ (Activation = "Off" \/ match = "Differ"))
    /\ phase' = "Idle"
    /\ task' = "Current"
    /\ match' = "None"
    /\ IF Mode = "Fixed"
          THEN sticky' = active
          ELSE UNCHANGED sticky
    /\ UNCHANGED <<chosen, active>>

Next == StartTask \/ StopTask \/ RestoreBegin \/ RestoreDecide \/ RestoreActivate \/ RestoreInstall \/ (\E p \in P : SwitchProfile(p))

Spec == Init /\ [][Next]_vars

TypeOK == /\ chosen \in P /\ active \in P /\ sticky \in P /\ task \in T /\ phase \in R /\ match \in M

\* The active profile is the profile the user chose. A restore must not discard it.
RestoreKeepsChosen == chosen = active

\* While a task is current, its saved profile matches the profile that serves it.
StickyMatchesServing == task = "Current" => sticky = active
====
