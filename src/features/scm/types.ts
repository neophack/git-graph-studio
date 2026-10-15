// The Source Control module's public types: shapes other modules consume without importing
// the view implementation (plan §5.3/5.4).

/** One line's last change, as `scm_blame` reports it. */
export interface BlameLine {
	hash: string;
	author: string;
	/** Seconds since the epoch. */
	time: number;
	summary: string;
}
