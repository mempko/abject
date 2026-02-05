/**
 * Protocol Agreement management.
 */

import {
  ProtocolAgreement,
  AbjectId,
  AgreementId,
  MessageTransformation,
} from '../core/types.js';
import { require, ensure } from '../core/contracts.js';

/**
 * Check if an agreement is expired.
 */
export function isExpired(agreement: ProtocolAgreement): boolean {
  if (!agreement.expiresAt) {
    return false;
  }
  return Date.now() > agreement.expiresAt;
}

/**
 * Check if an agreement needs health check.
 */
export function needsHealthCheck(
  agreement: ProtocolAgreement,
  lastCheck: number
): boolean {
  const elapsed = Date.now() - lastCheck;
  return elapsed >= agreement.healthCheckInterval;
}

/**
 * Create a new agreement ID.
 */
export function createAgreementId(
  sourceId: AbjectId,
  targetId: AbjectId
): AgreementId {
  return `agreement-${sourceId}-${targetId}-${Date.now()}` as AgreementId;
}

/**
 * Validate an agreement.
 */
export function validateAgreement(agreement: ProtocolAgreement): string[] {
  const errors: string[] = [];

  if (!agreement.agreementId) {
    errors.push('agreementId is required');
  }

  if (!agreement.participants || agreement.participants.length !== 2) {
    errors.push('Exactly 2 participants required');
  }

  if (!agreement.protocol?.version) {
    errors.push('protocol.version is required');
  }

  if (agreement.healthCheckInterval <= 0) {
    errors.push('healthCheckInterval must be positive');
  }

  if (agreement.createdAt <= 0) {
    errors.push('createdAt must be positive');
  }

  if (agreement.expiresAt && agreement.expiresAt <= agreement.createdAt) {
    errors.push('expiresAt must be after createdAt');
  }

  return errors;
}

/**
 * Clone an agreement with updated timestamp.
 */
export function renewAgreement(
  agreement: ProtocolAgreement,
  ttlMs?: number
): ProtocolAgreement {
  const now = Date.now();
  return {
    ...agreement,
    createdAt: now,
    expiresAt: ttlMs ? now + ttlMs : undefined,
  };
}

/**
 * Merge bindings from two agreements.
 */
export function mergeBindings(
  a: Record<AbjectId, MessageTransformation[]>,
  b: Record<AbjectId, MessageTransformation[]>
): Record<AbjectId, MessageTransformation[]> {
  const result: Record<AbjectId, MessageTransformation[]> = { ...a };

  for (const [id, transforms] of Object.entries(b)) {
    if (result[id]) {
      result[id] = [...result[id], ...transforms];
    } else {
      result[id] = transforms;
    }
  }

  return result;
}

/**
 * Agreement store for managing multiple agreements.
 */
export class AgreementStore {
  private agreements: Map<AgreementId, ProtocolAgreement> = new Map();
  private byParticipant: Map<AbjectId, Set<AgreementId>> = new Map();
  private lastHealthChecks: Map<AgreementId, number> = new Map();

  /**
   * Store an agreement.
   */
  store(agreement: ProtocolAgreement): void {
    const errors = validateAgreement(agreement);
    require(errors.length === 0, `Invalid agreement: ${errors.join(', ')}`);

    this.agreements.set(agreement.agreementId, agreement);

    // Index by participant
    for (const participantId of agreement.participants) {
      if (!this.byParticipant.has(participantId)) {
        this.byParticipant.set(participantId, new Set());
      }
      this.byParticipant.get(participantId)!.add(agreement.agreementId);
    }

    this.lastHealthChecks.set(agreement.agreementId, Date.now());

    ensure(
      this.agreements.has(agreement.agreementId),
      'Agreement must be stored'
    );
  }

  /**
   * Get an agreement by ID.
   */
  get(agreementId: AgreementId): ProtocolAgreement | undefined {
    return this.agreements.get(agreementId);
  }

  /**
   * Remove an agreement.
   */
  remove(agreementId: AgreementId): boolean {
    const agreement = this.agreements.get(agreementId);
    if (!agreement) {
      return false;
    }

    // Remove from participant index
    for (const participantId of agreement.participants) {
      this.byParticipant.get(participantId)?.delete(agreementId);
    }

    this.agreements.delete(agreementId);
    this.lastHealthChecks.delete(agreementId);

    return true;
  }

  /**
   * Get all agreements for a participant.
   */
  getForParticipant(participantId: AbjectId): ProtocolAgreement[] {
    const ids = this.byParticipant.get(participantId);
    if (!ids) {
      return [];
    }

    return Array.from(ids)
      .map((id) => this.agreements.get(id))
      .filter((a): a is ProtocolAgreement => a !== undefined);
  }

  /**
   * Get agreement between two specific participants.
   */
  getBetween(
    participantA: AbjectId,
    participantB: AbjectId
  ): ProtocolAgreement | undefined {
    const aIds = this.byParticipant.get(participantA);
    if (!aIds) {
      return undefined;
    }

    for (const id of aIds) {
      const agreement = this.agreements.get(id);
      if (
        agreement &&
        agreement.participants.includes(participantA) &&
        agreement.participants.includes(participantB)
      ) {
        return agreement;
      }
    }

    return undefined;
  }

  /**
   * Get expired agreements.
   */
  getExpired(): ProtocolAgreement[] {
    return Array.from(this.agreements.values()).filter(isExpired);
  }

  /**
   * Get agreements needing health check.
   */
  getNeedingHealthCheck(): ProtocolAgreement[] {
    const result: ProtocolAgreement[] = [];

    for (const [id, agreement] of this.agreements) {
      const lastCheck = this.lastHealthChecks.get(id) ?? 0;
      if (needsHealthCheck(agreement, lastCheck)) {
        result.push(agreement);
      }
    }

    return result;
  }

  /**
   * Record a health check.
   */
  recordHealthCheck(agreementId: AgreementId): void {
    this.lastHealthChecks.set(agreementId, Date.now());
  }

  /**
   * Get all agreements.
   */
  getAll(): ProtocolAgreement[] {
    return Array.from(this.agreements.values());
  }

  /**
   * Get agreement count.
   */
  get count(): number {
    return this.agreements.size;
  }

  /**
   * Clear all agreements.
   */
  clear(): void {
    this.agreements.clear();
    this.byParticipant.clear();
    this.lastHealthChecks.clear();
  }
}
