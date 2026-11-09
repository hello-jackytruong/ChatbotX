export function installBigIntJsonSerializer(): void {
  ;(BigInt.prototype as unknown as { toJSON?: () => string }).toJSON =
    function () {
      return this.toString()
    }
}
