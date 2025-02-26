/** @import { TemplateNode, Dom, Effect } from '#client' */
import { EFFECT_TRANSPARENT } from '../../constants.js';
import { block, branch, pause_effect } from '../../reactivity/effects.js';
import { active_fork } from '../../reactivity/forks.js';
import { hydrate_next, hydrate_node, hydrating } from '../hydration.js';
import { create_text, should_defer_append } from '../operations.js';

/**
 * @template P
 * @template {(props: P) => void} C
 * @param {TemplateNode} node
 * @param {() => C} get_component
 * @param {(anchor: TemplateNode, component: C) => Dom | void} render_fn
 * @returns {void}
 */
export function component(node, get_component, render_fn) {
	if (hydrating) {
		hydrate_next();
	}

	var anchor = node;

	/** @type {C} */
	var component;

	/** @type {Effect | null} */
	var effect;

	/** @type {DocumentFragment | null} */
	var offscreen_fragment = null;

	/** @type {Effect | null} */
	var pending_effect = null;

	function commit() {
		if (effect) {
			pause_effect(effect);
			effect = null;
		}

		if (offscreen_fragment) {
			anchor.before(offscreen_fragment);
			offscreen_fragment = null;
		}

		effect = pending_effect;
		pending_effect = null;
	}

	block(() => {
		if (component === (component = get_component())) return;

		var defer = active_fork !== null && should_defer_append();

		if (component) {
			var target = anchor;

			if (defer) {
				offscreen_fragment = document.createDocumentFragment();
				offscreen_fragment.append((target = create_text()));
			}

			pending_effect = branch(() => render_fn(target, component));

			if (defer) {
				target.remove();
			}
		}

		if (defer) {
			active_fork?.add_callback(commit);
		} else {
			commit();
		}
	}, EFFECT_TRANSPARENT);

	if (hydrating) {
		anchor = hydrate_node;
	}
}
