// The position/range value types VS Code's API is built from: Position, Range,
// Location and Selection (with its base class).

import type { Uri } from './uri';

/* ---------- The small value types VS Code's API is built from ---------- */

function isPositionLike(value: unknown): value is { line: number; character: number } {
	return value !== null && typeof value === 'object' && typeof (value as { line?: unknown }).line === 'number' && typeof (value as { character?: unknown }).character === 'number';
}

export class Position {
	readonly line: number;
	readonly character: number;
	constructor(line: number, character: number) {
		if (!(line >= 0) || !(character >= 0)) throw new Error(`Illegal argument: Position(${line}, ${character}) must be non-negative`);
		this.line = line;
		this.character = character;
	}
	static isPosition(value: unknown): value is Position {
		return value instanceof Position || isPositionLike(value);
	}
	/** A plain `{ line, character }` (a Position that crossed a bridge) as a real one. */
	static of(value: { line: number; character: number }): Position {
		return value instanceof Position ? value : new Position(value.line, value.character);
	}
	compareTo(other: { line: number; character: number }): number {
		return this.line !== other.line ? this.line - other.line : this.character - other.character;
	}
	isBefore(other: { line: number; character: number }): boolean {
		return this.compareTo(other) < 0;
	}
	isBeforeOrEqual(other: { line: number; character: number }): boolean {
		return this.compareTo(other) <= 0;
	}
	isAfter(other: { line: number; character: number }): boolean {
		return this.compareTo(other) > 0;
	}
	isAfterOrEqual(other: { line: number; character: number }): boolean {
		return this.compareTo(other) >= 0;
	}
	isEqual(other: { line: number; character: number }): boolean {
		return this.compareTo(other) === 0;
	}
	translate(lineDelta: number | { lineDelta?: number; characterDelta?: number } = 0, characterDelta = 0): Position {
		if (typeof lineDelta === 'object') return new Position(this.line + (lineDelta.lineDelta ?? 0), this.character + (lineDelta.characterDelta ?? 0));
		return new Position(this.line + lineDelta, this.character + characterDelta);
	}
	with(line: number | { line?: number; character?: number } = this.line, character = this.character): Position {
		if (typeof line === 'object') return new Position(line.line ?? this.line, line.character ?? this.character);
		return new Position(line, character);
	}
}

export class Range {
	readonly start: Position;
	readonly end: Position;
	/** `new Range(start, end)` or `new Range(startLine, startCharacter, endLine, endCharacter)`
	 *  — both of VS Code's spellings; the ends are ordered (start never after end). */
	constructor(startLine: number | { line: number; character: number }, startCharacter: number | { line: number; character: number }, endLine?: number, endCharacter?: number) {
		let start: Position;
		let end: Position;
		if (typeof startLine === 'number' && typeof startCharacter === 'number' && typeof endLine === 'number' && typeof endCharacter === 'number') {
			start = new Position(startLine, startCharacter);
			end = new Position(endLine, endCharacter);
		} else if (isPositionLike(startLine) && isPositionLike(startCharacter)) {
			start = Position.of(startLine);
			end = Position.of(startCharacter);
		} else {
			throw new Error('Illegal argument: Range takes (Position, Position) or (line, character, line, character)');
		}
		if (start.isAfter(end)) [start, end] = [end, start];
		this.start = start;
		this.end = end;
	}
	static isRange(value: unknown): value is Range {
		return value instanceof Range || (value !== null && typeof value === 'object' && isPositionLike((value as Range).start) && isPositionLike((value as Range).end));
	}
	get isEmpty(): boolean {
		return this.start.isEqual(this.end);
	}
	get isSingleLine(): boolean {
		return this.start.line === this.end.line;
	}
	contains(positionOrRange: { line: number; character: number } | { start: { line: number; character: number }; end: { line: number; character: number } }): boolean {
		if (isPositionLike(positionOrRange)) return this.start.isBeforeOrEqual(positionOrRange) && this.end.isAfterOrEqual(positionOrRange);
		return this.contains(positionOrRange.start) && this.contains(positionOrRange.end);
	}
	isEqual(other: { start: { line: number; character: number }; end: { line: number; character: number } }): boolean {
		return this.start.isEqual(other.start) && this.end.isEqual(other.end);
	}
	intersection(other: { start: { line: number; character: number }; end: { line: number; character: number } }): Range | undefined {
		const start = this.start.isAfter(other.start) ? this.start : Position.of(other.start);
		const end = this.end.isBefore(other.end) ? this.end : Position.of(other.end);
		return start.isAfter(end) ? undefined : new Range(start, end);
	}
	union(other: { start: { line: number; character: number }; end: { line: number; character: number } }): Range {
		const start = this.start.isBefore(other.start) ? this.start : Position.of(other.start);
		const end = this.end.isAfter(other.end) ? this.end : Position.of(other.end);
		return new Range(start, end);
	}
	with(start: { line: number; character: number } | { start?: { line: number; character: number }; end?: { line: number; character: number } } = this.start, end: { line: number; character: number } = this.end): Range {
		if (!isPositionLike(start)) return new Range((start as { start?: Position }).start ?? this.start, (start as { end?: Position }).end ?? this.end);
		return new Range(start, end);
	}
}

export class Location {
	readonly range: Range;
	constructor(readonly uri: Uri, rangeOrPosition: Range | Position) {
		this.range = rangeOrPosition instanceof Range ? rangeOrPosition : new Range(rangeOrPosition, rangeOrPosition);
	}
}

export class Selection extends Range {
	readonly anchor: Position;
	readonly active: Position;
	/** `(anchor, active)` or `(anchorLine, anchorCharacter, activeLine, activeCharacter)`. */
	constructor(anchorLine: number | { line: number; character: number }, anchorCharacter: number | { line: number; character: number }, activeLine?: number, activeCharacter?: number) {
		const anchor = typeof anchorLine === 'number' ? new Position(anchorLine, anchorCharacter as number) : Position.of(anchorLine);
		const active = typeof anchorLine === 'number' ? new Position(activeLine ?? 0, activeCharacter ?? 0) : Position.of(anchorCharacter as { line: number; character: number });
		super(anchor, active);
		this.anchor = anchor;
		this.active = active;
	}
	get isReversed(): boolean {
		return this.anchor.compareTo(this.active) > 0;
	}
}
