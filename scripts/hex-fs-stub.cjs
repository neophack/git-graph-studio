// The `fs` module as the hex-session machinery sees it when it is bundled for the app: the
// extension's compiled hexDiff.ts reads working-tree sides through Node's callback-style fs
// (stat / open / read / createReadStream / readFile / closeSync), which does not exist in the
// browser. graphHost.ts installs the real implementation - over the app's backend commands -
// as globalThis.__ggsHexFs before the machinery is first used; every function here resolves
// that global at call time, so the bundle loads before the host has provided it and only a
// genuinely missing adapter (the machinery used outside the app) throws.

function adapter(name) {
	return function (...args) {
		const fs = globalThis.__ggsHexFs;
		if (fs === undefined || typeof fs[name] !== 'function') {
			const callback = args[args.length - 1];
			if (typeof callback === 'function') callback(new Error(`fs.${name} is not available in this environment`));
			else throw new Error(`fs.${name} is not available in this environment`);
			return;
		}
		return fs[name](...args);
	};
}

module.exports = {
	stat: adapter('stat'),
	open: adapter('open'),
	read: adapter('read'),
	close: adapter('close'),
	createReadStream: adapter('createReadStream'),
	readFile: adapter('readFile'),
	closeSync: adapter('closeSync')
};
