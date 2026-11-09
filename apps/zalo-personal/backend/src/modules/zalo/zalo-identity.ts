export function isQrIdentityMismatch(
  persistedZaloUid: string | null | undefined,
  scannedZaloUid: string,
): boolean {
  return Boolean(persistedZaloUid && persistedZaloUid !== scannedZaloUid);
}
