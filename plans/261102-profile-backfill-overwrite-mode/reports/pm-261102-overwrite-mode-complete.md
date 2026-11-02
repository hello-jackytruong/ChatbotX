# Overwrite mode completion

Status: completed

## Delivered

- Admin-selectable overwrite switch with missing-only default.
- Run persistence and retry/history propagation.
- Full-Page candidate scan and non-destructive provider-field overwrite.
- Drizzle migration, localized UI keys, operator documentation, and focused tests.

## Verification

- 234 focused tests passed across database, business, builder, and worker.
- All affected typechecks passed.
- Full `pnpm lint` passed, including migration drift and i18n validation.

## Remaining

- Apply the pending database migration during deployment.
