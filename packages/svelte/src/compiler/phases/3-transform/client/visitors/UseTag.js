/** @import { Expression } from 'estree' */
/** @import { AST } from '#compiler' */
/** @import { ComponentContext } from '../types' */
import * as b from '../../../../utils/builders.js';

/**
 * @param {AST.UseTag} node
 * @param {ComponentContext} context
 */
export function UseTag(node, context) {
	context.state.init.push(
		b.stmt(
			b.call(
				'$.attach',
				context.state.node,
				b.thunk(/** @type {Expression} */ (context.visit(node.expression)))
			)
		)
	);
	context.next();
}
