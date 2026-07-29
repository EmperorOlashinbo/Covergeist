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
        // Surface Anthropic errors as 502 so the client shows a useful message
        const detail = err instanceof Error ? err.message : String(err);
        fastify.log.error({ err }, 'Anthropic API error');
        return reply.status(502).send({ error: 'llm_error', detail });
      }

      const test = TypeScriptStrategy.sanitiseResponse(rawResponse);

      // Log the generation — fire-and-forget so a DB hiccup never discards a
      // successfully-generated test from the user's perspective.
      if (request.billingPeriodStart) {
        db.insert(generationLog)
          .values({ userId: request.user.userId, billingPeriodStart: request.billingPeriodStart })
          .catch(e => fastify.log.error({ e }, 'generationLog insert failed'));
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
