---- MODULE OllamaToolCallText ----
\* Source: NativeOllamaHandler.createMessage, the stream of message.content chunks.
\* Sink: the emitted chunk type. A recovered block emits tool_call_partial and tool_call_end.
\* Failure F1: a complete pseudo-call block in the content ends as text-only output.
\* NoLostCall and NoBlockTextLeak are the opposite of failure F1.
\* Failure F2: a block split over many chunks is emitted piecemeal as text.
\* NoBlockTextLeak over every chunk split is the opposite of failure F2.
\* Failure F3: prose that quotes the marker inside a fence or backticks becomes a call.
\* NoPhantomCall is the opposite of failure F3.
\* Scanner contract: hold an ambiguous opener. Open a block on a complete opener.
\* Hold every block token. Surface one call on a well-formed closer.
\* Release a malformed or unterminated block as text. A quoted opener never opens a block.
\* The think and thought TagMatcher is an oracle. The stream end flushes held text.
\* The input truth is an oracle input. TruthHold, TruthLive, and TruthCall are data
\* tables, one row per Init input. The scanner rules are the only recognition logic
\* in this model, so a rules change cannot move both sides of an invariant together.
\* TruthLive covers the opener and the closer of a complete block, so a leak of a
\* boundary token alone is still a leak. TruthCall counts the closer token only.
\* A recovered call stays pending until Finish, like createMessage after the stream
\* loop. FinishEmitCalls gates that credit, so a dropped final step is a state here.
\* h1 is the opener head. h2 completes the opener. p1 opens a parameter. v is a value.
\* pC closes a parameter. fE closes the block. kB and kE are fence lines. bt is a backtick.
\* Not modeled: splits inside a token, value trimming, name checks, release text, the matcher.
\* Expected: the fixed gates hold. Unfixed fails NoLostCall and NoBlockTextLeak.
\* | Config | Variant | Verdict |
\* | OllamaToolCallText.cfg | fixed scanner | holds |
\* | .Unfixed.cfg | no recovery: every token is text, the 1429 code | fails NoLostCall and NoBlockTextLeak |
\* | .NoChunkHold.cfg | scanner state resets at each chunk end | fails NoBlockTextLeak and NoLostCall |
\* | .NoQuotedGuard.cfg | scanner ignores fences and backticks | fails NoPhantomCall |
\* | .NoSuppress.cfg | block text streams out beside the call | fails NoBlockTextLeak |
\* | .NoFinishEmit.cfg | Finish drops the pending calls | fails NoLostCall |
\* Results: fixed passes in 125 states. Unfixed fails NoBlockTextLeak (first) and
\* NoLostCall, the reproduction of issue 1429: the block stays text. NoChunkHold
\* fails NoBlockTextLeak. NoQuotedGuard fails NoPhantomCall. NoSuppress fails
\* NoBlockTextLeak. NoFinishEmit fails NoLostCall.
\* TLC reports the first violation of each run.
\* Cost: six TLC runs take about 10 seconds. Fixed focused tests take about 10 seconds.
\* Findings 2026-11-25, PR 2695 review: truth was a rule copy of the scanner, so a
\* rules change passed both sides; boundary-only leaks passed; Finish could not emit.
\* Review: 0 covered, 3 added, 0 gap.
EXTENDS Naturals, Sequences

CONSTANTS RecoverTextCalls, HoldAcrossChunks, GuardQuotedMention, SuppressBlockText,
          FinishEmitCalls, MaxChunks

VARIABLES input, runNo, pos, chunkNo, qFence, qTicks,
          sHold, sBlock, sPending, sinkCalls, oracleCalls, leakSeen, finished

vars == <<input, runNo, pos, chunkNo, qFence, qTicks,
          sHold, sBlock, sPending, sinkCalls, oracleCalls, leakSeen, finished>>

\* Oracle input. Row r maps one Init input. Column i is the state after token i:
\* TruthHold says the input truth holds an opener, TruthLive says token i belongs to
\* a complete recovered block, boundaries included, and TruthCall says token i closes
\* one call. Quoted tokens never join a block, so those columns are FALSE there.
TruthHold ==
    << <<FALSE, TRUE, TRUE, TRUE, TRUE, TRUE, TRUE, FALSE>>,
       <<FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, FALSE>>,
       <<FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, FALSE>>,
       <<TRUE, TRUE, FALSE, FALSE>>,
       <<TRUE>>,
       <<TRUE, TRUE, TRUE, TRUE>> >>

TruthLive ==
    << <<FALSE, TRUE, TRUE, TRUE, TRUE, TRUE, TRUE, FALSE>>,
       <<FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, FALSE>>,
       <<FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, FALSE>>,
       <<FALSE, FALSE, FALSE, FALSE>>,
       <<FALSE>>,
       <<TRUE, TRUE, TRUE, TRUE>> >>

TruthCall ==
    << <<FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, TRUE, FALSE>>,
       <<FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, FALSE>>,
       <<FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, FALSE>>,
       <<FALSE, FALSE, FALSE, FALSE>>,
       <<FALSE>>,
       <<FALSE, FALSE, FALSE, FALSE>> >>

\* Each run replays one input. Every chunking of it is reachable.
StartRun(n, seq) ==
    /\ input = seq /\ runNo = n /\ pos = 0 /\ chunkNo = 0
    /\ qFence = FALSE /\ qTicks = FALSE
    /\ sHold = FALSE /\ sBlock = "none" /\ sPending = 0
    /\ sinkCalls = 0 /\ oracleCalls = 0
    /\ leakSeen = FALSE /\ finished = FALSE

