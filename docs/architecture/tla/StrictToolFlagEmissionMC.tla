---- MODULE StrictToolFlagEmissionMC ----
\* Model-checking selectors and the injected defect for StrictToolFlagEmission.
\* Contract, findings, and cost: see the StrictToolFlagEmission header.
\* Fixed passes and the Unfixed defect fails EmitsStrictIffAccepted.
EXTENDS StrictToolFlagEmission
CONSTANT Variant

\* Fixed: the call site omits the strict key entirely (issue 1137).
\* Unfixed: the call site keeps the default flag true. The default applies (true).
\* KeyPresent: the strict key is present but the endpoint rejects its presence.
MCCallSiteFlag == Variant = "Unfixed"
MCOmitsStrictKey == Variant = "Fixed"
====