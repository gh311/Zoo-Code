---- MODULE ChatCompletionsParameters ----
\* Source: OpenAiHandler options. Sink: chat-completions request body.
\* Failure: enterprise endpoints reject parallel_tool_calls and tool_choice.
\* Rule: per-profile omit flag removes both keys entirely (never null).
CONSTANTS HonorOmit, HonorDefault, HonorNoNull
VARIABLE source

Domain == [omitFlag : BOOLEAN, parallelToolCalls : BOOLEAN]

Body(s) ==
  IF ~HonorOmit /\ s.omitFlag THEN {"parallel_tool_calls", "tool_choice"}
  ELSE IF s.omitFlag THEN
       IF ~HonorNoNull THEN {"null"} ELSE {}
  ELSE IF ~HonorDefault THEN {}
  ELSE {"parallel_tool_calls", "tool_choice"}

Init == source \in Domain
Next == UNCHANGED source
Spec == Init /\ [][Next]_source

OmittedMeansAbsent == source.omitFlag => ("parallel_tool_calls" \notin Body(source) /\ "tool_choice" \notin Body(source))
DefaultKeepsParam == ~source.omitFlag => ("parallel_tool_calls" \in Body(source) /\ "tool_choice" \in Body(source))
NoNullMembers == \A p \in Body(source) : p # "null"
====
