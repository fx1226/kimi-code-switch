---
name: review-pr
description: Review a pull request against project standards
type: prompt
whenToUse: When a user asks for a pull request review
disableModelInvocation: false
arguments:
  - pr_ref
---

Review pull request $pr_ref and report correctness, security, and test gaps.
