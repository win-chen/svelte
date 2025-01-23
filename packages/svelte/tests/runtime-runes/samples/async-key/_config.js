import { flushSync, tick } from 'svelte';
import { deferred } from '../../../../src/internal/shared/utils.js';
import { test } from '../../test';

/** @type {ReturnType<typeof deferred>} */
let d;

export default test({
	html: `<p>pending</p>`,

	get props() {
		d = deferred();

		return {
			promise: d.promise
		};
	},

	async test({ assert, target, component }) {
		d.resolve(1);
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
		await tick();
		flushSync();
		assert.htmlEqual(target.innerHTML, '<h1>hello</h1>');

		const h1 = target.querySelector('h1');

		d = deferred();
		component.promise = d.promise;
		await tick();
		assert.htmlEqual(target.innerHTML, '<p>pending</p>');

		d.resolve(1);
		await Promise.resolve();
		await tick();
		assert.htmlEqual(target.innerHTML, '<h1>hello</h1>');
		assert.equal(target.querySelector('h1'), h1);

		d = deferred();
		component.promise = d.promise;
		await tick();
		assert.htmlEqual(target.innerHTML, '<p>pending</p>');

		d.resolve(2);
		await Promise.resolve();
		await tick();
		assert.htmlEqual(target.innerHTML, '<h1>hello</h1>');
		assert.notEqual(target.querySelector('h1'), h1);
	}
});
