# Phase 2: service activation

Status: complete

- Give each application service an independent image tag in Compose.
- Pull and verify only requested application images.
- Preserve the running tags of untouched services.
- Activate requested services without starting their dependencies again.
- Record per-service current and previous tags and roll back only touched
  services after a failed health check.
- Keep the legacy full deployment as the default when no service list is given.
