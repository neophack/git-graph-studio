// The `stream` builtin for the extension host frame: Readable, Writable, Duplex, Transform
// and PassThrough with the behaviour packages actually lean on — `push`/`data`/`end`
// flowing reads, `pipe`, `write`/`end`/`finish` with the `_write` callback protocol,
// `_transform`/`_flush`, object mode, async iteration, `Readable.from`, `finished` and
// `pipeline`. Before this the module answered empty classes, so a JSON-RPC reader piping a
// child's stdout through a Transform failed with `pipe is not a function` deep inside the
// package. Backpressure is not modelled (every `write` reports it may continue): a frame
// has no sockets whose buffers could overrun.

type Listener = (...args: unknown[]) => unknown;

/** The EventEmitter shape the streams extend (the frame's `events` class is passed in, so
 *  `stream instanceof require('events')` holds exactly as in Node). */
export interface EmitterBase {
	new (): {
		on(event: string, listener: Listener): unknown;
		addListener(event: string, listener: Listener): unknown;
		once(event: string, listener: Listener): unknown;
		emit(event: string, ...args: unknown[]): boolean;
		removeListener(event: string, listener: Listener): unknown;
		listenerCount(event: string): number;
	};
}

type Callback = (error?: Error | null) => void;

interface StreamOptions {
	objectMode?: boolean;
	readableObjectMode?: boolean;
	writableObjectMode?: boolean;
	encoding?: string;
	read?: (this: unknown, size?: number) => void;
	write?: (this: unknown, chunk: unknown, encoding: string, callback: Callback) => void;
	writev?: unknown;
	final?: (this: unknown, callback: Callback) => void;
	transform?: (this: unknown, chunk: unknown, encoding: string, callback: (error?: Error | null, data?: unknown) => void) => void;
	flush?: (this: unknown, callback: (error?: Error | null, data?: unknown) => void) => void;
	destroy?: (this: unknown, error: Error | null, callback: Callback) => void;
	highWaterMark?: number;
}

