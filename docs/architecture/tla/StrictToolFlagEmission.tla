---- MODULE StrictToolFlagEmission ----
\* Source: the tool conversion call site in LiteLLMHandler.createMessage.
\* The call site passes a strict flag to BaseProvider.convertToolsForOpenAI.
\* The flag is a boolean. Unfixed code omits it. The default applies (true).
\* Sink: the emitted OpenAI-format function tool. The tool carries function.strict.
\* Endpoint: an oracle. It accepts or rejects a tool that carries strict true.
\* A strict-unaware endpoint rejects strict true (issue 1137, LiteLLM to Bedrock).
\* Failure: the call site keeps the default flag true. The emitted tool carries
\* strict true. The strict-unaware endpoint rejects the request with error 400.
\* Invariant: EmitsStrictIffAccepted. An emitted tool carries strict true only
\* when the endpoint accepts a strict-true tool.
\* Fix: the call site passes strict false. MCCallSiteFlag models the hook.
\* Sabotage: the Unfixed variant flips the hook to the default true. It must
\* fail EmitsStrictIffAccepted.
\* Expect: the unfixed hook fails the invariant on a strict-unaware endpoint.
\* Replay: the unfixed call site sends strict true and the Bedrock route in
\* issue 1137 answers error 400 (tools.0.custom.strict). The red unit test
\* in lite-llm.spec.ts shows the same emission before the fix.
\* Result: Fixed holds in 4 states. Unfixed fails EmitsStrictIffAccepted.
\* No new failure was found.
\* Review: 0 covered, 0 added, 0 gap. PR 2688. No earlier subsystem spec
\* exists. Schema content is outside this model. StrictToolSchema (PR 2653)
\* owns it. This spec owns only the strict flag at the call site.
\* Not modeled: HTTP transport, model choice, and the MCP server schema.
\* The unit tests cover the MCP exemption and schema preservation.
\* Cost: each TLC run takes less than 1 second. Agent work takes about 5 minutes.

CONSTANT CallSiteFlag
CONSTANT OmitsStrictKey
VARIABLE input

\* acceptsStrict: the endpoint accepts a strict-true tool. A strict-aware
\* endpoint accepts it. A strict-unaware proxy (LiteLLM to Bedrock) rejects it.
\* acceptsStrictKey: the endpoint accepts a tool that carries the strict key
\* at all, even when its value is false. Some strict-unaware proxies reject
\* any presence of the key (issue 1137).
\* isMcp: the tool name has the MCP prefix. The emitter keeps strict false
\* for such tools.
Inputs == [acceptsStrict : BOOLEAN, acceptsStrictKey : BOOLEAN, isMcp : BOOLEAN]
Init == input \in Inputs
Next == UNCHANGED input
Spec == Init /\ [][Next]_input

\* The emitter is BaseProvider.convertToolsForOpenAI. The LiteLLM route omits
\* the strict key entirely; other routes emit it. A non-MCP tool takes its
\* strict value from the call-site flag when the key is present.
EmittedStrictKey == ~OmitsStrictKey /\ ~input.isMcp
EmittedStrict == EmittedStrictKey /\ CallSiteFlag /\ ~input.isMcp

TypeOK == input \in Inputs
EmitsStrictIffAccepted == EmittedStrict => input.acceptsStrict
PresentKeyAccepted == EmittedStrictKey => input.acceptsStrictKey
====