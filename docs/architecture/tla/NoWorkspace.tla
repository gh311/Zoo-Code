---- MODULE NoWorkspace ----
\* Models the no-workspace paths for issue #1271.
\* Source: WorkspaceTracker.getOpenedTabsInfo and workspaceDidUpdate
\* (src/integrations/workspace/WorkspaceTracker.ts); the task cwd fallback
\* (src/core/task/Task.ts via getNoWorkspaceFallbackPath); the Desktop
\* example in src/core/prompts/sections/rules.ts.
\* Sink: the @file mention resolution in src/core/mentions/index.ts
\* (path.resolve(cwd, mentionPath)); the task cwd; the prompt text that
\* steers the model to explore the Desktop.
\* Input domain: tracker cwd in {"", root}; the Desktop exists or not;
\* one open tab inside the root or in the home folder.
\* Failure 1: no workspace and the tracker posts no tabs. The @file menu
\* is empty.
\* Failure 2: no workspace and the tab path is made "relative" against the
\* empty cwd. The mention resolves to a path that is not the open tab.
\* Failure 3: no Desktop directory and the task cwd is still Desktop. The
\* cwd does not exist on the system.
\* Failure 4: no Desktop directory and the prompt still steers the model
\* to explore the Desktop.
\* Invariants: TabsReachWebview, MentionResolvesToOpenTab, TaskCwdExists,
\* NoPhantomDesktopSteer.
\* Expected before the run: the Unfixed config models the old code and
\* must fail. The fixed config must hold. Each sabotage drops one guard.
\* Result: Fixed holds in 8 distinct states. Unfixed and NoPost violate
\* TabsReachWebview; RelAlways violates MentionResolvesToOpenTab; DeskAlways
\* violates TaskCwdExists; SteerAlways violates NoPhantomDesktopSteer. Each
\* violation is found in an initial state, so TLC halts before a full count.
\* Replay: failures 1 and 2 leaked in the real code before the fix (the red
\* WorkspaceTracker tests: zero posts without a workspace, and the tab path
\* "../../../../user/notes.txt"). Failure 3 is the reporter's system in
\* issue #1271 (home folder "desktop", lowercase). Failure 4 leaked in the
\* red generateSystemPrompt test (Desktop example with no Desktop). No false
\* alarms.
\* Not modeled: the webview slash normalization (cosmetic; both forms
\* resolve); the debounce timers; multi-root workspaces.
\* Cost: TLC runs in under a second with 8 input states.
\* Review: 0 covered, 0 added, 0 gap. First version written with the fix.

EXTENDS Naturals

CONSTANTS
    \* Tracker posts workspaceUpdated with openedTabs when cwd = "".
    PostNoCwd,
    \* Without a cwd the tab path is absolute, not relative against "".
    AbsWhenNoCwd,
    \* Task cwd uses Desktop only when the Desktop directory exists.
    DeskOnlyIfExists,
    \* The Desktop prompt example appears only when Desktop exists.
    GateDesktopSteer

VARIABLES
    cwd,   \* tracker cwd: "" (no workspace) or "WS" (workspace root)
    desk,  \* the Desktop directory exists
    loc    \* open tab location: "in" (inside the root) or "out" (home)

Cwds == {"", "WS"}
Locs == {"in", "out"}

\* The real fs path of the open tab. "in" lives under the root.
TabFs(l) == IF l = "in" THEN "WS/a.ts" ELSE "HOME/x.ts"

\* The path the tracker posts. With a root it is relative and round-trips
\* through path.resolve. Without one it is absolute, garbage, or unposted.
PostedPath(l) ==
    IF cwd # "" THEN IF l = "in" THEN "relIn" ELSE "relOut"
    ELSE IF ~PostNoCwd THEN "unposted"
    ELSE IF AbsWhenNoCwd THEN TabFs(l)
    ELSE "garbage"

\* The mention sink: path.resolve(taskCwd, postedPath).
Resolve(p) ==
    IF p \in {"WS/a.ts", "HOME/x.ts"} THEN p
    ELSE IF p = "relIn" THEN "WS/a.ts"
    ELSE IF p = "relOut" THEN "HOME/x.ts"
    ELSE "LOST"

\* Task.ts: parentWorkspace ?? getWorkspacePath(fallback).
TaskCwd == IF cwd # "" THEN "WS"
    ELSE IF DeskOnlyIfExists /\ desk THEN "DESK"
    ELSE IF DeskOnlyIfExists THEN "HOME"
    ELSE "DESK"

\* rules.ts: the Desktop example is gated on the directory existing.
Steer == IF GateDesktopSteer THEN desk ELSE TRUE

TypeOK == /\ cwd \in Cwds
    /\ desk \in BOOLEAN
    /\ loc \in Locs

Init == /\ cwd \in Cwds
    /\ desk \in BOOLEAN
    /\ loc \in Locs

Next == UNCHANGED <<cwd, desk, loc>>

Spec == Init /\ [][Next]_<<cwd, desk, loc>>

\* Every open tab reaches the webview, with or without a workspace.
TabsReachWebview == PostedPath(loc) # "unposted"

\* Every OpenedFile mention resolves to the path of the open tab.
MentionResolvesToOpenTab == Resolve(PostedPath(loc)) = TabFs(loc)

\* The task cwd is never a directory that does not exist.
TaskCwdExists == (TaskCwd = "DESK") => desk

\* The model is never steered to explore a Desktop that is not there.
NoPhantomDesktopSteer == Steer => desk

====
