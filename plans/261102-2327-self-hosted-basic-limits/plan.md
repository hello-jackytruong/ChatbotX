# Self-hosted basic limits

Status: complete

## Scope

- Allow self-hosted Community/Enterprise installations to create multiple workspaces and channels and invite multiple members.
- Preserve usage counters while ignoring finite `UserQuota` limits for `workspaces`, `channels`, and `teamMembers` outside Cloud.
- Keep Cloud quota enforcement and all Enterprise/license gates unchanged.
- Keep Community member permission behavior unchanged; this change affects capacity only.

## Implementation

1. Remove the Community-only one-workspace guard and keep the shared quota-consumption path.
2. Show the create-workspace card after the first Community workspace.
3. Make basic-capacity checks unlimited on self-hosted editions while continuing to increment usage counters.
4. Update focused business and builder tests.

## Acceptance criteria

- Community users can create a second workspace.
- Self-hosted workspace/channel creation is not rejected by finite basic quota limits.
- Self-hosted member invite/accept checks do not reject on `teamMembersLimit`.
- Cloud continues enforcing all existing limits.
- Enterprise features, member permission policy, schemas, and public APIs remain unchanged.

## Verification

- Focused workspace, quota-enforcement, workspace-list, and integration-webchat tests passed sequentially (108 tests across the latest targeted runs).
- Business type-check passed. Builder type-check produced no error before its polling session was interrupted, so its final exit status was not captured.
- Independent review found and verified the self-hosted Webchat channel preflight fix; Cloud enforcement and usage-counter behavior remain unchanged.
