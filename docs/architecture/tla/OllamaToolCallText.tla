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
\* h1 is the opener head. h2 completes the opener. p1 opens a parameter. v is a value.
\* pC closes a parameter. fE closes the block. kB and kE are fence lines. bt is a backtick.
\* The scanner and the input truth share the quote tracking. The NoQuotedGuard gate
\* models a scanner that fails to consult it.
\* Not modeled: splits inside a token, value trimming, name checks, release text, the matcher.
\* Expected: the fixed gates hold. Unfixed fails NoLostCall and NoBlockTextLeak.
\* | Config | Variant | Verdict |
\* | OllamaToolCallText.cfg | fixed scanner | holds |
\* | .Unfixed.cfg | no recovery: every token is text, the 1429 code | fails NoLostCall and NoBlockTextLeak |
\* | .NoChunkHold.cfg | scanner state resets at each chunk end | fails NoLostCall and NoBlockTextLeak |
\* | .NoQuotedGuard.cfg | scanner ignores fences and backticks | fails NoPhantomCall |
\* | .NoSuppress.cfg | block text streams out beside the call | fails NoBlockTextLeak |
\* Results: fixed passes in 125 states. Unfixed fails NoBlockTextLeak and NoLostCall.
\* Unfixed is the reproduction of issue 1429: the block in the content stays text.
\* NoChunkHold fails NoBlockTextLeak and NoLostCall. NoQuotedGuard fails NoPhantomCall.
\* NoSuppress fails NoBlockTextLeak. TLC reports the first violation of each run.
\* Cost: five TLC runs take about 8 seconds. Fixed focused tests take about 10 seconds.
\* Review: 0 covered, 0 added, 0 gap.
EXTENDS Naturals, Sequences

CONSTANTS RecoverTextCalls, HoldAcrossChunks, GuardQuotedMention, SuppressBlockText, MaxChunks

VARIABLES input, pos, chunkNo, qFence, qTicks, oHold, oBlock, oracleCalls,
          sHold, sBlock, sinkCalls, leakSeen, finished

vars == <<input, pos, chunkNo, qFence, qTicks, oHold, oBlock, oracleCalls,
          sHold, sBlock, sinkCalls, leakSeen, finished>>

\* Each run replays one input. Every chunking of it is reachable.
StartRun(seq) ==
    /\ input = seq /\ pos = 0 /\ chunkNo = 0
    /\ qFence = FALSE /\ qTicks = FALSE
    /\ oHold = FALSE /\ oBlock = "none" /\ oracleCalls = 0
    /\ sHold = FALSE /\ sBlock = "none" /\ sinkCalls = 0
    /\ leakSeen = FALSE /\ finished = FALSE

Init ==
    \/ StartRun(<<"a", "h1", "h2", "p1", "v", "pC", "fE", "a">>)
    \/ StartRun(<<"kB", "h1", "h2", "p1", "v", "pC", "fE", "kE">>)
    \/ StartRun(<<"bt", "h1", "h2", "p1", "v", "pC", "fE", "bt">>)
    \/ StartRun(<<"h1", "h2", "a", "fE">>)
    \/ StartRun(<<"h1">>)
    \/ StartRun(<<"h1", "h2", "p1", "v">>)

Quoted == qFence \/ qTicks

\* The scanner reads the quote state only when the leak guard is on.
ScannerQuoted == GuardQuotedMention /\ Quoted

Deliver ==
    /\ pos < Len(input)
    /\ ~finished
    /\ LET tok == input[pos + 1]
           oq == Quoted
           sq == ScannerQuoted
        \* Shared quote tracking. Both sides read the state before the token.
        nqFence == IF tok = "kB" THEN TRUE ELSE IF tok = "kE" THEN FALSE ELSE qFence
        nqTicks == IF tok = "bt" THEN ~qTicks ELSE qTicks
        \* Input truth. A quoted token never joins a block.
        noHold == IF oq THEN oHold
                   ELSE IF tok = "h1" /\ oBlock = "none" THEN TRUE
                   ELSE FALSE
        noBlock == IF oq THEN oBlock
                   ELSE IF tok = "h2" /\ oHold /\ oBlock = "none" THEN "wf"
                   ELSE IF oBlock = "wf" /\ tok \in {"p1", "v", "pC"} THEN "wf"
                   ELSE IF oBlock = "wf" THEN "none"
                   ELSE "none"
        nCalls == IF ~oq /\ oBlock = "wf" /\ tok = "fE" THEN oracleCalls + 1 ELSE oracleCalls
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
        \* A recovered call surfaces at the closer of a live block.
        emitsCall == RecoverTextCalls /\ ~sq /\ sBlock = "wf" /\ tok = "fE"
        \* The scanner writes this token out as plain text.
        emitsText == IF ~RecoverTextCalls THEN TRUE
                     ELSE IF sq THEN TRUE
                     ELSE IF tok = "h1" /\ sBlock = "none" THEN sHold \/ ~SuppressBlockText
                     ELSE IF tok = "h2" /\ sHold /\ sBlock = "none" THEN ~SuppressBlockText
                     ELSE IF sBlock = "wf" /\ tok \in {"p1", "v", "pC", "fE"} THEN ~SuppressBlockText
                     ELSE TRUE
        \* A leak: text leaves while the input truth holds a live well-formed block.
        \* A release after a malformed token is not a leak. The oracle closed it first.
        nLeak == leakSeen \/ (emitsText /\ noBlock = "wf")
       IN /\ pos' = pos + 1
          /\ qFence' = nqFence /\ qTicks' = nqTicks
          /\ oHold' = noHold /\ oBlock' = noBlock /\ oracleCalls' = nCalls
          /\ sHold' = nsHold /\ sBlock' = nsBlock
          /\ sinkCalls' = IF emitsCall THEN sinkCalls + 1 ELSE sinkCalls
          /\ leakSeen' = nLeak
          /\ UNCHANGED <<input, chunkNo, finished>>

\* A chunk end. It matters only while the scanner holds a marker or a block.
EndChunk ==
    /\ ~finished
    /\ chunkNo < MaxChunks
    /\ sHold \/ sBlock = "wf"
    /\ chunkNo' = chunkNo + 1
    /\ IF HoldAcrossChunks
       THEN /\ sHold' = sHold /\ sBlock' = sBlock
            /\ sinkCalls' = sinkCalls /\ leakSeen' = leakSeen
       ELSE /\ sHold' = FALSE /\ sBlock' = "none"
            /\ sinkCalls' = sinkCalls
            /\ leakSeen' = (leakSeen \/ sBlock = "wf")
    /\ UNCHANGED <<input, pos, qFence, qTicks, oHold, oBlock, oracleCalls, finished>>

\* End of stream. An unterminated hold or block is text, not a call. Not a leak.
Finish ==
    /\ ~finished
    /\ pos = Len(input)
    /\ finished' = TRUE
    /\ sHold' = FALSE /\ sBlock' = "none"
    /\ sinkCalls' = sinkCalls /\ leakSeen' = leakSeen
    /\ UNCHANGED <<input, pos, chunkNo, qFence, qTicks, oHold, oBlock, oracleCalls>>

Next == Deliver \/ EndChunk \/ Finish
Spec == Init /\ [][Next]_vars

\* F1: every complete pseudo-call block in the content surfaces as a tool call.
NoLostCall == oracleCalls <= sinkCalls

\* F3: a tool call surfaces only for a complete, unquoted block.
NoPhantomCall == sinkCalls <= oracleCalls

\* F1 and F2: the text of a live well-formed block never leaves as plain text.
NoBlockTextLeak == ~leakSeen

====
