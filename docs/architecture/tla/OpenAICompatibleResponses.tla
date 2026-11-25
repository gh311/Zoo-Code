---- MODULE OpenAICompatibleResponses ----
\* Sources: OpenAICompatible.handleInputChange, OpenAiHandler.createMessage and completePrompt.
\* Sinks: buildResponsesRequest, client.responses.create, bridgeExternalAbortSignal.dispose.
\* Initial expectation: find routing, option loss, or listener leaks. Rules preceded the first review.
\* Failure: the saved flag selects the wrong API. Rule: Routing.
\* Failure: reasoning, tools, streaming, Extra Body, or valid text is lost.
\* Rules: ReasoningAndTools, Streaming, ExtraBody, WellFormed. The SDK is an oracle.
\* Failure: construction or request exit retains a listener.
\* Rules: NoListenerDuringBuild and ListenerReleased model attach, abort, and disposal order.
\* Only the Responses message route registers a bridge listener.
\* Parameters and protocol rules are in ResponsesRequestParameters.tla and ResponsesProtocol.tla.
\* Initial review ratchet: 0 covered, 3 added, 2 gap (translations and pixels).
\* Threads: discussion_r4616096233, discussion_r4616097051, discussion_r4616097077 on PR 2498.
\* PR: https://github.com/Zoo-Code-Org/Zoo-Code/pull/2498
\* Self-review added the output-limit override rule after 456 requested tokens became 1000.
\* Issue 1407 ratchet: the platform 300 s transport deadline killed slow streams.
\* The configured timeout did not reach the undici body deadline. Rule: ConfiguredDeadlineOnly.
\* The source gains configuredTimeout. A request can end in completion, abort, or deadlineFired.
\* The SDK timeout stays a second guard. TransportDeadline is an oracle over the source.
\* Threads: issue 1407. The unfixed transport is the NoTransportDeadline sabotage config.
\* Refactor ratchet: 0 covered, 1 added, 0 gap. Derived listener state hid disposal order.
\* Review e7ed99742a: 0 covered, 9 added, 2 gap (helper duplication and code/model correspondence).
\* Finding 9's blanket rejection of max was false; supported effort values depend on the model.
\* Review 6385d18512: 1 covered (subclass isolation), 2 added (null defaults and replay scope), 5 gap.
\* Gaps 4-8 concern test evidence, malformed SDK output, comments, and UI wording.
\* The routing model already covered incompatible providers, but DeepSeek lacked the code guard.
\* Current gate: 35424 routing states pass; eleven sabotage configs and the unfixed config fail.
\* Across three models: 30 sabotage configs fail with invariant error 12; three fixed configs pass.
\* Separate real-code mutations fail the focused tests. See ResponsesReviewReplays.md for each mapping.
\* These are manual gates. No script or CI step proves code/model correspondence.
\* Findings: completion routing, terminal failure, subclass flags, and replay were missing before fixes.
\* The latest model found no additional defect. No real-code replay false alarm remains.
\* Cost: about 85 agent minutes across the PR; the 33-config TLC gate takes about 30 seconds.
\* Run each config with OpenAICompatibleResponsesMC.tla. Metadata must be outside the repo.
\* Unit gate: openai.spec.ts, openai-compatible-responses.spec.ts, and responses-api-contract.spec.ts.
\* The model checks the request boundary. It does not prove the code correct.
CONSTANTS RequestBoundary, CleanupBoundary, InitialListenerBoundary, TransportDeadline
VARIABLES source, phase, listener, aborted, deadlineFired
vars == <<source, phase, listener, aborted, deadlineFired>>
sink == RequestBoundary[source]
ExpectedResponses == source.responses /\ source.compatible

InputDomain ==
    [responses : BOOLEAN, entrypoint : {"message", "completion"}, compatible : BOOLEAN,
     streaming : {"unset", "on", "off"},
     configuredTimeout : {"disabled", "default300", "configured600", "larger"},
     reasoning : BOOLEAN, tools : BOOLEAN, extra : BOOLEAN, badText : BOOLEAN,
     signal : {"none", "live", "aborted"}]

Init ==
    /\ source \in InputDomain
    /\ (source.entrypoint = "message" \/ ~source.tools)
    /\ phase = "build"
    /\ aborted = (source.signal = "aborted")
    /\ deadlineFired = "none"
    /\ listener = InitialListenerBoundary[source]

\* buildResponsesRequest can return a body or throw before listener registration.
Build ==
    /\ phase = "build"
    /\ phase' \in {"ready", "buildFailed"}
    /\ UNCHANGED <<source, listener, aborted, deadlineFired>>

\* bridgeExternalAbortSignal skips registration for absent or pre-aborted signals.
Attach ==
    /\ phase = "ready"
    /\ phase' = "request"
    /\ listener' = (ExpectedResponses /\ source.entrypoint = "message" /\ source.signal = "live" /\ ~aborted)
    /\ UNCHANGED <<source, aborted, deadlineFired>>

\* The once-only abort listener removes itself when the external signal fires.
Abort ==
    /\ source.signal = "live"
    /\ ~aborted
    /\ aborted' = TRUE
    /\ listener' = FALSE
    /\ UNCHANGED <<source, phase, deadlineFired>>

\* Success, SDK failure, and generator close all enter the same finally block.
Finish ==
    /\ phase = "request"
    /\ phase' = "cleanup"
    /\ UNCHANGED <<source, listener, aborted, deadlineFired>>

\* The finally block calls the bridge's dispose function before the generator ends.
Dispose ==
    /\ phase = "cleanup"
    /\ phase' = "done"
    /\ listener' = CleanupBoundary[listener]
    /\ UNCHANGED <<source, aborted, deadlineFired>>

\* A slow stream can hit the transport deadline before the SDK ends the request.
Deadline ==
    /\ phase = "request"
    /\ ~aborted
    /\ deadlineFired = "none"
    /\ TransportDeadline[source] # "disabled"
    /\ deadlineFired' = TransportDeadline[source]
    /\ UNCHANGED <<source, phase, listener, aborted>>

Next == Build \/ Attach \/ Abort \/ Deadline \/ Finish \/ Dispose
Spec == Init /\ [][Next]_vars
RequestBuilt == phase \in {"ready", "request", "cleanup", "done"}
Routing == RequestBuilt => sink.responses = ExpectedResponses
ReasoningAndTools == RequestBuilt =>
    /\ sink.reasoning = source.reasoning
    /\ sink.tools = source.tools
NoListenerDuringBuild == phase \in {"build", "ready", "buildFailed"} => ~listener
ListenerReleased == phase \in {"done", "buildFailed"} => ~listener
Streaming == RequestBuilt => sink.streaming = (source.entrypoint = "message" /\ source.streaming # "off")
ExtraBody == RequestBuilt => sink.extra = source.extra
WellFormed == RequestBuilt => ~sink.badText
\* The transport deadline carries the configured value, never the platform default.
\* A disabled timeout never fires. A platform fire is legal only at the default config.
ConfiguredDeadlineOnly ==
    /\ (deadlineFired = "platform" => source.configuredTimeout = "default300")
    /\ (source.configuredTimeout = "disabled" => deadlineFired = "none")
====
