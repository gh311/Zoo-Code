---- MODULE StrictToolFlagEmissionMC ----
\* Model-checking selectors and the injected defect for StrictToolFlagEmission.
\* Contract, findings, and cost: see the StrictToolFlagEmission header.
\* Fixed passes and the Unfixed defect fails EmitsStrictIffAccepted.
EXTENDS StrictToolFlagEmission
CONSTANT Variant

\* Fixed: the call site passes strict false (issue 1137).
\* Unfixed: the call site omits the flag. The default applies (true).
MCCallSiteFlag == Variant = "Unfixed"
====
