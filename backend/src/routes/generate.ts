import type { FastifyInstance } from 'fastify';
import { GenerateRequestSchema } from '@covergeist/shared';
import { db } from '../db/client';
import { generationLog } from '../db/schema';
import { AnthropicClient, LLMTimeoutError } from '../llm/AnthropicClient';
import { TypeScriptStrategy } from '../llm/TypeScriptStrategy';
import { authPreHandler } from '../middleware/auth';
import { quotaPreHandler } from '../middleware/quota';

const anthropic = new AnthropicClient(process.env.ANTHROPIC_API_KEY!);

export async function generateRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post(
    '/v1/generate',
    { preHandler: [authPreHandler, quotaPreHandler] },
    async (request, reply) => {
      const parseResult = GenerateRequestSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.status(400).send({
          error: 'validation_error',
          details: parseResult.error.errors,
        });
      }

      // snippetCode and contextCode are NEVER written to logs or DB (NFR1)
      const { snippet } = parseResult.data;

      const prompt = TypeScriptStrategy.buildPrompt(snippet);

      let rawResponse: string;
      try {
        rawResponse = await anthropic.generate(prompt);
      } catch (err) {
        if (err instanceof LLMTimeoutError) {
          return reply.status(504).send({ error: 'llm_timeout' });
        }
        throw err;
      }

      const test = TypeScriptStrategy.sanitiseResponse(rawResponse);

      // Log the generation — no code content stored (NFR1)
      if (request.billingPeriodStart) {
        await db.insert(generationLog).values({
          userId: request.user.userId,
          billingPeriodStart: request.billingPeriodStart,
        });
      }

      // Derive suggested test path by inserting .test before the extension
      const { relativeFilePath } = snippet;
      const dotIdx = relativeFilePath.lastIndexOf('.');
      const suggestedTestFilePath =
        dotIdx >= 0
          ? `${relativeFilePath.slice(0, dotIdx)}.test${relativeFilePath.slice(dotIdx)}`
          : `${relativeFilePath}.test`;

      return reply.status(200).send({ test, suggestedTestFilePath });
    },
  );
}
