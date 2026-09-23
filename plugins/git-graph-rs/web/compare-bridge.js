// The bridge of the Commit Comparison and Binary Compare pages — the extension-host role for
// the extension's own generated pages, in-page (the sibling of bridge.js; one file serves
// both pages, dispatched on the page id the host's context carries). It generates the page
// from the extension's own templates (compare.js / binarycompare.js), swaps the document to
// it under the same acquireVsCodeApi shim, fetches the page's data from this package's own
// backend, and drives the extension's real hex/picture session machinery over backend-backed
// adapters (revision bytes through `__revisionFileBytes`, working-tree reads through the
// repo-confined `__fileChunk`).
(function () {
	'use strict';

	var UNCOMMITTED = '*';
	var ggs = acquireGgsApi();
	var context = null;
	var input = null; // { repo, fromHash, toHash, singleCommit } / { repo, fromHash, toHash, file }
	var changes = [];
	var countsSettled = false;
	var session = null; // the Binary Compare page's single hex session
	var hexSessions = {}; // the Commit Comparison page's, by file index (LRU-bounded)
	var hexOrder = [];
	var CHUNK = 256 * 1024;

	function request(method, args) { return ggs.request(method, args || []); }

	function backend(message) {
		return request('backend.message', [message, null]).then(function (response) {
			return response === null || response === undefined ? null : response;
		}, function (error) {
			return { command: String(message.command || ''), error: String(error), errors: [String(error)] };
		});
	}

	function post(message) { window.postMessage(message, '*'); }

	/* ---------- the byte carrier: the Node Buffer surface the compiled machinery uses ---------- */

	function HexBufferFrom(bytes) {
		var copy = new Uint8Array(bytes.length);
		copy.set(bytes);
		enhanceBuffer(copy);
		return copy;
	}

	function enhanceBuffer(buffer) {
		buffer.toString = function (encoding) {
			if (encoding === 'base64') {
				var binary = '';
				for (var i = 0; i < this.length; i += 0x8000) binary += String.fromCharCode.apply(null, this.subarray(i, Math.min(this.length, i + 0x8000)));
				return btoa(binary);
			}
			if (encoding === 'latin1') {
				var text = '';
				for (var j = 0; j < this.length; j++) text += String.fromCharCode(this[j]);
				return text;
			}
			return new TextDecoder().decode(this);
		};
		buffer.equals = function (other) {
			if (!(other instanceof Uint8Array) || other.length !== this.length) return false;
			for (var i = 0; i < this.length; i++) if (this[i] !== other[i]) return false;
			return true;
		};
		buffer.copy = function (target, targetStart, sourceStart, sourceEnd) {
			target.set(this.subarray(sourceStart, sourceEnd), targetStart);
		};
		return buffer;
	}

	function decodeBase64(data) {
		var binary = atob(data);
		var bytes = new Uint8Array(binary.length);
		for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
		return bytes;
	}

	/* ---------- the streams the machinery spawns (git cat-file over the backend) ---------- */

	function FakeStream() {
		this.listeners = {};
		this.destroyed = false;
	}
	FakeStream.prototype.on = function (event, listener) {
		(this.listeners[event] = this.listeners[event] || []).push(listener);
		return this;
	};
	FakeStream.prototype.emit = function (event) {
		var args = Array.prototype.slice.call(arguments, 1);
		var set = (this.listeners[event] || []).slice();
		for (var i = 0; i < set.length; i++) set[i].apply(null, args);
	};
	FakeStream.prototype.resume = function () { /* the adapter pushes eagerly */ };
	FakeStream.prototype.destroy = function () { this.destroyed = true; };

	function FakeChild() {
		this.stdout = new FakeStream();
		this.stderr = new FakeStream();
		this.listeners = {};
		this.killed = false;
	}
	FakeChild.prototype.on = function (event, listener) {
		(this.listeners[event] = this.listeners[event] || []).push(listener);
		return this;
	};
	FakeChild.prototype.emitClose = function (code) {
		var set = (this.listeners.close || []).slice();
		for (var i = 0; i < set.length; i++) set[i](code);
	};
	FakeChild.prototype.kill = function () {
		this.killed = true;
		this.stdout.destroyed = true;
	};

	/** `spawnGitStream(['cat-file', ('-s'|'blob'), '<rev>:<path>'], repo)` over the backend:
	 *  revision sides read as one blob (`__revisionFileBytes`), the working-tree sentinel `*`
	 *  as a windowed whole-file read (`__fileChunk`). */
	function spawnGitStream(args, repo) {
		var spec = String(args[2] || '');
		var separator = spec.indexOf(':');
		var revision = separator > 0 ? spec.slice(0, separator) : spec;
		var path = separator > 0 ? spec.slice(separator + 1) : '';
		var child = new FakeChild();
		var readBytes = function () {
			if (revision === UNCOMMITTED || revision === '') {
				return backend({ command: '__fileChunk', repo: repo, path: path, offset: 0, len: 32 * 1024 * 1024 }).then(function (response) {
					if (response === null || response.error !== null && response.error !== undefined) throw new Error(String((response && response.error) || 'unreadable'));
					return decodeBase64(String(response.base64 || ''));
				});
			}
			return backend({ command: '__revisionFileBytes', repo: repo, revision: revision, path: path }).then(function (response) {
				if (response === null || (response.error !== null && response.error !== undefined)) throw new Error(String((response && response.error) || 'unreadable'));
				var encoded = response.bytes;
				return typeof encoded === 'string' ? decodeBase64(encoded) : null;
			});
		};
		readBytes().then(function (bytes) {
			if (bytes === null || bytes === undefined) {
				child.stderr.emit('data', spec + ': does not exist');
				child.emitClose(128);
				return;
			}
			if (args[1] === '-s') {
				child.stdout.emit('data', String(bytes.length));
				child.stdout.emit('end');
				child.emitClose(0);
				return;
			}
			for (var offset = 0; offset < bytes.length && !child.killed; offset += CHUNK) {
				child.stdout.emit('data', HexBufferFrom(bytes.subarray(offset, Math.min(bytes.length, offset + CHUNK))));
			}
			if (!child.killed) child.stdout.emit('end');
			child.emitClose(0);
		}, function (error) {
			child.stderr.emit('data', String(error));
			child.emitClose(1);
		});
		return child;
	}

	// Where the bundle's fs stub looks: working-tree reads through the repo-confined chunk arm.
	// The callback-style open/read/close trio trades in descriptors; the reads here are
	// addressed by path (one descriptor: the most recently opened path).
	var hexOpenPath = '';
	window.__ggsHexFs = {
		stat: function (path, callback) {
			backend({ command: '__fileChunk', repo: input.repo, path: path, offset: 0, len: 1 }).then(
				function (response) { callback(null, { size: (response && response.size) || 0 }); },
				function (error) { callback({ code: 'ENOENT', message: String(error) }); }
			);
		},
		open: function (path, callback) { hexOpenPath = path; callback(null, 1); },
		read: function (fd, buffer, offset, length, position, callback) {
			backend({ command: '__fileChunk', repo: input.repo, path: hexOpenPath, offset: position, len: length }).then(
				function (response) {
					var bytes = decodeBase64(String((response && response.base64) || ''));
					buffer.set(bytes.subarray(0, length), offset);
					callback(null, bytes.length, buffer);
				},
				function (error) { callback(error instanceof Error ? error : new Error(String(error))); }
			);
		},
		createReadStream: function (path) {
			var stream = new FakeStream();
			var offset = 0;
			var pump = function () {
				backend({ command: '__fileChunk', repo: input.repo, path: path, offset: offset, len: CHUNK }).then(function (response) {
					if (stream.destroyed) return;
					var bytes = decodeBase64(String((response && response.base64) || ''));
					if (bytes.length === 0 || offset >= (response.size || 0)) {
						stream.emit('end');
						return;
					}
					stream.emit('data', HexBufferFrom(bytes));
					offset += bytes.length;
					pump();
				}, function (error) {
					if (!stream.destroyed) stream.emit('error', error instanceof Error ? error : new Error(String(error)));
				});
			};
			pump();
			return stream;
		},
		readFile: function (path, callback) {
			backend({ command: '__fileChunk', repo: input.repo, path: path, offset: 0, len: 32 * 1024 * 1024 }).then(
				function (response) { callback(null, HexBufferFrom(decodeBase64(String((response && response.base64) || '')))); },
				function (error) { callback(error instanceof Error ? error : new Error(String(error))); }
			);
		},
		closeSync: function () { /* reads are stateless */ }
	};
	window.__ggsWriteClipboard = function (text) { return request('clipboard.writeText', [text]); };

	/* ---------- the theme ---------- */

	function applyTheme(theme) {
		var style = document.getElementById('ggs-theme');
		if (!style) {
			style = document.createElement('style');
			style.id = 'ggs-theme';
			(document.head || document.documentElement).insertBefore(style, (document.head || document.documentElement).firstChild);
		}
		style.textContent = 'html, body { height: 100%; margin: 0; background: var(--vscode-editor-background); }\n' + theme.css;
		for (var i = 0; i < [document.documentElement, document.body].length; i++) {
			var element = [document.documentElement, document.body][i];
			if (!element) continue;
			element.classList.remove('vscode-dark', 'vscode-light');
			element.classList.add(theme.kind);
			element.setAttribute('data-vscode-theme-kind', theme.kind);
		}
	}

	/** Every generated page carries its own random nonce, but this page swaps its document more
	 *  than once (the loading state, then the loaded one) and a `<meta>` Content-Security-Policy
	 *  survives document.open(): the policies accumulate, so the first page's `script-src
	 *  'nonce-A'` keeps blocking the next page's `nonce-B` scripts — the file list's inline
	 *  script among them, leaving "no changes between these commits" on screen. Every later
	 *  page is rewritten to the first page's nonce, which each accumulated policy admits. */
	var pinnedNonce = null;
	function pinNonce(html) {
		var found = /'nonce-([^']+)'/.exec(html);
		if (!found) return html;
		if (pinnedNonce === null) {
			pinnedNonce = found[1];
			return html;
		}
		return html.split(found[1]).join(pinnedNonce);
	}

	/** Same contract as the view bridge's swap: the shim lives on the surviving window, the
	 *  generated page's scripts ride along as written (their nonce pinned, above). */
	function swapDocument(html, options) {
		var style = document.getElementById('ggs-theme');
		var themeText = style ? style.textContent : '';
		html = pinNonce(html).replace('<head>', '<head><style id="ggs-theme">' + themeText + '</style>');
		// A placeholder page (the loading state) is written without its scripts: the window
		// outlives document.open(), and so does the global scope — the page script's top-level
		// `const`s would already be declared when the loaded page's copy runs, which then dies
		// with a SyntaxError before rendering a single file row.
		if (options && options.scripts === false) html = html.replace(/<script\b[\s\S]*?<\/script>/g, '');
		var api = {
			getState: function () { return null; },
			setState: function () { },
			postMessage: function (message) { onMessage(message); }
		};
		window.acquireVsCodeApi = function () { return api; };
		document.open();
		document.write(html);
		document.close();
	}

	/* ---------- boot ---------- */

	function loadScript(src) {
		return new Promise(function (resolve, reject) {
			var script = document.createElement('script');
			script.src = src;
			script.onload = resolve;
			script.onerror = function () { reject(new Error(src + ' did not load')); };
			(document.head || document.documentElement).appendChild(script);
		});
	}

	function boot() {
		ggs.ready.then(function (ctx) {
			context = ctx;
			input = ctx.params || {};
			return request('theme.stylesheet');
		}).then(function (theme) {
			applyTheme(theme);
			return context.pageId === 'binarycompare'
				? Promise.all([loadScript('compare.js'), loadScript('binarycompare.js')])
				: loadScript('compare.js');
		}).then(function () {
			return context.pageId === 'binarycompare' ? bootBinaryCompare() : bootCompare();
		}).catch(function (error) {
			var div = document.createElement('div');
			div.style.cssText = 'padding:20px;color:var(--vscode-errorForeground,#f48771)';
			div.textContent = 'The comparison page failed to load: ' + String(error);
			document.body.innerHTML = '';
			document.body.appendChild(div);
		});
	}

	/* ---------- the Commit Comparison page ---------- */

	async function bootCompare() {
		swapDocument(window.GitGraphCompare.buildComparePage({ fromHash: input.fromHash, toHash: input.toHash, singleCommit: input.singleCommit === true, loading: true }), { scripts: false });
		var hashes = (input.singleCommit === true ? [input.toHash] : [input.fromHash, input.toHash]).filter(function (hash) { return hash !== '' && hash !== UNCOMMITTED; });
		var repo = input.repo;
		var results = await Promise.all([
			backend({ command: 'getCommitComparison', repo: repo, fromHash: input.fromHash, toHash: input.toHash }),
			backend({ command: 'getCommitSummaries', repo: repo, commitHashes: hashes }),
			countBetween()
		]);
		var comparison = results[0], summaries = results[1], commitsBetween = results[2];
		var error = comparison && comparison.error === null ? null : String((comparison && comparison.error) || 'The changes could not be loaded.');
		changes = error === null ? (comparison.fileChanges || []) : [];
		swapDocument(window.GitGraphCompare.buildComparePage({
			fromHash: input.fromHash, toHash: input.toHash, singleCommit: input.singleCommit === true,
			error: error, fileChanges: changes,
			summaries: (summaries && summaries.summaries) || {},
			commitsBetween: commitsBetween
		}));
	}

	async function countBetween() {
		if (input.singleCommit === true || input.fromHash === '' || input.fromHash === UNCOMMITTED) return null;
		var tip = input.toHash === '' || input.toHash === UNCOMMITTED ? 'HEAD' : input.toHash;
		var response = await backend({ command: 'countCommitsBefore', repo: input.repo, hash: input.fromHash, branches: [tip], showRemoteBranches: false, includeCommitsMentionedByReflogs: false });
		return response && typeof response.count === 'number' ? response.count : null;
	}

	/* ---------- the Binary Compare page ---------- */

	async function bootBinaryCompare() {
		var file = { oldFilePath: input.file.oldFilePath, newFilePath: input.file.newFilePath, type: input.file.type, additions: null, deletions: null };
		var filePath = file.newFilePath !== '' ? file.newFilePath : file.oldFilePath;
		swapDocument(window.GitGraphBinaryCompare.buildBinaryComparePage({ fromHash: input.fromHash, toHash: input.toHash, filePath: filePath, file: file }));
	}

	/* ---------- the pages' messages ---------- */

	function onMessage(message) {
		if (!message || typeof message !== 'object') return;
		var command = String(message.command);
		if (context.pageId === 'binarycompare') {
			if (command === 'getHexInfo') respondHex(ensureSession(), 0, Number(message.bytesPerRow));
			else if (command === 'getHexRows' && session) window.GitGraphCompare.respondHexRows(session, 0, Number(message.start), Number(message.count), post);
			else if (command === 'getImageData') respondImage(ensureSession(), 0, { oldFilePath: input.file.oldFilePath, newFilePath: input.file.newFilePath, type: input.file.type, additions: null, deletions: null });
			else if (command === 'copyToClipboard') window.GitGraphCompare.respondCopyToClipboard(post, String(message.type), String(message.data));
			return;
		}
		var index = Number(message.index);
		if (command === 'getFileDiff') {
			backend({
				command: 'getCommitFileDiff', repo: input.repo, fromHash: input.fromHash, toHash: input.toHash,
				oldFilePath: changes[index] && changes[index].oldFilePath, newFilePath: changes[index] && changes[index].newFilePath
			}).then(function (response) {
				post({ command: 'fileDiff', index: index, diff: (response && response.diff) || null, error: response && response.error === null ? null : String((response && response.error) || 'The diff could not be loaded.') });
			});
		} else if (command === 'requestCounts') {
			answerCounts((message.paths || []));
		} else if (command === 'viewDiff') {
			if (changes[index]) openDiff(changes[index]);
		} else if (command === 'viewDiffBinary') {
			if (changes[index]) {
				request('pages.open', ['binarycompare', {
					repo: input.repo, fromHash: input.fromHash, toHash: input.toHash,
					file: { oldFilePath: changes[index].oldFilePath, newFilePath: changes[index].newFilePath, type: changes[index].type }
				}]).catch(function () { return undefined; });
			}
		} else if (command === 'getHexInfo') {
			respondHex(hexSession(index), index, Number(message.bytesPerRow));
		} else if (command === 'getHexRows') {
			var existing = hexSessions[index];
			if (existing) window.GitGraphCompare.respondHexRows(existing, index, Number(message.start), Number(message.count), post);
		} else if (command === 'getImageData') {
			respondImage(hexSession(index), index, changes[index]);
		} else if (command === 'copyToClipboard') {
			window.GitGraphCompare.respondCopyToClipboard(post, String(message.type), String(message.data));
		}
		settlePendingCounts();
	}

	function respondHex(target, index, bytesPerRow) {
		if (target) window.GitGraphCompare.respondHexInfo(target, index, bytesPerRow, post);
	}

	function respondImage(target, index, file) {
		if (target && file) window.GitGraphCompare.respondImageData(target, index, file, post);
	}

	function hexSession(index) {
		if (hexSessions[index] !== undefined) {
			// LRU bump
			hexOrder = hexOrder.filter(function (at) { return at !== index; });
			hexOrder.push(index);
			return hexSessions[index];
		}
		var file = changes[index];
		if (!window.GitGraphCompare || !window.GitGraphCompare.createHexSession || file === undefined) return null;
		var created = window.GitGraphCompare.createHexSession(
			{ spawnGitStream: function (args, repo) { return spawnGitStream(args, repo || input.repo); } },
			input.repo || '', input.fromHash, input.toHash, file
		);
		window.GitGraphCompare.wireHexSession && window.GitGraphCompare.wireHexSession(created, index, post);
		hexSessions[index] = created;
		hexOrder.push(index);
		while (hexOrder.length > 4) {
			var oldest = hexOrder.shift();
			if (hexSessions[oldest] && hexSessions[oldest].dispose) hexSessions[oldest].dispose();
			delete hexSessions[oldest];
		}
		return created;
	}

	function ensureSession() {
		if (session !== null) return session;
		if (!window.GitGraphCompare || !window.GitGraphCompare.createHexSession) return null;
		session = window.GitGraphCompare.createHexSession(
			{ spawnGitStream: function (args, repo) { return spawnGitStream(args, repo || input.repo); } },
			input.repo || '', input.fromHash, input.toHash,
			{ oldFilePath: input.file.oldFilePath, newFilePath: input.file.newFilePath, type: input.file.type, additions: null, deletions: null }
		);
		window.GitGraphCompare.wireHexSession && window.GitGraphCompare.wireHexSession(session, 0, post);
		return session;
	}

	function answerCounts(paths) {
		if (paths.length === 0) return;
		if (input.toHash === UNCOMMITTED || input.toHash === '') {
			var settled = {};
			paths.forEach(function (path) { settled[path] = { additions: null, deletions: null }; });
			post({ command: 'lineCounts', counts: settled });
			return;
		}
		backend({ command: 'commitFileCounts', repo: input.repo, from: input.fromHash, to: input.toHash, paths: paths }).then(function (response) {
			post({ command: 'lineCounts', counts: (response && response.counts) || {} });
		});
	}

	function settlePendingCounts() {
		if (countsSettled || (input.toHash !== UNCOMMITTED && input.toHash !== '')) return;
		countsSettled = true;
		var counts = {};
		changes.forEach(function (file) {
			if (file.additions === null && file.type !== 'U') {
				counts[file.newFilePath !== '' ? file.newFilePath : file.oldFilePath] = { additions: null, deletions: null };
			}
		});
		if (Object.keys(counts).length > 0) post({ command: 'lineCounts', counts: counts });
	}

	/** "Open Diff in Editor": the shell's own diff editor, titled as the extension's viewDiff. */
	function openDiff(file) {
		var from = input.fromHash === '' || input.fromHash === UNCOMMITTED ? 'HEAD' : input.fromHash;
		var to = input.toHash;
		var oldPath = String(file.oldFilePath).replace(/\\/g, '/');
		var newPath = String(file.newFilePath || file.oldFilePath).replace(/\\/g, '/');
		var abbrev = function (hash) { return hash === '' || hash === UNCOMMITTED ? (hash === UNCOMMITTED ? 'Uncommitted' : '') : (hash.length > 8 ? hash.slice(0, 8) : hash); };
		request('workbench.openDiff', [{
			id: 'compare:' + from + ':' + oldPath + ':' + to + ':' + newPath,
			title: newPath.split('/').pop() + ' (' + (from === to ? abbrev(from) + '^ \u2194 ' + abbrev(to) : abbrev(from) + ' \u2194 ' + abbrev(to)) + ')',
			repo: input.repo, binaryNotice: true,
			left: { revision: from, path: oldPath, label: abbrev(from), exists: file.type !== 'A' },
			right: { revision: to, path: newPath, label: to === UNCOMMITTED ? 'Working Tree' : abbrev(to), exists: file.type !== 'D' }
		}]).catch(function () { return undefined; });
	}

	ggs.onMessage(function (event) {
		if (event && event.kind === 'theme') {
			request('theme.stylesheet').then(applyTheme).catch(function () { return undefined; });
		}
	});

	boot();
})();
