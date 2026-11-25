---- MODULE McpNameResolution ----
\* Sources: the registration order in McpHub.connectToServer and one server's tool list.
\* Sink: McpHub.getServerAlias (tool-name generation), findServerNameBySanitizedName
\* (call resolution), and UseMcpToolTool.validateToolExists tool pick.
\* Failures: "svc.prod" and "svc_prod" generated the same tool name, and the
\* exact-match lookup resolved it to the wrong server; an exact tool name later
\* in the list lost to an earlier fuzzy match. Round 2: a server that registers
\* mid-request reclaims an alias and captures a call made under it, and two
\* original tool names that sanitize alike lose one tool.
\* Invariants: DistinctServerAliases, AliasResolvesToOriginal, SafeNameKeepsOwn,
\* ExactToolFirst, GeneratedNameStaysBound, ExactNameOwnServer,
\* DistinctToolSegments, and ToolAliasResolvesToOriginal.
\* Expected: every registration order assigns pairwise-distinct aliases, each
\* alias resolves back to its server, a safe name keeps itself, an exact
\* tool name wins before any fuzzy match, a generated name reaches the server
\* that issued it across a later alias reclaim, and colliding tool names keep
\* distinct segments that each run their own original tool.
\* Vendor facts are inputs. This model does not verify transport code, provider
\* function-name rules, or 64-character truncation.
\* Review: round 1: 0 covered, 2 added (threads 4675461229 and 4675461220).
\* Round 2: 0 covered, 3 added, gaps below. Added for threads 4680494465 and
\* 4680575748 (GeneratedNameStaysBound, ExactNameOwnServer; NoBinding isolates
\* the reclaim) and for thread 4680575773 (DistinctToolSegments and
\* ToolAliasResolvesToOriginal; NoToolSuffix and NoToolBind isolate them).
\* Round 3: 0 covered, 2 added, gaps below. Thread 4683306103: the fuzzy
\* fallback now reads the modeled order (toolOrder[1]) in both SelectedTool
\* and ExpectedTool, so ExactToolFirst is order-sensitive and NoExactFirst
\* still violates it. Thread 4683306127: see Gaps.
\* Gaps: thread 4680575764 is a test-double policy for the spec files' unit
\* tests, not a model failure. The McpHub.ts:1495 finding (a suffixed alias
\* arrives with hyphens turned into underscores) needs string surgery that
\* would multiply the alias domain; unit tests cover it. The 64-character limit
\* (mcp_server.ts:43 Minor) is arithmetic on lengths; the binding covers a
\* shortened name symbolically, but the length rule stays in unit tests.
\* ToolRouter discovery keeps the first tool per colliding name (pre-existing
\* behavior); re-registration and delete are code-level idempotency. Thread
\* 4683306127 (a repeated original whose base is owned by another tool
\* allocated a fresh suffix per occurrence) is code-level allocation state:
\* ToolSegment is already keyed by the original name, so the spec cannot
\* express per-occurrence allocation without modeling list positions; the
\* mixed-repeat unit test covers it in mcp_server.spec.ts.
\* Result: the fixed gate passes on 36 states. Unfixed, NoReclaim, and NoSuffix
\* violate DistinctServerAliases, and the same three break
\* GeneratedNameStaysBound: their colliding aliases make the generation
\* binding ambiguous. Unfixed also breaks AliasResolvesToOriginal (round 1).
\* NoExactFirst violates only ExactToolFirst; NoBinding only
\* GeneratedNameStaysBound; NoToolBind only ToolAliasResolvesToOriginal;
\* NoToolSuffix only DistinctToolSegments. No new defect beyond the findings.
\* Cost: about 40 minutes (round 1) plus about 50 minutes of agent work
\* across spec, tests, and fix (round 2).
EXTENDS TLC, Naturals
CONSTANT Fixed, Reclaim, Suffix, ExactFirst, Binding, ToolBind, ToolSuffix
VARIABLE order, toolCall, toolOrder

