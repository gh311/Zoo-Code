---- MODULE StickyProfileRestore ----
\* Models createTaskWithHistoryItemUnlocked in src/core/webview/ClineProvider.ts.
\* Source: the user starts a provider profile switch (activateProviderProfile) and a task restore (showTaskWithId). The task history item holds a saved profile name.
\* Sink: the profile that serves the restored task. The task constructor and the task header both read the global active profile.
\* Failure: a task restore reactivates the stale profile saved in the history item. A provider switch made after the task stopped is lost.
\* Interleaving: restores run on historyTaskCreationQueue. Profile switches run on providerProfileMutationQueue. No shared queue stops a switch during a restore. The switch cannot write the restoring task's saved name, because the task is not current until installation.
\* The restore is split at its await boundaries: evict the current task and read the modes, decide the profile, then the install pipeline. The install pipeline (round 10, thread 4680307478): an await reads the serving name, then up to three rounds run. Each round captures the selection in one synchronous step and awaits the history write. The write completes as its own step, so a switch may land between two rounds. The third round ends the loop. A switch that completes during its write loses the race by construction.
\* Policy input (round 10, thread 4680307490): the caller hands a policy to the restore. retain-current keeps the user's current profile, as explicit history navigation must. retain-saved reactivates the saved profile, as automatic parent restoration and delegation rollback must. RestoreBegin carries the input; CallerPolicies limits the domain per config. Mode Round10Bug is the code before this round: the decision applies the keep-current override whatever the caller asked.
\* Mode Fixed is the fix. Mode Unfixed is the code before the first fix. Mode NoRestick keeps the current profile but never writes it back to the task (a wrong partial fix). Mode NoInstallRestick is the first fix as committed at c60d763ba: the decision re-sticks the task, the installation does not re-read the active profile. The last three modes install without the round pipeline.
\* Activation controls the matching-profile activation step, added in round 2. Guarded applies the activation only when no switch landed after the decision. Unguarded is the merged code: the activation writes the active profile without a concurrent-switch guard. Off disables the step, so the round-1 sabotage configs keep their round-1 traces.
\* Invariant RestoreKeepsChosen: the active profile is the profile the user chose. Not checked under retain-saved: an automatic restore reverts the user's post-stop switch on purpose.
\* Invariant StickyMatchesServing: while a task is current, its saved profile equals the active profile, unless the third round's write lost the race.
\* Invariant SavedSurvivesAutoRestore: a retain-saved restore that saw no switch keeps the profile the task had saved when the restore began.
\* NoFinalWriteLoss is not an invariant of the code. The FinalWriteRace config runs it and must fail, so the model reaches the final-write outcome.
\* Expected: Unfixed fails RestoreKeepsChosen. NoRestick and NoInstallRestick fail StickyMatchesServing. ActivationOverwrite fails RestoreKeepsChosen. RetainSaved fails RestoreKeepsChosen by design and holds StickyMatchesServing and SavedSurvivesAutoRestore. AutoRestorePolicy fails SavedSurvivesAutoRestore: Round10Bug re-sticks the saved name on an automatic restore with no switch. FinalWriteRace fails NoFinalWriteLoss on the bounded loss. The base holds the rest.
\* Result: Fixed holds the base. Unfixed fails RestoreKeepsChosen after StartTask, StopTask, SwitchProfile("b"), RestoreBegin, RestoreDecide. NoRestick fails StickyMatchesServing on the same trace without a mid-restore switch. NoInstallRestick fails StickyMatchesServing only when a switch runs between RestoreDecide and RestoreInstall. ActivationOverwrite fails RestoreKeepsChosen when a switch runs between RestoreDecide and RestoreActivate on the matching path, a race that predates this PR. FinalWriteRace fails on the bounded loss, the trace the review asked for: enter reconcile with saved "a", SwitchProfile("b") lands before round 1, then switches "a" and "b" land after rounds 1 and 2, round 3 captures "b", and a final switch to "a" lands after round 3's write; the task installs Current with saved "b" while the active profile is "a" (round 10, thread 4680307478). RetainSaved fails RestoreKeepsChosen by design, the revert of the user's post-stop switch, and holds StickyMatchesServing and SavedSurvivesAutoRestore over 164 states.
\* Not modeled: the profile list (a profile always exists), the settings half of each captured pair (the code reads name and settings in one step; the model keeps names only), the mode-based restore path, the webview, the switch during a running task (the code already keeps that task in sync), same-task rehydration from cancellation, and the code shape of the activation guard.
\* Cost: TLC checks each config in under 2 seconds. Base: 128 states. RetainSaved: 28 states to the designed violation, 164 states for the two holding invariants. AutoRestorePolicy: 52 states. FinalWriteRace: 117 states. NoInstallRestick: 35 states. NoRestick: 35 states. ActivationOverwrite: 39 states. StaleOverwrite: 27 states. Agent time is not measured.
\* Findings: issue thread (root cause, fix direction) and PR #973 review: covered=2 (F1 restore revert, F2 stale sticky name). PR #2649 review round 1: covered=1 (F4 cancellation rehydration replaces a task-local profile), added=1 (F3 a switch between the restore decision and the installation leaves the saved name stale, pinned by NoInstallRestick), gap=0. Round 2: covered=1 (F5 the matching-profile activation order, pinned by RestoreActivate and ActivationOverwrite), added=1 (F6 a switch during the getState allow-list await re-sticks the name on stale settings), gap=0. Round 10: added=2 (F7 the install was one atomic re-read; capture, write-completion and installation are now separate actions with the three-round bound and the FinalWriteRace config, thread 4680307478; F8 the restoration policy input retain-current vs retain-saved, pinned by RetainSaved and AutoRestorePolicy, thread 4680307490), covered=0, gap=0.