export function makeStreamModule(Emitter: EmitterBase, toText: (chunk: unknown, encoding?: string) => string): Record<string, unknown> {
	const tick = (fn: () => void) => void Promise.resolve().then(fn);

	/** The readable half, shared by Readable / Duplex / Transform. */
	class Readable extends (Emitter as unknown as new () => InstanceType<EmitterBase>) {
		readable = true;
		readableEnded = false;
		destroyed = false;
		readableObjectMode: boolean;
		protected readonly queue: unknown[] = [];
		protected ended = false;
		protected flowing: boolean | null = null;
		protected encoding: string | undefined;
		private readonly readImpl: ((size?: number) => void) | undefined;
		private reading = false;

		constructor(options: StreamOptions = {}) {
			super();
			this.readableObjectMode = Boolean(options.objectMode ?? options.readableObjectMode);
			this.encoding = options.encoding;
			this.readImpl = options.read?.bind(this);
			if (options.destroy) this._destroy = options.destroy.bind(this) as never;
		}

		_read(_size?: number): void {
			this.readImpl?.(_size);
		}

		push(chunk: unknown): boolean {
			if (chunk === null) {
				this.ended = true;
				this.drain();
				return false;
			}
			this.queue.push(chunk);
			this.drain();
			return true;
		}

		unshift(chunk: unknown): void {
			this.queue.unshift(chunk);
		}

		setEncoding(encoding: string): this {
			this.encoding = encoding;
			return this;
		}

		read(): unknown {
			if (this.queue.length === 0) {
				this.pull();
				return null;
			}
			return this.decode(this.queue.shift());
		}

		/** The emitter's `on` delegates here (and `once` for `data` routes here too below). */
		addListener(event: string, listener: Listener): this {
			(super.addListener as (event: string, listener: Listener) => unknown).call(this, event, listener);
			this.noteListener(event);
			return this;
		}

		once(event: string, listener: Listener): this {
			super.once(event, listener);
			this.noteListener(event);
			return this;
		}

		/** Node's rule: attaching `data` switches a stream into flowing mode (unless it was
		 *  explicitly paused); `readable` starts the pull loop. */
		private noteListener(event: string): void {
			if (event === 'data' && this.flowing !== false) this.resume();
			if (event === 'readable') tick(() => this.pull());
		}

		pause(): this {
			this.flowing = false;
			return this;
		}

		resume(): this {
			this.flowing = true;
			tick(() => {
				this.drain();
				this.pull();
			});
			return this;
		}

		isPaused(): boolean {
			return this.flowing === false;
		}

		pipe<T extends { write(chunk: unknown): unknown; end(): unknown; emit?(event: string, ...args: unknown[]): unknown }>(destination: T, options?: { end?: boolean }): T {
			this.on('data', (chunk) => void destination.write(chunk));
			if (options?.end !== false) this.once('end', () => void destination.end());
			destination.emit?.('pipe', this);
			return destination;
		}

		unpipe(): this {
			return this;
		}

		destroy(error?: Error | null): this {
			if (this.destroyed) return this;
			this.destroyed = true;
			this._destroy(error ?? null, (finalError) => {
				if (finalError) this.emit('error', finalError);
				this.emit('close');
			});
			return this;
		}

		_destroy(error: Error | null, callback: Callback): void {
			callback(error);
		}

		async *[Symbol.asyncIterator](): AsyncGenerator<unknown> {
			const pending: unknown[] = [];
			let done = false;
			let failure: unknown = null;
			let wake: (() => void) | null = null;
			const notify = () => {
				wake?.();
				wake = null;
			};
			this.on('data', (chunk) => {
				pending.push(chunk);
				notify();
			});
			this.once('end', () => {
				done = true;
				notify();
			});
			this.once('error', (error) => {
				failure = error;
				notify();
			});
			while (true) {
				if (pending.length > 0) {
					yield pending.shift();
					continue;
				}
				if (failure !== null) throw failure;
				if (done) return;
				await new Promise<void>((resolve) => (wake = resolve));
			}
		}

		static from(iterable: Iterable<unknown> | AsyncIterable<unknown>, options: StreamOptions = {}): Readable {
			const stream = new Readable({ objectMode: true, ...options });
			tick(async () => {
				try {
					for await (const item of iterable as AsyncIterable<unknown>) stream.push(item);
					stream.push(null);
				} catch (error) {
					stream.destroy(error as Error);
				}
			});
			return stream;
		}

		private decode(chunk: unknown): unknown {
			if (this.encoding !== undefined && !this.readableObjectMode && typeof chunk !== 'string') return toText(chunk, this.encoding);
			return chunk;
		}

		/** Deliver queued chunks to `data` listeners while flowing, then `end` once. */
		protected drain(): void {
			if (this.flowing === true) {
				while (this.queue.length > 0 && this.flowing === true) this.emit('data', this.decode(this.queue.shift()));
			} else if (this.queue.length > 0 && this.listenerCount('readable') > 0) {
				this.emit('readable');
			}
			if (this.ended && this.queue.length === 0 && !this.readableEnded) {
				this.readableEnded = true;
				this.readable = false;
				tick(() => this.emit('end'));
			}
		}

		/** Ask the implementation for more (at most one `_read` in flight per tick). */
		private pull(): void {
			if (this.ended || this.reading || this.destroyed) return;
			this.reading = true;
			tick(() => {
				this.reading = false;
				if (!this.ended) this._read();
			});
		}
	}

	/** The writable half, mixed into Writable / Duplex / Transform. */
	const writableMethods = {
		write(this: WritableState, chunk: unknown, encoding?: string | Callback, callback?: Callback): boolean {
			const done = typeof encoding === 'function' ? encoding : callback;
			const enc = typeof encoding === 'string' ? encoding : 'utf8';
			if (this.writableEnded) {
				const error = new Error('write after end');
				tick(() => (done ? done(error) : this.emit('error', error)));
				return false;
			}
			this.pendingWrites += 1;
			this.writeImpl(chunk, enc, (error) => {
				this.pendingWrites -= 1;
				if (error) this.emit('error', error);
				done?.(error ?? null);
				if (this.pendingWrites === 0) this.emit('drain');
				if (this.writableEnded && this.pendingWrites === 0) this.finishOnce();
			});
			return true;
		},
		end(this: WritableState, chunk?: unknown, encoding?: string | Callback, callback?: Callback): unknown {
			const done = typeof chunk === 'function' ? (chunk as Callback) : typeof encoding === 'function' ? encoding : callback;
			if (chunk !== undefined && chunk !== null && typeof chunk !== 'function') this.write(chunk, typeof encoding === 'string' ? encoding : undefined);
			if (done) this.once('finish', done as Listener);
			this.writableEnded = true;
			if (this.pendingWrites === 0) this.finishOnce();
			return this;
		},
		cork(): void {},
		uncork(): void {},
		setDefaultEncoding(this: WritableState): unknown {
			return this;
		}
	};

	interface WritableState {
		writableEnded: boolean;
		writableFinished: boolean;
		pendingWrites: number;
		writeImpl: (chunk: unknown, encoding: string, callback: Callback) => void;
		finalImpl: (callback: Callback) => void;
		finishOnce(): void;
		write(chunk: unknown, encoding?: string | Callback, callback?: Callback): boolean;
		emit(event: string, ...args: unknown[]): boolean;
		once(event: string, listener: Listener): unknown;
	}

	function installWritable(target: WritableState, options: StreamOptions, write: (chunk: unknown, encoding: string, callback: Callback) => void, final: (callback: Callback) => void): void {
		target.writableEnded = false;
		target.writableFinished = false;
		target.pendingWrites = 0;
		target.writeImpl = options.write ? options.write.bind(target) : write;
		target.finalImpl = options.final ? options.final.bind(target) : final;
		let finishing = false;
		target.finishOnce = () => {
			if (finishing) return;
			finishing = true;
			target.finalImpl((error) => {
				if (error) {
					target.emit('error', error);
					return;
				}
				target.writableFinished = true;
				tick(() => {
					target.emit('finish');
					target.emit('close');
				});
			});
		};
	}

	class Writable extends (Emitter as unknown as new () => InstanceType<EmitterBase>) {
		writable = true;
		destroyed = false;
		constructor(options: StreamOptions = {}) {
			super();
			installWritable(this as unknown as WritableState, options, (chunk, encoding, callback) => this._write(chunk, encoding, callback), (callback) => this._final(callback));
		}
		_write(_chunk: unknown, _encoding: string, callback: Callback): void {
			callback();
		}
		_final(callback: Callback): void {
			callback();
		}
		destroy(error?: Error | null): this {
			if (this.destroyed) return this;
			this.destroyed = true;
			tick(() => {
				if (error) this.emit('error', error);
				this.emit('close');
			});
			return this;
		}
	}
	Object.assign(Writable.prototype, writableMethods);

	class Duplex extends Readable {
		writable = true;
		constructor(options: StreamOptions = {}) {
			super(options);
			installWritable(this as unknown as WritableState, options, (chunk, encoding, callback) => this._write(chunk, encoding, callback), (callback) => this._final(callback));
		}
		_write(_chunk: unknown, _encoding: string, callback: Callback): void {
			callback();
		}
		_final(callback: Callback): void {
			callback();
		}
	}
	Object.assign(Duplex.prototype, writableMethods);

	class Transform extends Duplex {
		private readonly transformImpl: StreamOptions['transform'];
		private readonly flushImpl: StreamOptions['flush'];
		constructor(options: StreamOptions = {}) {
			super(options);
			this.transformImpl = options.transform?.bind(this);
			this.flushImpl = options.flush?.bind(this);
		}
		_transform(chunk: unknown, encoding: string, callback: (error?: Error | null, data?: unknown) => void): void {
			if (this.transformImpl) this.transformImpl(chunk, encoding, callback);
			else callback(null, chunk);
		}
		_flush(callback: (error?: Error | null, data?: unknown) => void): void {
			if (this.flushImpl) this.flushImpl(callback);
			else callback();
		}
		_write(chunk: unknown, encoding: string, callback: Callback): void {
			this._transform(chunk, encoding, (error, data) => {
				if (data !== undefined && data !== null) this.push(data);
				callback(error ?? null);
			});
		}
		_final(callback: Callback): void {
			this._flush((error, data) => {
				if (data !== undefined && data !== null) this.push(data);
				this.push(null);
				callback(error ?? null);
			});
		}
	}

	class PassThrough extends Transform {}

	/** `finished(stream, callback)`: the stream ended, finished or failed — once. */
	function finished(stream: { once(event: string, listener: Listener): unknown }, callback: (error?: unknown) => void): () => void {
		let called = false;
		const done = (error?: unknown) => {
			if (called) return;
			called = true;
			callback(error);
		};
		stream.once('end', () => done());
		stream.once('finish', () => done());
		stream.once('error', (error) => done(error));
		return () => undefined;
	}

	/** `pipeline(a, b, …, callback)`: pipe each into the next, one completion callback. */
	function pipeline(...streams: unknown[]): unknown {
		const callback = typeof streams[streams.length - 1] === 'function' ? (streams.pop() as (error?: unknown) => void) : undefined;
		const list = streams as Readable[];
		for (let at = 0; at < list.length - 1; at++) list[at]!.pipe(list[at + 1] as never);
		const last = list[list.length - 1]!;
		let failed = false;
		for (const stream of list) {
			stream.once('error', (error) => {
				if (failed) return;
				failed = true;
				callback?.(error);
			});
		}
		finished(last, (error) => {
			if (!failed) callback?.(error);
		});
		return last;
	}

	const promises = {
		finished: (stream: Readable) => new Promise<void>((resolve, reject) => finished(stream, (error) => (error ? reject(error) : resolve()))),
		pipeline: (...streams: unknown[]) => new Promise<void>((resolve, reject) => pipeline(...streams, (error?: unknown) => (error ? reject(error) : resolve())))
	};

	const Stream = Readable;
	return { Stream, Readable, Writable, Duplex, Transform, PassThrough, finished, pipeline, promises };
}
