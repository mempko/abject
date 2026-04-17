/**
 * Message builders for creating well-formed Abject messages.
 */

import { v4 as uuidv4 } from 'uuid';
import {
  AbjectMessage,
  AbjectId,
  MessageId,
  AbjectError,
  MessageType,
  AgreementId,
} from './types.js';
import { require, requireNonEmpty } from './contracts.js';

const PROTOCOL_VERSION = '1.0.0';

interface MessageOptions {
  correlationId?: MessageId;
  negotiationId?: AgreementId;
}

/**
 * Create a unique message ID.
 */
export function createMessageId(): MessageId {
  return uuidv4();
}

/**
 * Get current timestamp in milliseconds.
 */
export function getTimestamp(): number {
  return Date.now();
}

/**
 * Sequence number generator per sender.
 */
const sequenceNumbers = new Map<AbjectId, number>();

function getNextSequence(senderId: AbjectId): number {
  const current = sequenceNumbers.get(senderId) ?? 0;
  const next = current + 1;
  sequenceNumbers.set(senderId, next);
  return next;
}

/**
 * Reset sequence number for a sender. Called by the bus on unregister
 * so terminated objects do not leak entries in the module-level map.
 */
export function resetSequence(senderId: AbjectId): void {
  sequenceNumbers.delete(senderId);
}

/**
 * Create base message structure.
 */
function createBaseMessage<T>(
  type: MessageType,
  from: AbjectId,
  to: AbjectId,
  payload: T,
  options: MessageOptions & { method?: string } = {}
): AbjectMessage<T> {
  requireNonEmpty(from, 'from');
  requireNonEmpty(to, 'to');

  return {
    header: {
      messageId: createMessageId(),
      correlationId: options.correlationId,
      sequenceNumber: getNextSequence(from),
      timestamp: getTimestamp(),
      type,
    },
    routing: {
      from,
      to,
      method: options.method,
    },
    payload,
    protocol: {
      version: PROTOCOL_VERSION,
      negotiationId: options.negotiationId,
    },
  };
}

/**
 * Create a request message.
 */
export function request<T>(
  from: AbjectId,
  to: AbjectId,
  method: string,
  payload: T,
  options: MessageOptions = {}
): AbjectMessage<T> {
  requireNonEmpty(method, 'method');

  return createBaseMessage('request', from, to, payload, {
    ...options,
    method,
  });
}

/**
 * Create a reply message in response to a request.
 */
export function reply<T>(
  originalMessage: AbjectMessage,
  payload: T,
  options: MessageOptions = {}
): AbjectMessage<T> {
  require(
    originalMessage.header.type === 'request',
    'Can only reply to request messages'
  );

  return createBaseMessage(
    'reply',
    originalMessage.routing.to,
    originalMessage.routing.from,
    payload,
    {
      ...options,
      correlationId: originalMessage.header.messageId,
      method: originalMessage.routing.method,
    }
  );
}

/**
 * Create an event message (one-way notification).
 */
export function event<T>(
  from: AbjectId,
  to: AbjectId,
  eventName: string,
  payload: T,
  options: MessageOptions = {}
): AbjectMessage<T> {
  requireNonEmpty(eventName, 'eventName');

  return createBaseMessage('event', from, to, payload, {
    ...options,
    method: eventName,
  });
}

/**
 * Create an error message in response to a request.
 */
export function error(
  originalMessage: AbjectMessage,
  code: string,
  message: string,
  details?: unknown
): AbjectMessage<AbjectError> {
  requireNonEmpty(code, 'error code');
  requireNonEmpty(message, 'error message');

  const errorPayload: AbjectError = {
    code,
    message,
    details,
  };

  return createBaseMessage(
    'error',
    originalMessage.routing.to,
    originalMessage.routing.from,
    errorPayload,
    {
      correlationId: originalMessage.header.messageId,
      method: originalMessage.routing.method,
    }
  );
}

/**
 * Create an error message for unhandled exceptions.
 */
export function errorFromException(
  originalMessage: AbjectMessage,
  err: unknown
): AbjectMessage<AbjectError> {
  const errorPayload: AbjectError = {
    code: 'UNHANDLED_EXCEPTION',
    message: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  };

  return createBaseMessage(
    'error',
    originalMessage.routing.to,
    originalMessage.routing.from,
    errorPayload,
    {
      correlationId: originalMessage.header.messageId,
      method: originalMessage.routing.method,
    }
  );
}

/**
 * Check if a message is a request.
 */
export function isRequest(msg: AbjectMessage): boolean {
  return msg.header.type === 'request';
}

/**
 * Check if a message is a reply.
 */
export function isReply(msg: AbjectMessage): boolean {
  return msg.header.type === 'reply';
}

/**
 * Check if a message is an event.
 */
export function isEvent(msg: AbjectMessage): boolean {
  return msg.header.type === 'event';
}

/**
 * Check if a message is an error.
 */
export function isError(msg: AbjectMessage): boolean {
  return msg.header.type === 'error';
}

/**
 * Check if message B is a reply to message A.
 */
export function isReplyTo(a: AbjectMessage, b: AbjectMessage): boolean {
  return (
    b.header.type === 'reply' &&
    b.header.correlationId === a.header.messageId
  );
}

/**
 * Serialize a message to JSON string.
 */
export function serialize(msg: AbjectMessage): string {
  return JSON.stringify(msg);
}

/**
 * Deserialize a JSON string to a message.
 */
export function deserialize(json: string): AbjectMessage {
  require(json !== '', 'Cannot deserialize empty string');
  const msg = JSON.parse(json) as AbjectMessage;
  require(msg.header !== undefined, 'Message must have header');
  require(msg.routing !== undefined, 'Message must have routing');
  require(msg.protocol !== undefined, 'Message must have protocol');
  return msg;
}
