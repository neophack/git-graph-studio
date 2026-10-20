// The page-stack shells' horizontal pager (the owner's 2026-10-18 direction: 手机远程时
// 浏览器手势会导致页面退出 — a phone browser's back gesture left the workbench, and the old
// left-edge swipe-back raced it): a horizontal drag anywhere in the page column now switches
// the bottom navigation's destinations — a leftward swipe goes to the next destination, a
// rightward one to the previous — with the page following the finger (translate + an edge
// glow, rubber-banded where the ring has no neighbour) and a two-phase commit: the page
// slides out in the swipe direction, the destination's page slides in from the other side.
// The bezel keeps its native meaning — back — and backStack's stay guard (same change)
// turns that back into the in-app back instead of an exit, so the two vocabularies never
// fight: the system owns back, the content owns the ring.
//
// The claim follows swipeReveal's axis-lock recipe (platform/ui/swipe.ts): the first
// decisive move picks the axis, a vertical drag stays the browser's scroll, and a row that
// can reveal its actions, a horizontally scrollable strip (an editor's wide content, a
// terminal), a surface that declares its own gestures (`data-owns-gestures` — the image
// viewer's pinch, pan and gallery swipe) or a range-like control owns its own drag. Everything binds on #workbench —
// the bars and every overlay live outside it, so nothing else needs excluding.
import { bottomTabs, type BottomTab } from './bottomTabs';
import { drawerPages } from './navDrawer';
import { currentDeviceClass } from './responsive';
import { currentPage, goTo } from './pages';
import { phoneShell } from './nav';

/** The drag that becomes a swipe (below it, a drifting tap stays a tap). */
const CLAIM_PX = 12;
/** The least travel that commits at lift (and the page's own scaled floor). */
const COMMIT_PX = 64;
/** A fast fling commits without the distance (px/ms toward the swipe direction). */
const FLING_PX_PER_MS = 0.55;
/** The velocity is read over this trailing window: a finger that rested before lifting
 *  carries no fling, whatever its last move sample said (the recognizers' own rule). */
const VELOCITY_WINDOW_MS = 90;
/** The rubber band's far end where the ring has no neighbour. */
const BAND_PX = 96;
/** The commit's two phases (ms); reduced motion collapses both to a jump. */
const EXIT_MS = 130;
const ENTER_MS = 190;
/** A click within this window after a claimed drag is the drag's own, not a tap — the
 *  commit's two phases run ~320 ms, a beat past that, and nothing more: a tap on the
 *  destination page is the user's, not the swipe's echo. */
const CLICK_SWALLOW_MS = 400;

