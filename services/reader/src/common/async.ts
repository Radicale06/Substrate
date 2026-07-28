/**
 * Small async helpers that used to come from civkit. Local copies let us drop that
 * dependency, which pulled in a native library (libmagic) the service never used.
 */

export interface Deferred<T = void> {
    promise: Promise<T>;
    resolve: (value: T | PromiseLike<T>) => void;
    reject: (reason?: unknown) => void;
}

/** A promise whose settlement is controlled from outside. */
export function defer<T = void>(): Deferred<T> {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });

    return { promise, resolve, reject };
}

export function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Flattens an error into something safe to pass to a structured logger. */
export function marshalError(err: unknown): Record<string, unknown> {
    if (err instanceof Error) {
        return { name: err.name, message: err.message, stack: err.stack };
    }

    return { message: String(err) };
}

/**
 * Ensures at most one invocation of a method runs at a time; callers arriving while it
 * is busy receive the in-flight promise instead of starting a second run.
 */
export function singleFlight(): MethodDecorator {
    const running = new WeakMap<object, Promise<unknown>>();

    return (_target, _key, descriptor: any) => {
        const original = descriptor.value;
        descriptor.value = function (this: object, ...args: unknown[]) {
            const inFlight = running.get(this);
            if (inFlight) {
                return inFlight;
            }
            const result = Promise.resolve(original.apply(this, args))
                .finally(() => running.delete(this));
            running.set(this, result);

            return result;
        };

        return descriptor;
    };
}
