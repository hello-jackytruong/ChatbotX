import type { ProviderCommandV1, ProviderResultV1 } from './contracts.js';
import { providerCommandSchema, providerResultSchema } from './contracts.js';
import type { GatewayCommandRecord } from '../gateway/command-repository.js';

type DurableCommandRepository = {
  insert(input: {
    commandId: string;
    accountId: string;
    idempotencyKey: string;
    kind: string;
    version: number;
    payload: Record<string, unknown>;
  }): Promise<{ created: boolean; command: GatewayCommandRecord }>;
  get(commandId: string): Promise<GatewayCommandRecord | null>;
};

const terminalStatuses = new Set(['succeeded', 'rejected', 'failed', 'unknown_outcome']);

export class GatewayProviderClient {
  constructor(
    private readonly commands: DurableCommandRepository,
    private readonly pollIntervalMs = 50,
  ) {}

  async execute(input: ProviderCommandV1): Promise<ProviderResultV1> {
    const command = providerCommandSchema.parse(input);
    const inserted = await this.commands.insert(command);
    const deadline = Date.parse(command.deadlineAt);
    let current = inserted.command;

    while (!terminalStatuses.has(current.status) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
      current = await this.commands.get(current.commandId) ?? current;
    }

    if (!terminalStatuses.has(current.status)) {
      return {
        version: 1,
        commandId: command.commandId,
        status: 'unknown_outcome',
        providerIds: {},
        errorCode: 'GATEWAY_TIMEOUT',
        retryable: false,
      };
    }

    return providerResultSchema.parse(current.result ?? {
      version: 1,
      commandId: current.commandId,
      status: current.status,
      providerIds: {},
      errorCode: current.error ?? undefined,
      retryable: false,
    });
  }
}
