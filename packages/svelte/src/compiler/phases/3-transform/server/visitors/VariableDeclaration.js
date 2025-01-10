/** @import { VariableDeclaration, VariableDeclarator, Expression, CallExpression, Pattern, Identifier, ObjectPattern, ArrayPattern, Property } from 'estree' */
/** @import { Binding } from '#compiler' */
/** @import { Context } from '../types.js' */
/** @import { Scope } from '../../../scope.js' */
import { walk } from 'zimmerframe';
import { build_fallback, extract_identifiers, extract_paths } from '../../../../utils/ast.js';
import * as b from '../../../../utils/builders.js';
import { get_rune } from '../../../scope.js';

/**
 * @param {VariableDeclaration} node
 * @param {Context} context
 */
export function VariableDeclaration(node, context) {
	/** @type {VariableDeclarator[]} */
	const declarations = [];

	if (context.state.analysis.runes) {
		/** @type {VariableDeclarator[]} */
		const destructured_reassigns = [];

		for (const declarator of node.declarations) {
			const init = declarator.init;
			const rune = get_rune(init, context.state.scope);
			if (!rune || rune === '$effect.tracking' || rune === '$inspect' || rune === '$effect.root') {
				declarations.push(/** @type {VariableDeclarator} */ (context.visit(declarator)));
				continue;
			}

			if (rune === '$props') {
				let has_rest = false;
				// remove $bindable() from props declaration
				let id = walk(declarator.id, null, {
					RestElement(node, context) {
						if (context.path.at(-1) === declarator.id) {
							has_rest = true;
						}
					},
					AssignmentPattern(node) {
						if (
							node.right.type === 'CallExpression' &&
							get_rune(node.right, context.state.scope) === '$bindable'
						) {
							const right = node.right.arguments.length
								? /** @type {Expression} */ (context.visit(node.right.arguments[0]))
								: b.id('undefined');
							return b.assignment_pattern(node.left, right);
						}
					}
				});
				if (id.type === 'ObjectPattern' && has_rest) {
					// If a rest pattern is used within an object pattern, we need to ensure we don't expose $$slots or $$events
					id.properties.splice(
						id.properties.length - 1,
						0,
						// @ts-ignore
						b.prop('init', b.id('$$slots'), b.id('$$slots')),
						b.prop('init', b.id('$$events'), b.id('$$events'))
					);
				} else if (id.type === 'Identifier') {
					// If $props is referenced as an identifier, we need to ensure we don't expose $$slots or $$events as properties
					// on the identifier reference
					id = b.object_pattern([
						b.prop('init', b.id('$$slots'), b.id('$$slots')),
						b.prop('init', b.id('$$events'), b.id('$$events')),
						b.rest(b.id(id.name))
					]);
				}
				declarations.push(
					b.declarator(/** @type {Pattern} */ (context.visit(id)), b.id('$$props'))
				);
				continue;
			}

			const args = /** @type {CallExpression} */ (init).arguments;
			const value =
				args.length === 0 ? b.id('undefined') : /** @type {Expression} */ (context.visit(args[0]));

			const is_destructuring =
				declarator.id.type === 'ObjectPattern' || declarator.id.type === 'ArrayPattern';

			/**
			 *
			 * @param {()=>Expression} get_generated_init
			 */
			function add_destructured_reassign(get_generated_init) {
				// to keep everything that the user destructure as a function we need to change the original
				// assignment to a generated value and then reassign a variable with the original name
				if (declarator.id.type === 'ObjectPattern' || declarator.id.type === 'ArrayPattern') {
					const id = /** @type {ObjectPattern | ArrayPattern} */ (context.visit(declarator.id));
					const modified = walk(
						/**@type {Identifier|Property}*/ (/**@type {unknown}*/ (id)),
						{},
						{
							Identifier(id, { path }) {
								const parent = path.at(-1);
								// we only want the identifiers for the value
								if (parent?.type === 'Property' && parent.value !== id) return;
								const generated = context.state.scope.generate(id.name);
								destructured_reassigns.push(b.declarator(b.id(id.name), b.thunk(b.id(generated))));
								return b.id(generated);
							}
						}
					);
					declarations.push(b.declarator(/**@type {Pattern}*/ (modified), get_generated_init()));
				}
			}

			if (rune === '$derived.by') {
				if (is_destructuring) {
					add_destructured_reassign(() => b.call(value));
					continue;
				}
				declarations.push(
					b.declarator(/** @type {Pattern} */ (context.visit(declarator.id)), value)
				);
				continue;
			}

			if (declarator.id.type === 'Identifier') {
				if (is_destructuring && rune === '$derived') {
					add_destructured_reassign(() => value);
					continue;
				}
				declarations.push(
					b.declarator(declarator.id, rune === '$derived' ? b.thunk(value) : value)
				);
				continue;
			}

			if (rune === '$derived') {
				if (is_destructuring) {
					add_destructured_reassign(() => value);
					continue;
				}
				declarations.push(
					b.declarator(/** @type {Pattern} */ (context.visit(declarator.id)), b.thunk(value))
				);
				continue;
			}

			declarations.push(...create_state_declarators(declarator, context.state.scope, value));
		}
		declarations.push(...destructured_reassigns);
	} else {
		for (const declarator of node.declarations) {
			const bindings = /** @type {Binding[]} */ (context.state.scope.get_bindings(declarator));
			const has_state = bindings.some((binding) => binding.kind === 'state');
			const has_props = bindings.some((binding) => binding.kind === 'bindable_prop');

			if (!has_state && !has_props) {
				declarations.push(/** @type {VariableDeclarator} */ (context.visit(declarator)));
				continue;
			}

			if (has_props) {
				if (declarator.id.type !== 'Identifier') {
					// Turn export let into props. It's really really weird because export let { x: foo, z: [bar]} = ..
					// means that foo and bar are the props (i.e. the leafs are the prop names), not x and z.
					const tmp = context.state.scope.generate('tmp');
					const paths = extract_paths(declarator.id);
					declarations.push(
						b.declarator(
							b.id(tmp),
							/** @type {Expression} */ (context.visit(/** @type {Expression} */ (declarator.init)))
						)
					);
					for (const path of paths) {
						const value = path.expression?.(b.id(tmp));
						const name = /** @type {Identifier} */ (path.node).name;
						const binding = /** @type {Binding} */ (context.state.scope.get(name));
						const prop = b.member(b.id('$$props'), b.literal(binding.prop_alias ?? name), true);
						declarations.push(b.declarator(path.node, build_fallback(prop, value)));
					}
					continue;
				}

				const binding = /** @type {Binding} */ (context.state.scope.get(declarator.id.name));
				const prop = b.member(
					b.id('$$props'),
					b.literal(binding.prop_alias ?? declarator.id.name),
					true
				);

				/** @type {Expression} */
				let init = prop;
				if (declarator.init) {
					const default_value = /** @type {Expression} */ (context.visit(declarator.init));
					init = build_fallback(prop, default_value);
				}

				declarations.push(b.declarator(declarator.id, init));

				continue;
			}

			declarations.push(
				...create_state_declarators(
					declarator,
					context.state.scope,
					/** @type {Expression} */ (declarator.init && context.visit(declarator.init))
				)
			);
		}
	}

	return {
		...node,
		declarations
	};
}

/**
 * @param {VariableDeclarator} declarator
 * @param {Scope} scope
 * @param {Expression} value
 * @returns {VariableDeclarator[]}
 */
function create_state_declarators(declarator, scope, value) {
	if (declarator.id.type === 'Identifier') {
		return [b.declarator(declarator.id, value)];
	}

	const tmp = scope.generate('tmp');
	const paths = extract_paths(declarator.id);
	return [
		b.declarator(b.id(tmp), value), // TODO inject declarator for opts, so we can use it below
		...paths.map((path) => {
			const value = path.expression?.(b.id(tmp));
			return b.declarator(path.node, value);
		})
	];
}
