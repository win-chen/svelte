/** @import { Effect, TemplateNode, } from '#client' */

import { BOUNDARY_EFFECT, EFFECT_TRANSPARENT } from '../../constants.js';
import {
	block,
	branch,
	destroy_effect,
	pause_effect,
	resume_effect
} from '../../reactivity/effects.js';
import {
	active_effect,
	active_reaction,
	component_context,
	handle_error,
	set_active_effect,
	set_active_reaction,
	set_component_context,
	reset_is_throwing_error
} from '../../runtime.js';
import {
	hydrate_next,
	hydrate_node,
	hydrating,
	next,
	remove_nodes,
	set_hydrate_node
} from '../hydration.js';
import { get_next_sibling } from '../operations.js';
import { queue_boundary_micro_task } from '../task.js';
import * as e from '../../../shared/errors.js';

const ASYNC_INCREMENT = Symbol();
const ASYNC_DECREMENT = Symbol();

/**
 * @param {Effect} boundary
 * @param {() => void} fn
 */
function with_boundary(boundary, fn) {
	var previous_effect = active_effect;
	var previous_reaction = active_reaction;
	var previous_ctx = component_context;

	set_active_effect(boundary);
	set_active_reaction(boundary);
	set_component_context(boundary.ctx);

	try {
		fn();
	} finally {
		set_active_effect(previous_effect);
		set_active_reaction(previous_reaction);
		set_component_context(previous_ctx);
	}
}

/**
 * @param {TemplateNode} node
 * @param {{
 * 	 onerror?: (error: unknown, reset: () => void) => void,
 *   failed?: (anchor: Node, error: () => unknown, reset: () => () => void) => void
 *   pending?: (anchor: Node) => void
 * }} props
 * @param {((anchor: Node) => void)} children
 * @returns {void}
 */
export function boundary(node, props, children) {
	var anchor = node;

	block(() => {
		/** @type {Effect} */
		var boundary_effect;

		/** @type {Effect | null} */
		var offscreen_effect = null;

		/** @type {DocumentFragment | null} */
		var offscreen_fragment = null;

		var async_count = 0;
		var boundary = /** @type {Effect} */ (active_effect);
		var hydrate_open = hydrate_node;
		var is_creating_fallback = false;

		/**
		 * @param {() => void} snippet_fn
		 */
		function render_snippet(snippet_fn) {
			with_boundary(boundary, () => {
				is_creating_fallback = true;

				try {
					boundary_effect = branch(snippet_fn);
				} catch (error) {
					handle_error(error, boundary, null, boundary.ctx);
				}

				reset_is_throwing_error();
				is_creating_fallback = false;
			});
		}

		function suspend() {
			if (offscreen_effect || !boundary_effect) {
				return;
			}

			var effect = boundary_effect;
			offscreen_effect = boundary_effect;

			pause_effect(
				boundary_effect,
				() => {
					var node = effect.nodes_start;
					var end = effect.nodes_end;

					offscreen_fragment = document.createDocumentFragment();

					while (node !== null) {
						/** @type {TemplateNode | null} */
						var next = node === end ? null : /** @type {TemplateNode} */ (get_next_sibling(node));

						offscreen_fragment.append(node);
						node = next;
					}
				},
				false
			);

			const pending = props.pending;

			if (pending) {
				render_snippet(() => {
					pending(anchor);
				});
			}
		}

		function unsuspend() {
			if (!offscreen_effect) {
				return;
			}

			if (boundary_effect) {
				destroy_effect(boundary_effect);
			}

			boundary_effect = offscreen_effect;
			offscreen_effect = null;
			anchor.before(/** @type {DocumentFragment} */ (offscreen_fragment));
			resume_effect(boundary_effect);
		}

		function reset() {
			pause_effect(boundary_effect);

			with_boundary(boundary, () => {
				is_creating_fallback = false;
				boundary_effect = branch(() => children(anchor));
				reset_is_throwing_error();
			});
		}

		// @ts-ignore We re-use the effect's fn property to avoid allocation of an additional field
		boundary.fn = (/** @type {unknown} */ input) => {
			if (input === ASYNC_INCREMENT) {
				if (async_count++ === 0) {
					queue_boundary_micro_task(suspend);
				}

				return;
			}

			if (input === ASYNC_DECREMENT) {
				if (--async_count === 0) {
					queue_boundary_micro_task(unsuspend);
				}

				return;
			}

			var error = input;
			var onerror = props.onerror;
			let failed = props.failed;

			// If we have nothing to capture the error, or if we hit an error while
			// rendering the fallback, re-throw for another boundary to handle
			if (is_creating_fallback || (!onerror && !failed)) {
				throw error;
			}

			onerror?.(error, reset);

			if (boundary_effect) {
				destroy_effect(boundary_effect);
			} else if (hydrating) {
				set_hydrate_node(hydrate_open);
				next();
				set_hydrate_node(remove_nodes());
			}

			if (failed) {
				queue_boundary_micro_task(() => {
					render_snippet(() => {
						failed(
							anchor,
							() => error,
							() => reset
						);
					});
				});
			}
		};

		// @ts-ignore
		boundary.fn.is_pending = () => props.pending;

		if (hydrating) {
			hydrate_next();
		}

		const pending = props.pending;

		if (hydrating && pending) {
			boundary_effect = branch(() => pending(anchor));

			// ...now what? we need to start rendering `boundary_fn` offscreen,
			// and either insert the resulting fragment (if nothing suspends)
			// or keep the pending effect alive until it unsuspends.
			// not exactly sure how to do that.

			// future work: when we have some form of async SSR, we will
			// need to use hydration boundary comments to report whether
			// the pending or main block was rendered for a given
			// boundary, and hydrate accordingly
			queueMicrotask(() => {
				destroy_effect(boundary_effect);
				with_boundary(boundary, () => {
					boundary_effect = branch(() => children(anchor));
				});
			});
		} else {
			boundary_effect = branch(() => children(anchor));
		}

		reset_is_throwing_error();
	}, EFFECT_TRANSPARENT | BOUNDARY_EFFECT);

	if (hydrating) {
		anchor = hydrate_node;
	}
}

export function capture() {
	var previous_effect = active_effect;
	var previous_reaction = active_reaction;
	var previous_component_context = component_context;

	return function restore() {
		set_active_effect(previous_effect);
		set_active_reaction(previous_reaction);
		set_component_context(previous_component_context);

		// prevent the active effect from outstaying its welcome
		queue_boundary_micro_task(exit);
	};
}

/**
 * @param {Effect} boundary
 */
export function is_pending_boundary(boundary) {
	// @ts-ignore
	return boundary.fn.is_pending();
}

export function suspend() {
	var boundary = active_effect;

	while (boundary !== null) {
		if ((boundary.f & BOUNDARY_EFFECT) !== 0 && is_pending_boundary(boundary)) {
			break;
		}

		boundary = boundary.parent;
	}

	if (boundary === null) {
		e.await_outside_boundary();
	}

	// @ts-ignore
	boundary?.fn(ASYNC_INCREMENT);

	return function unsuspend() {
		// @ts-ignore
		boundary?.fn(ASYNC_DECREMENT);
	};
}

/**
 * @template T
 * @param {Promise<T>} promise
 * @returns {Promise<() => T>}
 */
export async function save(promise) {
	var restore = capture();
	var value = await promise;

	return () => {
		restore();
		return value;
	};
}

function exit() {
	set_active_effect(null);
	set_active_reaction(null);
	set_component_context(null);
}
