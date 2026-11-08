export type LegacyTraceEntry = {
  name: string;
  payload?: unknown;
};

export type LegacyScenario<TInput = unknown> = {
  name: string;
  input: TInput;
};

export type LegacyScenarioDriver<TInput = unknown> = (
  scenario: LegacyScenario<TInput>,
) => Promise<LegacyTraceEntry[]>;

export async function compareLegacyScenario<TInput>(
  scenario: LegacyScenario<TInput>,
  legacy: LegacyScenarioDriver<TInput>,
  candidate: LegacyScenarioDriver<TInput>,
): Promise<{ legacy: LegacyTraceEntry[]; candidate: LegacyTraceEntry[] }> {
  const [legacyTrace, candidateTrace] = await Promise.all([
    legacy(scenario),
    candidate(scenario),
  ]);
  return { legacy: legacyTrace, candidate: candidateTrace };
}
