# Evaluator meta-evaluation

The gold-agreement gate measures the extraction/classification and source-grounding
judges against human-reviewed cases. Every stage must achieve at least 0.90
agreement in the optional live-model tier.

A miss below the floor is tolerated as measurement error. The only sanctioned
responses are:

1. add the missed boundary case to the gold fixture; and
2. improve the applicable prompt globally, then rerun the entire gold set.

Never add a code-side regex, token list, fixture name, or other special case for
one judge miss.

Claim-state mutations are covered by the metrics and evaluator tests: supported,
stale, hallucinated, and unverified current claims must remain a complete,
single-denominator partition. Forgetting behavior is tested separately against
the deterministic obsolete-API watch set.