function reducedMotion(): boolean {
	return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** A target the pager must not claim: the swipe-reveal row's own drag, a range-like
 *  control, a surface that owns its gestures, or anything inside a horizontally
 *  scrollable strip. */
function claimsTarget(target: EventTarget | null): boolean {
	let node: Element | null = target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
	if (node?.closest('.ggs-swipe-row, .ggs-swipe-actions, input[type="range"], [role="slider"], [data-owns-gestures]')) return false;
	for (; node; node = node.parentElement) {
		// A wider child scrolls sideways on its own; the workbench column itself never does.
		if (node.scrollWidth > node.clientWidth + 4) return false;
		if (node.id === 'workbench') break;
	}
	return true;
}

/** The destinations the swipe ring walks: the same list the form's visible navigation
 *  shows — the portrait tablet's rail carries the drawer's uncapped set (search sits
 *  between editor and scm there), every other form walks the bottom bar's five. */
const ringTabs = (): BottomTab[] => (currentDeviceClass() === 'tablet-portrait' ? drawerPages() : bottomTabs()) as BottomTab[];

/** Where the page showing sits in the bar's ring. A destination the bar does not hold (a
 *  drawer page such as Extensions, opened over the ring) sits past its end: a rightward
 *  swipe returns to the last destination, a leftward one rubber-bands — the ring goes on
 *  beneath whatever the drawer opened. */
export function ringPosition(tabs: BottomTab[], page = currentPage()): number {
	const index = tabs.findIndex((tab) => tab.id === page);
	return index === -1 ? tabs.length : index;
}

/** Bind the pager to the page column. Idempotent per element (a rebuilt workbench — a
 *  test — gets a fresh binding); the gesture itself gates on the page-stack markers, so
 *  the same binding serves every form the viewport settles into. */
export function installSwipeNav(workbench: HTMLElement): void {
	if (bound.has(workbench)) return;
	bound.add(workbench);

	// The ring is read once per gesture, at the claim: the page showing does not change
	// under a finger.
	let tabs: BottomTab[] = [];
	let position = 0;
	let pointerId: number | null = null;
	let start: { x: number; y: number } | null = null;
	let tracking = false;
	let claimed = false;
	let dx = 0;
	let follow = 0;
	let lastX = 0;
	let lastT = 0;
	let velocity = 0;
	let liftedAt = 0;
	let busy = false;

	const width = (): number => workbench.clientWidth || (typeof window === 'undefined' ? 390 : window.innerWidth);
	const neighbour = (direction: 1 | -1): BottomTab | undefined => tabs[position + direction];
	const setSwipe = (px: number, left: number, right: number): void => {
		const whole = Math.round(px);
		workbench.style.setProperty('--ggs-swipe-x', `${whole}px`);
		workbench.style.setProperty('--ggs-swipe-pl', left.toFixed(3));
		workbench.style.setProperty('--ggs-swipe-pr', right.toFixed(3));
		workbench.style.transform = whole === 0 ? '' : `translateX(${whole}px)`;
	};
	const settle = (): void => {
		setSwipe(0, 0, 0);
		workbench.style.transition = '';
		workbench.classList.remove('ggs-swipe-drag', 'ggs-swipe-anim');
	};
	/** The rubber band: a neighbour follows the finger, the ring's ends resist. */
	const followOf = (movedX: number, hasNeighbour: boolean): number => {
		if (hasNeighbour) return Math.max(-width() * 0.6, Math.min(width() * 0.6, movedX));
		const sign = movedX < 0 ? -1 : 1;
		return sign * BAND_PX * (1 - Math.exp(-Math.abs(movedX) / 160));
	};

	const down = (event: Event): void => {
		const e = event as PointerEvent;
		liftedAt = 0;
		if (busy || !e.isPrimary || (e.pointerType !== 'touch' && e.pointerType !== 'pen')) return;
		if (!phoneShell() || document.documentElement.hasAttribute('data-keyboard')) return;
		if (!claimsTarget(e.target)) return;
		pointerId = e.pointerId;
		tracking = true;
		claimed = false;
		dx = 0;
		follow = 0;
		velocity = 0;
		lastX = e.clientX;
		lastT = event.timeStamp;
		start = { x: e.clientX, y: e.clientY };
	};
	const move = (event: Event): void => {
		// Only the claiming finger drags: a second finger's moves must not teleport the
		// page (its offset is no drag's), and its lift must not commit.
		if (!tracking || (event as PointerEvent).pointerId !== pointerId) return;
		const e = event as PointerEvent;
		if (!start) return;
		dx = e.clientX - start.x;
		if (!claimed) {
			const dy = e.clientY - start.y;
			if (Math.abs(dx) < CLAIM_PX && Math.abs(dy) < CLAIM_PX) return;
			// The first decisive move picks the axis: a vertical drag is the browser's scroll.
			if (Math.abs(dx) <= Math.abs(dy)) {
				tracking = false;
				start = null;
				return;
			}
			tabs = ringTabs();
			position = ringPosition(tabs);
			claimed = true;
			// A settle still animating from the previous gesture must not bleed its
			// transitions into this drag.
			workbench.classList.remove('ggs-swipe-anim');
			workbench.classList.add('ggs-swipe-drag');
			workbench.style.transition = 'none';
		}
		// Claimed: the drag is the pager's. The events stop here so a row underneath never
		// also reveals its actions (the capture pass runs before the row's own listeners).
		event.stopPropagation();
		if (e.timeStamp > lastT)
			// The trailing speed, smoothed — one noisy sample must not fling the page.
			velocity = velocity * 0.7 + ((e.clientX - lastX) / (e.timeStamp - lastT)) * 0.3;
		lastX = e.clientX;
		lastT = e.timeStamp;
		const direction: 1 | -1 = dx < 0 ? 1 : -1;
		follow = followOf(dx, Boolean(neighbour(direction)));
		setSwipe(follow, direction < 0 ? Math.min(1, Math.abs(follow) / COMMIT_PX) : 0, direction > 0 ? Math.min(1, Math.abs(follow) / COMMIT_PX) : 0);
	};
	const snapBack = (): void => {
		const ms = reducedMotion() ? 0 : ENTER_MS;
		workbench.style.transition = ms > 0 ? `transform ${ms}ms var(--ggs-ease)` : '';
		setSwipe(0, 0, 0);
		workbench.classList.add('ggs-swipe-anim');
		window.setTimeout(() => {
			// A new gesture that is tracking but has not claimed (a tap) never touches the
			// styles: the settle must run for it too, or the anim class and the inline
			// transition outlive the animation until some claimed drag clears them.
			if (!tracking || !claimed) settle();
		}, ms);
	};
	const commit = (direction: 1 | -1): void => {
		busy = true;
		const target = neighbour(direction);
		const exitMs = reducedMotion() ? 0 : EXIT_MS;
		const enterMs = reducedMotion() ? 0 : ENTER_MS;
		workbench.style.transition = exitMs > 0 ? `transform ${exitMs}ms cubic-bezier(.4, 0, 1, 1)` : '';
		// Phase one: the page leaves in the swipe direction.
		setSwipe(direction * -width() * 0.28, direction < 0 ? 1 : 0, direction > 0 ? 1 : 0);
		workbench.classList.add('ggs-swipe-anim');
		window.setTimeout(() => {
			// Phase two: the destination takes over from the far side — the DOM swap happens
			// under the translation, and the forced reflow makes the enter a transition,
			// never a jump.
			workbench.style.transition = 'none';
			setSwipe(direction * width() * 0.28, direction < 0 ? 1 : 0, direction > 0 ? 1 : 0);
			void workbench.offsetHeight;
			void goTo(target ? target.id : 'editor')
				.catch(() => undefined)
				.then(() => {
					workbench.style.transition = enterMs > 0 ? `transform ${enterMs}ms var(--ggs-ease)` : '';
					setSwipe(0, 0, 0);
					window.setTimeout(() => {
						busy = false;
						settle();
					}, enterMs);
				});
		}, exitMs);
	};
	const lift = (event: Event, cancelled: boolean): void => {
		if (!tracking || (event as PointerEvent).pointerId !== pointerId) return;
		const wasClaimed = claimed;
		tracking = false;
		pointerId = null;
		start = null;
		claimed = false;
		if (!wasClaimed) return;
		liftedAt = event.timeStamp;
		const direction: 1 | -1 = dx < 0 ? 1 : -1;
		// The browser took the gesture over (a scroll it claimed): the page returns, never
		// commits on a cancel. A fling commits by speed alone — the velocity's sign is the
		// swipe's own (dx<0 ↔ direction 1), so the product against −direction is positive
		// only while the finger still travels the way it started, and a finger that rested
		// before lifting carries no fling at all.
		if (event.timeStamp - lastT > VELOCITY_WINDOW_MS) velocity = 0;
		const committed = !cancelled && Boolean(neighbour(direction)) && (Math.abs(follow) >= Math.max(COMMIT_PX, width() * 0.14) || -velocity * direction > FLING_PX_PER_MS);
		if (committed) commit(direction);
		else snapBack();
	};

	workbench.addEventListener('pointerdown', down);
	workbench.addEventListener('pointermove', move, true);
	workbench.addEventListener('pointerup', (event) => lift(event, false), true);
	workbench.addEventListener('pointercancel', (event) => lift(event, true), true);
	// The click that ends a claimed drag is not the row's own tap-to-open.
	workbench.addEventListener(
		'click',
		(event) => {
			if (liftedAt && event.timeStamp - liftedAt < CLICK_SWALLOW_MS) {
				event.preventDefault();
				event.stopPropagation();
				liftedAt = 0;
			}
		},
		true
	);
}

const bound = new WeakSet<HTMLElement>();