Positions == 1..3
Servers == {"svc.prod", "svc_prod", "svc_prod_2"}
Bases == {"svc_prod", "svc_prod_2"}
Aliases == Bases \cup {"svc_prod_3", "svc_prod_2_2", "svc_prod_2_3"} \cup {"none"}
Tools == {"System.readFile", "System_readFile"}
ToolRequests == Tools \cup {"System-readFile"}
ToolOrders == {f \in [1..2 -> Tools] : f[1] # f[2]}

Orders == {f \in [Positions -> Servers] : \A p, q \in Positions : p # q => f[p] # f[q]}

\* The sanitizer turns dots into underscores; safe names pass through.
Sanitize(s) == IF s = "svc.prod" THEN "svc_prod" ELSE s
IsSafe(s) == Sanitize(s) = s

\* TLA+ has no string concatenation; enumerate the suffix candidates.
SuffixesFor(b) == IF b = "svc_prod" THEN {"svc_prod_2", "svc_prod_3"}
                  ELSE {"svc_prod_2_2", "svc_prod_2_3"}

TakenAt(m, i) == {m[p] : p \in Positions} \cup {order[p] : p \in 1..(i-1)}

FreshAlias(s, m, i) ==
    IF ~Suffix THEN Sanitize(s)
    ELSE CHOOSE c \in SuffixesFor(Sanitize(s)) : c \notin TakenAt(m, i)

\* The alias for the server registering at position i. A safe name owns itself;
\* a transformed name takes its base unless the base is taken, then a suffix.
AliasFor(s, m, i) ==
    IF ~Fixed THEN Sanitize(s)
    ELSE IF IsSafe(s) THEN s
    ELSE IF ~Suffix THEN Sanitize(s)
    ELSE IF Sanitize(s) \notin TakenAt(m, i) THEN Sanitize(s)
    ELSE FreshAlias(s, m, i)

\* A safe name owns itself: every earlier holder of that name moves away.
ReclaimAdjust(m, i) ==
    IF ~Fixed \/ ~Reclaim THEN m
    ELSE IF ~IsSafe(order[i]) THEN m
    ELSE [p \in Positions |->
          IF m[p] = order[i] /\ order[p] # order[i]
          THEN FreshAlias(order[p], m, i)
          ELSE m[p]]

AMap[i \in 0..3] ==
    IF i = 0 THEN [p \in Positions |-> "none"]
    ELSE LET m == ReclaimAdjust(AMap[i-1], i) IN
         [p \in Positions |-> IF p = i THEN AliasFor(order[i], m, i) ELSE m[p]]

Final == AMap[3]

\* The lookup order of findServerNameBySanitizedName: exact original-name match
\* first, then the alias registry. Both picks are unique per server here.
ResolveBySanitized(a) ==
    LET exact == {q \in Positions : order[q] = a}
        reg == {q \in Positions : Final[q] = a}
    IN IF exact # {} THEN order[CHOOSE q \in exact : TRUE]
       ELSE IF reg # {} THEN order[CHOOSE q \in reg : TRUE]
       ELSE "unresolved"

\* Where dispatch sends a name that the request advertised under alias a,
\* when the request was built after g registrations. Live exact-name
\* resolution can reach a different server after a later registration
\* reclaims a. The generation-time binding cannot.
DispatchTarget(a, g) ==
    IF ~Binding THEN ResolveBySanitized(a)
    ELSE IF \E q \in 1..g : AMap[g][q] = a THEN order[CHOOSE q \in 1..g : AMap[g][q] = a]
    ELSE ResolveBySanitized(a)

DistinctServerAliases == \A p, q \in Positions : p # q => Final[p] # Final[q]
AliasResolvesToOriginal == \A p \in Positions : ResolveBySanitized(Final[p]) = order[p]
SafeNameKeepsOwn == \A p \in Positions : IsSafe(order[p]) => Final[p] = order[p]

\* A generated name stays bound to the server that issued it, also when a
\* later server reclaims that alias (round 2 threads 4680494465 and
\* 4680575748 on PR 2669). The NoBinding trace shows the wrong server pick.
GeneratedNameStaysBound ==
    \A g \in 1..3 : \A p \in 1..g : DispatchTarget(AMap[g][p], g) = order[p]

\* Exact-name resolution answers with the server whose original name it is.
\* It holds in every config: the exact branch runs before the registry, and
\* a safe name owns itself in the registry. No sabotage isolates it, because
\* registry and exact branch agree on safe names. The dispatch-level danger
\* is the GeneratedNameStaysBound trace, not this branch.
ExactNameOwnServer ==
    \A q \in Positions : IsSafe(order[q]) => ResolveBySanitized(order[q]) = order[q]

\* The generated segment for one original tool: the first listed tool keeps
\* the base; a distinct original that sanitizes to the same base moves to a
\* suffixed segment. Without the suffix, both tools get one segment and the
\* duplicate filter drops one definition (thread 4680575773).
ToolBase == "System_readFile"
ToolSegment(t) ==
    IF ~ToolSuffix THEN ToolBase
    ELSE IF t = toolOrder[1] THEN ToolBase
    ELSE "System_readFile_2"

DistinctToolSegments == ToolSegment(toolOrder[1]) # ToolSegment(toolOrder[2])

\* The reverse binding from a generated segment to its original tool. With
\* colliding segments, the second registration overwrites the first.
BoundTool(i) ==
    IF ~ToolSuffix THEN toolOrder[2]
    ELSE toolOrder[i]

\* Without the binding, dispatch picks the literal exact name first.
ExactToolPick == "System_readFile"
DispatchedTool(i) ==
    IF ToolBind THEN BoundTool(i)
    ELSE IF ExactToolPick \in Tools THEN ExactToolPick
    ELSE "System.readFile"

ToolAliasResolvesToOriginal ==
    (ToolSegment(toolOrder[1]) # ToolSegment(toolOrder[2])) =>
        (\A i \in 1..2 : DispatchedTool(i) = toolOrder[i])

\* The exact requested name wins when it exists on the server; a mangled name
\* falls back to the first fuzzy match in the modeled list order (thread
\* 4683306103). A fixed-string fallback made ExactToolFirst pass vacuously
\* for the order that lists the underscored tool first, because both
\* operators returned the same constant instead of the modeled order.
SelectedTool(r) == IF ExactFirst /\ r \in Tools THEN r ELSE toolOrder[1]
ExpectedTool(r) == IF r \in Tools THEN r ELSE toolOrder[1]
ExactToolFirst == SelectedTool(toolCall) = ExpectedTool(toolCall)

Init == order \in Orders /\ toolCall \in ToolRequests /\ toolOrder \in ToolOrders
Next == UNCHANGED <<order, toolCall, toolOrder>>
Spec == Init /\ [][Next]_<<order, toolCall, toolOrder>>
====
