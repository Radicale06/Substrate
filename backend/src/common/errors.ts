/**
 * Domain errors, deliberately free of HTTP concerns. The global exception filter maps
 * them to status codes, so services never need to know how they will be reported.
 */

/** A caller-supplied value is unusable. Maps to 400. */
export class BadRequestError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'BadRequestError';
    }
}

/** The requested thing is not there. Maps to 404. */
export class NotFoundError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'NotFoundError';
    }
}

/** The request conflicts with existing state, and retrying will not help. Maps to 409. */
export class ConflictError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ConflictError';
    }
}

/** A request tried to reach somewhere it must not. Maps to 403. */
export class SecurityCompromiseError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'SecurityCompromiseError';
    }
}

/** The browser died mid-request. Maps to 503, since retrying may well work. */
export class ServiceCrashedError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ServiceCrashedError';
    }
}

/** An expectation about a page or response did not hold. Maps to 502. */
export class UpstreamFailureError extends Error {
    constructor(message: string, override readonly cause?: unknown) {
        super(message);
        this.name = 'UpstreamFailureError';
    }
}

/** The domain error types above, as a set the catch-and-rethrow sites can test against. */
const DOMAIN_ERRORS = [
    BadRequestError,
    ConflictError,
    NotFoundError,
    SecurityCompromiseError,
    ServiceCrashedError,
    UpstreamFailureError,
] as const;

/** Whether an error is one of ours, and so already carries its intended status. */
export function isDomainError(err: unknown): err is Error {
    return DOMAIN_ERRORS.some((type) => err instanceof type);
}
