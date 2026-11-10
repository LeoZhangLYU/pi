// Login throttling for the owner password: consecutive failures back off globally, and only one password verification
// runs at a time (scrypt is deliberately expensive). In memory only: a restart forgives everyone.

export class LoginAttempts {
	private failures = 0;
	private blockedUntil = 0;
	private verifying = false;
	private readonly now: () => number;
	private readonly limit: number;
	private readonly baseDelayMs: number;
	private readonly maxDelayMs: number;

	constructor(now: () => number = () => Date.now(), limit = 5, baseDelayMs = 30_000, maxDelayMs = 5 * 60_000) {
		this.now = now;
		this.limit = limit;
		this.baseDelayMs = baseDelayMs;
		this.maxDelayMs = maxDelayMs;
	}

	/** The release for this attempt, or undefined while blocked or another verification is in flight. */
	acquire(): (() => void) | undefined {
		if (this.verifying || this.retryAfterMs() > 0) return undefined;
		this.verifying = true;
		return () => {
			this.verifying = false;
		};
	}

	retryAfterMs(): number {
		return Math.max(0, this.blockedUntil - this.now());
	}

	/** One failed attempt: from the limit on, the block doubles per failure up to the cap. */
	failed(): void {
		this.failures += 1;
		if (this.failures < this.limit) return;
		const delay = Math.min(this.baseDelayMs * 2 ** (this.failures - this.limit), this.maxDelayMs);
		this.blockedUntil = this.now() + delay;
	}

	succeeded(): void {
		this.failures = 0;
		this.blockedUntil = 0;
	}
}
