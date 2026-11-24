---- MODULE McpNameResolution ----
\* Sources: the registration order in McpHub.connectToServer and one server's tool list.
\* Sink: McpHub.getServerAlias (tool-name generation), findServerNameBySanitizedName
\* (call resolution), and UseMcpToolTool.validateToolExists tool pick.
\* Failures: "svc.prod" and "svc_prod" generated the same tool name, and the
\* exact-match lookup resolved it to the wrong server; an exact tool name later
\* in the list lost to an earlier fuzzy match.
\* Invariants: DistinctServerAliases, AliasResolvesToOriginal, SafeNameKeepsOwn,
\* and ExactToolFirst.
\* Expected: every registration order assigns pairwise-distinct aliases, each
\* alias resolves back to its server, a safe name keeps itself, and an exact
\* tool name wins before any fuzzy match.
\* Vendor facts are inputs. This model does not verify transport code, provider
\* function-name rules, or 64-character truncation.
\* Review: 0 covered, 2 added, gaps below. Both dimensions added for round-1
\* findings 4675461229 (alias collision) and 4675461220 (exact tool name second)
\* on https://github.com/Zoo-Code-Org/Zoo-Code/pull/2669.
\* Gaps: truncation at 64 characters can still collide; ToolRouter discovery
\* keeps the first tool per colliding name (pre-existing behavior); re-registration
\* and delete are code-level idempotency, not modeled here.
\* Result: the fixed gate passes on 18 states. Unfixed, NoReclaim, and NoSuffix
\* violate DistinctServerAliases (Unfixed also breaks resolution); NoExactFirst
\* violates only ExactToolFirst. No new defect beyond the two findings.
\* Cost: about 40 minutes of agent work across spec, tests, and fix.
EXTENDS TLC, Naturals
CONSTANT Fixed, Reclaim, Suffix, ExactFirst
VARIABLE order, toolCall

Positions == 1..3
Servers == {"svc.prod", "svc_prod", "svc_prod_2"}
Bases == {"svc_prod", "svc_prod_2"}
Aliases == Bases \cup {"svc_prod_3", "svc_prod_2_2", "svc_prod_2_3"} \cup {"none"}
Tools == {"System.readFile", "System_readFile"}
ToolRequests == Tools \cup {"System-readFile"}

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

DistinctServerAliases == \A p, q \in Positions : p # q => Final[p] # Final[q]
AliasResolvesToOriginal == \A p \in Positions : ResolveBySanitized(Final[p]) = order[p]
SafeNameKeepsOwn == \A p \in Positions : IsSafe(order[p]) => Final[p] = order[p]

\* The exact requested name wins when it exists on the server; a mangled name
\* falls back to the first fuzzy match in the list order modeled here.
SelectedTool(r) == IF ExactFirst /\ r \in Tools THEN r ELSE "System.readFile"
ExpectedTool(r) == IF r \in Tools THEN r ELSE "System.readFile"
ExactToolFirst == SelectedTool(toolCall) = ExpectedTool(toolCall)

Init == order \in Orders /\ toolCall \in ToolRequests
Next == UNCHANGED <<order, toolCall>>
Spec == Init /\ [][Next]_<<order, toolCall>>
====
