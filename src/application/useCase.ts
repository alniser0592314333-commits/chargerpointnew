/**
 * Application Use Case Architecture Layer
 * Provides Command and Query bus patterns for decoupled business operations.
 */

import { Result } from '../types/common';

export interface Command<TPayload = unknown, TResult = unknown> {
  type: string;
  payload: TPayload;
  timestamp: string;
}

export interface Query<TParams = unknown, TResult = unknown> {
  type: string;
  params: TParams;
}

export interface CommandHandler<TCommand extends Command<any, any>, TResult = unknown> {
  handle(command: TCommand): Promise<Result<TResult>>;
}

export interface QueryHandler<TQuery extends Query<any, any>, TResult = unknown> {
  execute(query: TQuery): Promise<Result<TResult>>;
}