EXTENDS Naturals

CONSTANT Mode
CONSTANT Activation
CONSTANT CallerPolicies

P == {"a", "b"}                \* provider profiles
POL == {"retain-current", "retain-saved"}   \* the caller's restoration policy
T == {"None", "Stopped", "Current"}   \* the one task
R == {"Idle", "Evicted", "Decided", "Activating", "Reconciling", "Writing"}   \* the restore pipeline
M == {"None", "Match", "Differ"}   \* the decision path

VARIABLES chosen, active, sticky, task, phase, match, rounds, savedAtRestore, switched, policy
vars == <<chosen, active, sticky, task, phase, match, rounds, savedAtRestore, switched, policy>>

\* Fixed and Round10Bug share the install pipeline. They differ only at the decision.
PipelineMode == Mode \in {"Fixed", "Round10Bug"}

Init == /\ chosen = "a"
        /\ active = "a"
        /\ sticky = "a"
        /\ task = "None"
        /\ phase = "Idle"
        /\ match = "None"
        /\ rounds = 0
        /\ savedAtRestore = "a"
        /\ switched = FALSE
        /\ policy = "retain-current"

\* A new task starts with the active profile. It also replaces a stopped task.
StartTask ==
    /\ phase = "Idle"
    /\ task # "Current"
    /\ task' = "Current"
    /\ sticky' = active
    /\ rounds' = 0
    /\ savedAtRestore' = sticky'
    /\ switched' = FALSE
    /\ policy' = "retain-current"
    /\ UNCHANGED <<chosen, active, phase, match>>

StopTask ==
    /\ phase = "Idle"
    /\ task = "Current"
    /\ task' = "Stopped"
    /\ rounds' = 0
    /\ UNCHANGED <<chosen, active, sticky, phase, match, savedAtRestore, switched, policy>>

\* The user picks a profile. A switch during a running task also writes that task's saved profile.
\* A switch during a pending restore cannot: the task is not current yet.
\* switched records a switch the restore could observe: after it began, or while the task serves.
SwitchProfile(p) ==
    /\ p \in P
    /\ chosen' = p
    /\ active' = p
    /\ sticky' = IF task = "Current" THEN p ELSE sticky
    /\ switched' = (phase # "Idle" \/ task = "Current")
    /\ UNCHANGED <<task, phase, match, rounds, savedAtRestore, policy>>

\* The user restores a stopped task from history. The caller hands the policy.
\* Step 1: await evictCurrentTask and getCustomModes. No profile state changes.
RestoreBegin(p) ==
    /\ p \in CallerPolicies
    /\ phase = "Idle"
    /\ task = "Stopped"
    /\ phase' = "Evicted"
    /\ policy' = p
    /\ savedAtRestore' = sticky
    /\ switched' = FALSE
    /\ UNCHANGED <<chosen, active, sticky, task, match, rounds>>

