import { eq } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { db } from '../db/client';
import { users } from '../db/schema';

declare module 'fastify' {
  interface FastifyRequest {
    user: {
      clerkId: string;
      email: string;
      userId: string;
    };
  }
}

const JWKS = createRemoteJWKSet(new URL(process.env.CLERK_JWKS_URL!), {
  cacheMaxAge: 60 * 60 * 1000, // 1-hour cache per architecture §7
});

export async function authPreHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const authHeader = request.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    await reply.status(401).send({ error: 'unauthorized' });
    return;
  }

  const token = authHeader.slice(7);

  try {
    const { payload } = await jwtVerify(token, JWKS);

    const clerkId = payload.sub;
    if (!clerkId) {
      await reply.status(401).send({ error: 'unauthorized' });
      return;
    }

    // Clerk JWT template should include email_address; fall back to empty string
    const email =
      (payload['email_address'] as string | undefined) ??
      (payload['email'] as string | undefined) ??
      '';

    // Upsert user on every authenticated request (idempotent)
    const [user] = await db
      .insert(users)
      .values({ clerkId, email })
      .onConflictDoUpdate({
        target: users.clerkId,
        set: { email },
      })
      .returning({ id: users.id });

    request.user = { clerkId, email, userId: user.id };
  } catch {
    await reply.status(401).send({ error: 'unauthorized' });
  }
}
