import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
import { generateRoutes } from './routes/generate';
import { quotaRoutes } from './routes/quota';
import { subscriptionRoutes } from './routes/subscription';
import { stripeWebhookRoutes } from './routes/webhooks/stripe';

async function buildServer() {
  const server = Fastify({ logger: true });

  await server.register(cors, { origin: false });
  await server.register(rateLimit, { max: 100, timeWindow: '1 minute' });

  server.get('/health', async () => ({ status: 'ok' }));

  await server.register(subscriptionRoutes);
  await server.register(quotaRoutes);
  await server.register(generateRoutes);
  await server.register(stripeWebhookRoutes);

  return server;
}

const port = Number(process.env.PORT) || 3000;

buildServer()
  .then(server => server.listen({ port, host: '0.0.0.0' }))
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
