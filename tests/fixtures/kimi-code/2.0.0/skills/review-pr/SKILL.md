---
name: review-pr
description: Review a Pull Request according to team standards and produce a structured review report
type: prompt
whenToUse: When the user asks me to review a PR, inspect code changes, or evaluate commit quality
arguments:
  - pr_ref
---

Please review the PR the user specified: $pr_ref

1. Fetch and read the full diff for `$pr_ref`.
2. Check each of the following items:
   - Whether corresponding test cases are included
   - Whether public API documentation has been updated
   - Whether new dependencies have been introduced; if so, state the reason
   - Whether error handling covers edge cases
3. Refer to the checklist in the same directory: `references/checklist.md`
4. Produce a review report containing:
   - Overall conclusion (approve / request changes / comment)
   - Required changes (blocking)
   - Suggested improvements (non-blocking)
   - Noteworthy positives
