/** A mistake the person can fix. `exitCode` is 2 unless a command documents another. */
export class UsageError extends Error {
    constructor(message: string, readonly exitCode = 2) {
        super(message);
        this.name = 'UsageError';
    }
}
