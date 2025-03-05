/** @import { ValidatedCompileOptions, CompileResult, ValidatedModuleCompileOptions } from '#compiler' */
/** @import { ComponentAnalysis, Analysis } from '../types' */
import { print } from 'esrap';
import { VERSION } from '../../../version.js';
import { server_component, server_module } from './server/transform-server.js';
import { client_component, client_module } from './client/transform-client.js';
import { render_stylesheet } from './css/index.js';
import { merge_with_preprocessor_map, get_source_name } from '../../utils/mapped_code.js';
import * as state from '../../state.js';

/**
 * @param {ComponentAnalysis} analysis
 * @param {string} source
 * @param {ValidatedCompileOptions} options
 * @returns {CompileResult}
 */
export function transform_component(analysis, source, options) {
	if (options.generate === false) {
		return {
			js: /** @type {any} */ (null),
			css: null,
			warnings: state.warnings, // set afterwards
			metadata: {
				runes: analysis.runes,
				hasUnscopedGlobalCss: analysis.css.has_unscoped_global
			},
			ast: /** @type {any} */ (null) // set afterwards
		};
	}

	const program =
		options.generate === 'server'
			? server_component(analysis, options)
			: client_component(analysis, options);

	const js_source_name = get_source_name(options.filename, options.outputFilename, 'input.svelte');

	const js = print(program, {
		// include source content; makes it easier/more robust looking up the source map code
		// (else esrap does return null for source and sourceMapContent which may trip up tooling)
		sourceMapContent: source,
		sourceMapSource: js_source_name
	});

	merge_with_preprocessor_map(js, options, js_source_name);

	const css =
		analysis.css.ast && !analysis.inject_styles
			? render_stylesheet(source, analysis, options)
			: null;

	return {
		js,
		css,
		warnings: state.warnings, // set afterwards. TODO apply preprocessor sourcemap
		metadata: {
			runes: analysis.runes,
			hasUnscopedGlobalCss: analysis.css.has_unscoped_global
		},
		ast: /** @type {any} */ (null) // set afterwards
	};
}

/**
 * @param {Analysis} analysis
 * @param {string} source
 * @param {ValidatedModuleCompileOptions} options
 * @returns {CompileResult}
 */
export function transform_module(analysis, source, options) {
	if (options.generate === false) {
		return {
			js: /** @type {any} */ (null),
			css: null,
			warnings: state.warnings, // set afterwards
			metadata: {
				runes: true,
				hasUnscopedGlobalCss: false
			},
			ast: /** @type {any} */ (null) // set afterwards
		};
	}

	const program =
		options.generate === 'server'
			? server_module(analysis, options)
			: client_module(analysis, options);

	const basename = options.filename.split(/[/\\]/).at(-1);
	if (program.body.length > 0) {
		program.body[0].leadingComments = [
			{
				type: 'Block',
				value: ` ${basename} generated by Svelte v${VERSION} `
			}
		];
	}

	return {
		js: print(program, {
			// include source content; makes it easier/more robust looking up the source map code
			// (else esrap does return null for source and sourceMapContent which may trip up tooling)
			sourceMapContent: source,
			sourceMapSource: get_source_name(options.filename, undefined, 'input.svelte.js')
		}),
		css: null,
		metadata: {
			runes: true,
			hasUnscopedGlobalCss: false
		},
		warnings: state.warnings, // set afterwards
		ast: /** @type {any} */ (null) // set afterwards
	};
}
