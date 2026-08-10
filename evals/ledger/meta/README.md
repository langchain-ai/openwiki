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

The defect harness evaluates seeded mutations in captured artifacts without
running OpenWiki. It verifies that invented, stale, coverage, retention, and
padding defects produce the expected signals while the clean baseline produces
no invented claims.
