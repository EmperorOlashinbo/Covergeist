import { date, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  clerkId: text('clerk_id').unique().notNull(),
  email: text('email').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

export const subscriptions = pgTable('subscriptions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id),
  stripeCustomerId: text('stripe_customer_id').notNull(),
  stripeSubscriptionId: text('stripe_subscription_id').unique(),
  status: text('status').notNull(),
  currentPeriodStart: date('current_period_start'),
  currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }),
  generationsLimit: integer('generations_limit').notNull().default(50),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
});

export const generationLog = pgTable('generation_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id),
  billingPeriodStart: date('billing_period_start').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});