\* Step 2: the profile decision. It reads the active profile after the awaits.
\* retain-saved reactivates the saved profile, as an automatic restore must.
\* Round10Bug ignores the input and keeps the current profile instead. Unfixed
\* reactivates the stale saved profile. NoRestick writes nothing back.
RestoreDecide ==
    /\ phase = "Evicted"
    /\ phase' = "Decided"
    /\ UNCHANGED task
    /\ match' = IF sticky = active THEN "Match" ELSE "Differ"
    /\ IF policy = "retain-saved" /\ Mode # "Round10Bug"
          THEN /\ active' = sticky
               /\ UNCHANGED <<chosen, sticky>>
          ELSE IF Mode = "Unfixed"
               THEN /\ active' = sticky
                    /\ UNCHANGED <<chosen, sticky>>
               ELSE IF Mode = "NoRestick"
                    THEN UNCHANGED <<chosen, active, sticky>>
                    ELSE /\ sticky' = active
                         /\ UNCHANGED <<chosen, active>>
    /\ UNCHANGED <<rounds, savedAtRestore, switched, policy>>

\* Step 2b: the matching-profile activation. Guarded applies the write only
\* when no switch landed. Unguarded overwrites the switch (round 2).
RestoreActivate ==
    /\ Activation # "Off"
    /\ phase = "Decided"
    /\ match = "Match"
    /\ phase' = "Activating"
    /\ IF Activation = "Unguarded" \/ active = sticky
          THEN active' = sticky
          ELSE UNCHANGED active
    /\ UNCHANGED <<chosen, sticky, task, match, rounds, savedAtRestore, switched, policy>>

\* Step 3: await getState, then read the serving name. The pipeline modes run the rounds.
RestoreAwait ==
    /\ PipelineMode
    /\ (phase = "Activating"
        \/ (phase = "Decided" /\ (match = "Differ" \/ Activation = "Off")))
    /\ phase' = "Reconciling"
    /\ rounds' = 0
    /\ UNCHANGED <<chosen, active, sticky, task, match, savedAtRestore, switched, policy>>

\* One round: capture the latest completed selection and apply it. The capture
\* and the apply are one synchronous step, as in the code (round 5).
RestoreCapture ==
    /\ phase = "Reconciling"
    /\ rounds < 3
    /\ active # sticky
    /\ sticky' = active
    /\ rounds' = rounds + 1
    /\ phase' = "Writing"
    /\ UNCHANGED <<chosen, active, task, match, savedAtRestore, switched, policy>>

\* The history write completes. A switch may land before or after this step.
RestoreWriteComplete ==
    /\ phase = "Writing"
    /\ phase' = "Reconciling"
    /\ UNCHANGED <<chosen, active, sticky, task, match, rounds, savedAtRestore, switched, policy>>

\* Step 4: install the task as current. The pipeline modes install when the
\* serving name matches the saved one, or the third round ended the loop.
\* The other modes install straight from the decision, with no re-read.
RestoreInstall ==
    /\ phase' = "Idle"
    /\ task' = "Current"
    /\ match' = "None"
    /\ UNCHANGED <<chosen, active, sticky, savedAtRestore, switched, policy>>
    /\ \/ /\ phase = "Reconciling"
         /\ PipelineMode
         /\ (active = sticky \/ rounds = 3)
         /\ UNCHANGED rounds
      \/ /\ phase \in {"Decided", "Activating"}
         /\ ~PipelineMode
         /\ UNCHANGED rounds

Next == StartTask \/ StopTask \/ (\E p \in CallerPolicies : RestoreBegin(p))
        \/ RestoreDecide \/ RestoreActivate \/ RestoreAwait
        \/ RestoreCapture \/ RestoreWriteComplete \/ RestoreInstall
        \/ (\E p \in P : SwitchProfile(p))

Spec == Init /\ [][Next]_vars

TypeOK == /\ chosen \in P /\ active \in P /\ sticky \in P
          /\ task \in T /\ phase \in R /\ match \in M
          /\ rounds \in 0..3 /\ savedAtRestore \in P
          /\ switched \in BOOLEAN /\ policy \in POL

\* The active profile is the profile the user chose. A restore must not discard it.
RestoreKeepsChosen == chosen = active

\* While a task is current, its saved profile matches the profile that serves it.
\* One exception: the third round's write lost its race (round 10).
StickyMatchesServing == task = "Current" => (sticky = active \/ rounds = 3)

\* An automatic restore that saw no switch keeps the profile the task saved
\* when the restore began. This is the retain-saved contract.
SavedSurvivesAutoRestore ==
    (policy = "retain-saved" /\ task = "Current" /\ ~switched) => sticky = savedAtRestore

\* The negation of the final-write outcome. The FinalWriteRace config runs it
\* and must fail, so the model reaches the bounded loss.
NoFinalWriteLoss == task = "Current" => sticky = active
====
