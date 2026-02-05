/**
 * Design by Contract helpers.
 * Always enabled - correctness over performance.
 */

export class ContractViolation extends Error {
  constructor(
    public readonly type: 'require' | 'ensure' | 'invariant',
    message: string
  ) {
    super(`[${type.toUpperCase()}] ${message}`);
    this.name = 'ContractViolation';
  }
}

/**
 * Precondition check - validates inputs before execution.
 * Throws if condition is false.
 */
export function require(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new ContractViolation('require', message);
  }
}

/**
 * Postcondition check - validates outputs after execution.
 * Throws if condition is false.
 */
export function ensure(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new ContractViolation('ensure', message);
  }
}

/**
 * Invariant check - validates object state consistency.
 * Throws if condition is false.
 */
export function invariant(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new ContractViolation('invariant', message);
  }
}

/**
 * Assert that a value is not null or undefined.
 * Returns the value with narrowed type.
 */
export function requireDefined<T>(
  value: T | null | undefined,
  message: string
): T {
  require(value !== null && value !== undefined, message);
  return value;
}

/**
 * Assert that a string is not empty.
 */
export function requireNonEmpty(value: string, name: string): asserts value {
  require(value !== '', `${name} must not be empty`);
}

/**
 * Assert that an array is not empty.
 */
export function requireNonEmptyArray<T>(
  value: T[],
  name: string
): asserts value {
  require(value.length > 0, `${name} must not be empty`);
}

/**
 * Assert that a number is positive.
 */
export function requirePositive(value: number, name: string): asserts value {
  require(value > 0, `${name} must be positive, got ${value}`);
}

/**
 * Assert that a number is non-negative.
 */
export function requireNonNegative(value: number, name: string): asserts value {
  require(value >= 0, `${name} must be non-negative, got ${value}`);
}