Init ==
    \/ StartRun(1, <<"a", "h1", "h2", "p1", "v", "pC", "fE", "a">>)
    \/ StartRun(2, <<"kB", "h1", "h2", "p1", "v", "pC", "fE", "kE">>)
    \/ StartRun(3, <<"bt", "h1", "h2", "p1", "v", "pC", "fE", "bt">>)
    \/ StartRun(4, <<"h1", "h2", "a", "fE">>)
    \/ StartRun(5, <<"h1">>)
    \/ StartRun(6, <<"h1", "h2", "p1", "v">>)

Quoted == qFence \/ qTicks

\* The scanner reads the quote state only when the leak guard is on.
ScannerQuoted == GuardQuotedMention /\ Quoted

Deliver ==
    /\ pos < Len(input)
    /\ ~finished
    /\ LET tok == input[pos + 1]
           sq == ScannerQuoted
           live == TruthLive[runNo][pos + 1]
           closes == TruthCall[runNo][pos + 1]
        \* Scanner state. Without recovery no block ever opens.
        nsHold == IF ~RecoverTextCalls THEN FALSE
                  ELSE IF sq THEN FALSE
                  ELSE IF tok = "h1" /\ sBlock = "none" THEN TRUE
                  ELSE FALSE
        nsBlock == IF ~RecoverTextCalls THEN "none"
                   ELSE IF sq THEN "none"
                   ELSE IF tok = "h2" /\ sHold /\ sBlock = "none" THEN "wf"
                   ELSE IF sBlock = "wf" /\ tok \in {"p1", "v", "pC"} THEN "wf"
                   ELSE "none"
        \* A recovered call stays pending; Finish credits it to the sink.
        emitsCall == RecoverTextCalls /\ ~sq /\ sBlock = "wf" /\ tok = "fE"
        \* The scanner writes this token out as plain text.
        emitsText == IF ~RecoverTextCalls THEN TRUE
                     ELSE IF sq THEN TRUE
                     ELSE IF tok = "h1" /\ sBlock = "none" THEN sHold \/ ~SuppressBlockText
                     ELSE IF tok = "h2" /\ sHold /\ sBlock = "none" THEN ~SuppressBlockText
                     ELSE IF sBlock = "wf" /\ tok \in {"p1", "v", "pC", "fE"} THEN ~SuppressBlockText
                     ELSE TRUE
        \* A leak: text leaves while the token belongs to a complete recovered
        \* block, boundaries included. A release after a malformed token is not
        \* a leak; TruthLive is FALSE there.
        nLeak == leakSeen \/ (emitsText /\ live)
       IN /\ pos' = pos + 1
          /\ qFence' = IF tok = "kB" THEN TRUE ELSE IF tok = "kE" THEN FALSE ELSE qFence
          /\ qTicks' = IF tok = "bt" THEN ~qTicks ELSE qTicks
          /\ sHold' = nsHold /\ sBlock' = nsBlock
          /\ sPending' = sPending + (IF emitsCall THEN 1 ELSE 0)
          /\ sinkCalls' = sinkCalls
          /\ oracleCalls' = oracleCalls + (IF closes THEN 1 ELSE 0)
          /\ leakSeen' = nLeak
          /\ UNCHANGED <<input, runNo, chunkNo, finished>>

\* A chunk end. It matters only while the scanner holds a marker or a block.
EndChunk ==
    /\ ~finished
    /\ chunkNo < MaxChunks
    /\ sHold \/ sBlock = "wf"
    /\ chunkNo' = chunkNo + 1
    /\ IF HoldAcrossChunks
       THEN /\ sHold' = sHold /\ sBlock' = sBlock /\ sPending' = sPending
            /\ leakSeen' = leakSeen
       ELSE /\ sHold' = FALSE /\ sBlock' = "none" /\ sPending' = sPending
            /\ \* Dropping the hold leaks the held region, boundaries included.
               leakSeen' = TRUE
    /\ UNCHANGED <<input, runNo, pos, qFence, qTicks, sinkCalls, oracleCalls, finished>>

\* End of stream. An unterminated hold or block is text, not a call. Not a leak.
\* Recovered calls emit after the stream loop, so Finish credits the pending ones.
Finish ==
    /\ ~finished
    /\ pos = Len(input)
    /\ finished' = TRUE
    /\ sHold' = FALSE /\ sBlock' = "none"
    /\ sinkCalls' = sinkCalls + (IF FinishEmitCalls THEN sPending ELSE 0)
    /\ sPending' = 0
    /\ leakSeen' = leakSeen
    /\ UNCHANGED <<input, runNo, pos, chunkNo, qFence, qTicks, oracleCalls>>

Next == Deliver \/ EndChunk \/ Finish
Spec == Init /\ [][Next]_vars

\* F1: every complete pseudo-call block in the content surfaces as a tool call
\* once the stream has ended and the recovered calls have been emitted.
NoLostCall == ~finished \/ oracleCalls <= sinkCalls

\* F3: a tool call surfaces only for a complete, unquoted block.
NoPhantomCall == ~finished \/ sinkCalls <= oracleCalls

\* F1 and F2: the text of a live well-formed block never leaves as plain text.
NoBlockTextLeak == ~leakSeen

====
