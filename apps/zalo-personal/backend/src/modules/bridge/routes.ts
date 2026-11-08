import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { providerCommandSchema } from '../zalo-provider/contracts.js';
import type { GatewayCommandRecord } from '../gateway/command-repository.js';
import type { GatewayEventRecord } from '../gateway/event-outbox.js';
import {
  BridgeAuthError,
  type BridgeKey,
  type BridgeSignedRequest,
  signBridgeResponse,
} from './auth.js';

type BridgeAuthPort = {
  verify(request: BridgeSignedRequest, accountId?: string): Promise<BridgeKey>;
};

type CommandPort = {
  insert(input: {
    commandId: string;
    accountId: string;
    idempotencyKey: string;
    kind: string;
    version: number;
    payload: Record<string, unknown>;
  }): Promise<{ created: boolean; command: GatewayCommandRecord }>;
  get(commandId: string): Promise<GatewayCommandRecord | null>;
  reconcile?(input: {
    accountId: string;
    commandId?: string;
    idempotencyKey?: string;
    providerMessageId?: string;
  }): Promise<GatewayCommandRecord | null>;
};

type EventPort = {
  list(accountId: string, afterSequence: bigint, limit: number): Promise<GatewayEventRecord[]>;
  bounds?(accountId: string): Promise<{ highWaterMark: bigint; retentionFloor: bigint }>;
};

export type BridgeRouteDependencies = {
  auth: BridgeAuthPort;
  commands: CommandPort;
  events: EventPort;
};

function requiredHeader(request: FastifyRequest, name: string): string {
  const value = request.headers[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new BridgeAuthError(`MISSING_${name.toUpperCase().replaceAll('-', '_')}`, 401);
  }
  return value;
}

function signedRequest(request: FastifyRequest): BridgeSignedRequest {
  const timestamp = Number(requiredHeader(request, 'x-bridge-timestamp'));
  return {
    kid: requiredHeader(request, 'x-bridge-kid'),
    method: request.method,
    pathAndQuery: request.url,
    timestamp,
    nonce: requiredHeader(request, 'x-bridge-nonce'),
    body: request.body ?? null,
    signature: requiredHeader(request, 'x-bridge-signature'),
  };
}

function commandResponse(command: GatewayCommandRecord) {
  return {
    version: command.version,
    commandId: command.commandId,
    accountId: command.accountId,
    status: command.status,
    result: command.result,
    error: command.error,
    attempts: command.attempts,
  };
}

function signedReply(reply: FastifyReply, principal: BridgeKey, correlationId: string, payload: unknown) {
  reply.header('x-bridge-correlation-id', correlationId);
  reply.header('x-bridge-response-signature', signBridgeResponse(principal.secret, correlationId, payload));
  return payload;
}

export function createBridgeRoutes(dependencies: BridgeRouteDependencies) {
  return async function bridgeRoutes(app: FastifyInstance): Promise<void> {
    app.setErrorHandler((error, _request, reply) => {
      if (error instanceof BridgeAuthError) {
        return reply.status(error.statusCode).send({ error: error.code });
      }
      if (error instanceof ZodError) {
        return reply.status(400).send({ error: 'INVALID_BRIDGE_PAYLOAD' });
      }
      if (error instanceof Error && error.message === 'IDEMPOTENCY_CONFLICT') {
        return reply.status(409).send({ error: 'IDEMPOTENCY_CONFLICT' });
      }
      return reply.status(500).send({ error: 'BRIDGE_INTERNAL_ERROR' });
    });

    app.post('/internal/bridge/v1/commands', async (request, reply) => {
      if ((request.body as { version?: unknown } | null)?.version !== 1) {
        return reply.status(426).send({ error: 'UNSUPPORTED_BRIDGE_VERSION', supported: [1] });
      }
      const command = providerCommandSchema.parse(request.body);
      const principal = await dependencies.auth.verify(signedRequest(request), command.accountId);
      const inserted = await dependencies.commands.insert({
        commandId: command.commandId,
        accountId: command.accountId,
        idempotencyKey: command.idempotencyKey,
        kind: command.kind,
        version: command.version,
        payload: command.payload,
      });
      const payload = commandResponse(inserted.command);
      return reply.status(inserted.created ? 202 : 200)
        .send(signedReply(reply, principal, command.commandId, payload));
    });

    app.get<{ Params: { commandId: string } }>(
      '/internal/bridge/v1/commands/:commandId',
      async (request, reply) => {
        const principal = await dependencies.auth.verify(signedRequest(request));
        const command = await dependencies.commands.get(request.params.commandId);
        if (!command) return reply.status(404).send({ error: 'COMMAND_NOT_FOUND' });
        if (!principal.accountIds.includes(command.accountId)) {
          throw new BridgeAuthError('ACCOUNT_SCOPE_DENIED', 403);
        }
        const payload = commandResponse(command);
        return signedReply(reply, principal, command.commandId, payload);
      },
    );

    app.get<{
      Params: { accountId: string };
      Querystring: { after?: string; limit?: string };
    }>('/internal/bridge/v1/accounts/:accountId/events', async (request, reply) => {
      const { accountId } = request.params;
      const principal = await dependencies.auth.verify(signedRequest(request), accountId);
      const after = BigInt(request.query.after ?? '0');
      const limit = Math.min(500, Math.max(1, Number(request.query.limit ?? 100)));
      const events = await dependencies.events.list(accountId, after, limit);
      const nextSequence = events.at(-1)?.accountSequence ?? after;
      const firstSequence = events[0]?.accountSequence ?? after;
      const bounds = await dependencies.events.bounds?.(accountId) ?? {
        highWaterMark: nextSequence,
        retentionFloor: firstSequence,
      };
      const payload = {
        version: 1,
        accountId,
        nextSequence: String(nextSequence),
        highWaterMark: String(bounds.highWaterMark),
        retentionFloor: String(bounds.retentionFloor),
        events: events.map((event) => ({
          version: 1,
          eventId: event.eventId,
          accountId: event.accountId,
          accountSequence: String(event.accountSequence),
          fenceToken: String(event.fenceToken),
          kind: event.kind,
          providerEventId: event.providerEventId ?? null,
          payload: event.payload,
          occurredAt: event.occurredAt.toISOString(),
        })),
      };
      return signedReply(reply, principal, `${accountId}:${nextSequence}`, payload);
    });

    app.post<{ Body: {
      accountId: string;
      commandId?: string;
      echoId?: string;
      providerMessageId?: string;
    } }>(
      '/internal/bridge/v1/reconcile',
      async (request, reply) => {
        const { accountId, commandId, echoId, providerMessageId } = request.body;
        const principal = await dependencies.auth.verify(signedRequest(request), accountId);
        const command = dependencies.commands.reconcile
          ? await dependencies.commands.reconcile({
            accountId,
            commandId,
            idempotencyKey: echoId,
            providerMessageId,
          })
          : commandId ? await dependencies.commands.get(commandId) : null;
        if (command && command.accountId !== accountId) {
          throw new BridgeAuthError('ACCOUNT_SCOPE_DENIED', 403);
        }
        const payload = {
          version: 1,
          accountId,
          command: command ? commandResponse(command) : null,
          resolution: command?.status === 'succeeded' ? 'confirmed' : 'unresolved',
        };
        return signedReply(reply, principal, commandId ?? accountId, payload);
      },
    );

    app.get('/internal/bridge/v1/health', async (request, reply) => {
      const principal = await dependencies.auth.verify(signedRequest(request));
      const payload = { version: 1, ready: true };
      return signedReply(reply, principal, 'health', payload);
    });
  };
}
