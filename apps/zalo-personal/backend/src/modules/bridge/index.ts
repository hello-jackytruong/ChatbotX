import type { FastifyInstance } from 'fastify';
import { prisma } from '../../shared/database/prisma-client.js';
import { PrismaGatewayCommandRepository } from '../gateway/command-repository.js';
import { PrismaGatewayEventOutbox } from '../gateway/event-outbox.js';
import { BridgeAuthenticator } from './auth.js';
import { PrismaBridgeAccountBindingRepository } from './prisma-account-binding.js';
import { PrismaBridgeKeyResolver, PrismaBridgeNonceStore } from './prisma-auth.js';
import { PrismaBridgeOnboardingRepository } from './prisma-onboarding.js';
import { createBridgeRoutes } from './routes.js';

export async function bridgeRoutes(app: FastifyInstance): Promise<void> {
  const sql = prisma as never;
  await createBridgeRoutes({
    auth: new BridgeAuthenticator(
      new PrismaBridgeKeyResolver(),
      new PrismaBridgeNonceStore(),
    ),
    bindings: new PrismaBridgeAccountBindingRepository(),
    commands: new PrismaGatewayCommandRepository(sql),
    events: new PrismaGatewayEventOutbox(sql),
    onboarding: new PrismaBridgeOnboardingRepository(),
  })(app);
}
