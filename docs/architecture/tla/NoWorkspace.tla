---- MODULE NoWorkspace ----
\* Models the no-workspace paths for issue #1271.
\* Source: WorkspaceTracker.getOpenedTabsInfo and workspaceDidUpdate
\* (src/integrations/workspace/WorkspaceTracker.ts); the task cwd fallback
\* (src/core/task/Task.ts via getNoWorkspaceFallbackPath); the Desktop
\* example in src/core/prompts/sections/rules.ts.
\* Sink: the @file mention resolution in src/core/mentions/index.ts,
\* resolved in two attempts: the raw mention (with its leading slash) is
\* root-anchored, so the absolute attempt comes first and an open tab
\* outside the workspace keeps its file even when a cwd-relative shadow
\* exists; mention.slice(1) resolved against the task cwd is the fallback
\* ('@/src/file.ts' stays cwd-relative when the root twin does not
\* exist). The webview emits an open tab outside the workspace as a
\* single-slash absolute mention ('@/HOME/x.ts'), so a cwd-only parser
\* pins the tab under the task cwd.
\* Input domain: tracker cwd in {"", root}; the Desktop exists or not;
\* one open tab inside the root or in the home folder; the stripped
\* absolute tab path also exists under the task cwd or not (ShadowCwd —
\* the shadow must never intercept a root-anchored token).
\* Failure 1: no workspace and the tracker posts no tabs. The @file menu
\* is empty.
\* Failure 2: no workspace and the tab path is made "relative" against the
\* empty cwd. The mention resolves to a path that is not the open tab.
\* Failure 3: an absolute tab mention with a resolver that never uses
\* the raw absolute path. The mention resolves under the task cwd to a
\* path that is not the open tab — including the cwd-relative shadow.
\* Failure 4: no Desktop directory and the task cwd is still Desktop. The
\* cwd does not exist on the system.
\* Failure 5: no Desktop directory and the prompt still steers the model
\* to explore the Desktop.
\* Invariants: TabsReachWebview, MentionResolvesToOpenTab, TaskCwdExists,
\* NoPhantomDesktopSteer.
\* Expected before the run: the Unfixed config models the old code and
\* must fail. The fixed config must hold. Each sabotage drops one guard.
\* Result: the unconditional MentionResolvesToOpenTab holds in all 8
\* states of the fixed config and of the PassNoShadow config
\* (ShadowCwd = FALSE). The cwd-first design of the earlier round let
\* the shadow intercept the tab mention in cwd = "", desk = FALSE,
\* loc = "out" (TaskCwd = "HOME"): the mention resolved to
\* HOME/HOME/x.ts instead of the open tab HOME/x.ts, and a broken
\* absolute attempt stayed hidden behind the shadow — the regression
\* thread 4690051850 asked to expose. Absolute-first resolves it.
\* Unfixed and NoPost violate TabsReachWebview; RelTab (tabs stay
\* relative against the empty cwd) violates MentionResolvesToOpenTab;
\* RelAlways (the resolver never uses the raw absolute path) violates
\* MentionResolvesToOpenTab in the absolute-outside state — with the
\* shadow present and absent; DeskAlways violates TaskCwdExists;
\* SteerAlways violates NoPhantomDesktopSteer. Each violation is found
\* in an initial state, so TLC halts before a full count.
\* Replay: failures 1 and 2 leaked in the real code before the fix (the red
\* WorkspaceTracker tests: zero posts without a workspace, and the tab path
\* "../../../../user/notes.txt"). Failure 3 is the parser review finding on
\* PR #2681: the red index.spec.ts tests ('@/abs/path' resolves to the
\* original file; openMention opens the absolute file) fail on the old
\* slice-and-resolve parser. Failure 4 is the reporter's system in
\* issue #1271 (home folder "desktop", lowercase). Failure 5 leaked in the
\* red generateSystemPrompt test (Desktop example with no Desktop). No false
\* alarms.
\* Not modeled: the Windows '/C:/Users/...' form (it is not absolute
\* after the leading slash and resolves through the cwd attempt, the
\* model's fallback); the debounce timers; multi-root workspaces.
\* Cost: TLC runs in under a second with 8 input states.
\* Review: 0 covered, 3 added, 0 gap. First version written with the fix.
\* Added mid-review (PR #2681): thread 4689348711 added the ShadowCwd
\* existence oracle; thread 4685318951 withdrew the reconciled shadow
\* clause and made MentionResolvesToOpenTab unconditional through the
\* absolute-first Resolve; the cfg review comment (03:38Z round) added
\* the passing PassNoShadow run and the check.sh Pass pattern so the
\* no-shadow fallback is model-checked, not only the shadow state.

EXTENDS Naturals

CONSTANTS
    \* Tracker posts workspaceUpdated with openedTabs when cwd = "".
    PostNoCwd,
    \* Without a cwd the tab path is absolute, not relative against "".
    AbsWhenNoCwd,
    \* The mention resolver uses the raw absolute mention path for
    \* root-anchored tokens (absolute attempt first).
    AbsFallback,
    \* Task cwd uses Desktop only when the Desktop directory exists.
    DeskOnlyIfExists,
    \* The Desktop prompt example appears only when Desktop exists.
    GateDesktopSteer,
    \* The existence oracle for the cwd-relative shadow: the stripped
    \* absolute tab path also exists under the task cwd (review thread
    \* 4689348711 on PR #2681 — the real fs permits this case).
    ShadowCwd

VARIABLES
    cwd,   \* tracker cwd: "" (no workspace) or "WS" (workspace root)
    desk,  \* the Desktop directory exists
    loc    \* open tab location: "in" (inside the root) or "out" (home)

Cwds == {"", "WS"}
Locs == {"in", "out"}

\* The real fs path of the open tab. "in" lives under the root.
TabFs(l) == IF l = "in" THEN "WS/a.ts" ELSE "HOME/x.ts"

\* The files that exist in the modeled fs.
RealFiles == {"WS/a.ts", "HOME/x.ts"}

\* The path the tracker posts; the webview prefixes one slash to build the
\* mention value '@/<posted>'. With a root the tab is relative to it
\* (inside, or climbing out with '..'); without one it is absolute,
\* garbage, or unposted.
PostedPath(l) ==
    IF cwd # "" THEN IF l = "in" THEN "a.ts" ELSE "../HOME/x.ts"
    ELSE IF ~PostNoCwd THEN "unposted"
    ELSE IF AbsWhenNoCwd THEN TabFs(l)
    ELSE "garbage"

\* Task.ts: parentWorkspace ?? getWorkspacePath(fallback).
TaskCwd == IF cwd # "" THEN "WS"
    ELSE IF DeskOnlyIfExists /\ desk THEN "DESK"
    ELSE IF DeskOnlyIfExists THEN "HOME"
    ELSE "DESK"

\* path.resolve(taskCwd, "HOME/x.ts") — the cwd-relative shadow of the
\* stripped absolute tab path, when the oracle permits one.
ShadowPath ==
    IF TaskCwd = "WS" THEN "WS/HOME/x.ts"
    ELSE IF TaskCwd = "DESK" THEN "DESK/HOME/x.ts"
    ELSE "HOME/HOME/x.ts"

\* Attempt 2 of the parser (src/core/mentions/index.ts):
\* mention.slice(1) resolved against the task cwd. The workspace-relative
\* 'a.ts' exists only under the root; '../HOME/x.ts' climbs out of any
\* base to the real file. A stripped absolute tab path exists under the
\* task cwd only when the oracle permits a shadow file (r4689348711).
RelTarget(p) ==
    IF p = "a.ts" THEN IF TaskCwd = "WS" THEN "WS/a.ts" ELSE "LOST"
    ELSE IF p = "../HOME/x.ts" THEN "HOME/x.ts"
    ELSE IF p = "HOME/x.ts" THEN IF ShadowCwd THEN ShadowPath ELSE "LOST"
    ELSE "LOST"

\* Attempt 1: the raw mention (leading slash kept) is root-anchored and
\* resolves directly when the resolver uses the absolute path. The
\* '../HOME/x.ts' climb form normalizes to the real file.
RawTarget(p) ==
    IF p \in RealFiles THEN p
    ELSE IF p = "../HOME/x.ts" THEN "HOME/x.ts"
    ELSE "LOST"

Resolve(p) ==
    IF p \in {"unposted", "garbage"} THEN "LOST"
    ELSE IF AbsFallback /\ RawTarget(p) # "LOST" THEN RawTarget(p)
    ELSE IF RelTarget(p) # "LOST" THEN RelTarget(p)
    ELSE "LOST"

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

\* Every OpenedFile mention resolves to the path of the open tab. A
\* root-anchored token never resolves to the cwd-relative shadow
\* (PR #2681 thread 4685318951): the absolute attempt comes first, so
\* the reconciled shadow clause from thread 4689348711 is withdrawn.
\* The workspace contract survives through the cwd fallback: the
\* root-anchored twin of '@/src/file.ts' is not a real file, so the
\* cwd attempt resolves it.
MentionResolvesToOpenTab ==
    Resolve(PostedPath(loc)) = TabFs(loc)

\* The task cwd is never a directory that does not exist.
TaskCwdExists == (TaskCwd = "DESK") => desk

\* The model is never steered to explore a Desktop that is not there.
NoPhantomDesktopSteer == Steer => desk

====
