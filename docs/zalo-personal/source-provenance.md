# Zalo Personal source provenance

The Zalo Personal application under `apps/zalo-personal/` was imported from an
authorized MIT-licensed Community source checkout:

- Baseline commit: `c03c03245a1010d1e279d0548edc5b1f568f3a9e`
- Import date: 2026-11-07
- License: MIT (`apps/zalo-personal/LICENSE`)

The imported tree also contains the uncommitted characterization-test and contract-lock work created after the baseline commit. It intentionally excludes local/runtime material: `.git`, `.env*` except examples, `node_modules`, `dist`, coverage, `.data`, uploads and backups.

## Locked hashes at import

| Artifact | SHA-256 |
| --- | --- |
| Prisma schema | `981409634d42a77478eea9611b21240a2f2c1c4174dcfda98d0739e125d157e2` |
| Database contract | `a6a5a51e730af4806ffeb9d436aaef7a3c52361bb830e0cf04b99d9f1f3a8f63` |
| REST contract | `f1eea23fc20efed821905b74dfea10a92523c33c1b18eb52f4c0e1418b15fd9b` |
| Runtime REST contract | `7d009cbd1183ba500da871816cae09adb2ad3a97a68983ae3c78a221b383b322` |
| Socket contract | `d2acaff05361bc64cd08b5ef26ea761722b5a4e24c782b644a0780d7455540ae` |
| Runtime socket contract | `fc4cb3c37436a081d6c8a8a8726b45740a742c60774108f4b026c0c598c174c3` |
| Object contract | `494ac12413226ffbe9f9c80b1ff29fb2de517091cc6ba200d5f333f00ae8adc2` |
| Function/test map | `71bf90aa429e2ccb0f28a697fbc981d890740108704eab451dc389d9685819b5` |

Run `pnpm zalo-personal:source:check` to verify the imported tree does not contain forbidden runtime or secret files. Run the two-target oracle while an authorized source checkout remains available:

```bash
pnpm zalo-personal:test:oracle --old /path/to/source-checkout --new apps/zalo-personal
```

The oracle proves that the frozen manifests match. It does not claim Phase 2 test coverage is complete.
