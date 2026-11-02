# Pancake conversation profile fix

Status: completed

## Scope

- Use the real Pancake `conversations` response contract; do not use `page_customers`.
- Keep credential storage, permissions, queue/run schema, Meta fallback, and inbound-message safety unchanged.
- Make full-page profile backfill crawl conversations once with `last_conversation_id`, then join by Page-scoped PSID.

## Acceptance criteria

- `page_customer.psid/name/gender` map from a real sanitized conversation fixture.
- Repeated equal identities in `page_customer`, `from`, and `customers` are accepted; conflicting identities are rejected.
- Requests do not send unsupported `customer_id` or `page_size` parameters.
- Backfill paginates 60 conversations at a time, does not make one Pancake conversation request per contact, and still falls back to Meta according to policy.
- Avatar lookup remains Page + PSID based; a missing avatar does not block name/gender updates.
- Focused business and worker tests plus affected typechecks pass.

## Files

- `packages/business/src/messenger-profile-provider/client.ts`
- `packages/business/src/messenger-profile-provider/service.ts`
- `packages/business/__tests__/messenger-profile-provider.test.ts`
- `apps/worker/src/integration/handlers/messenger-profile-backfill.ts`
- focused worker tests if needed

## Verification

- Provider tests: 7 passed.
- Worker regression tests: 221 passed.
- Business and worker typechecks passed.
- Ultracite and `git diff --check` passed for the touched files.
