// The config bundle's entry, kept beside the packer that builds it: the extension's compiled
// src/config.ts behind the override map (CONFIG_PATH is spliced in by build.mjs), with the
// field mapping of GitGraphView.getWebviewConfig() (src/gitGraphView.ts) so the result is
// exactly the shape the webview's initialState.config expects.
const { getConfig } = require(CONFIG_PATH);
const overrides = globalThis.__gitGraphStudioOverrides = globalThis.__gitGraphStudioOverrides || {};
module.exports = function buildWebviewConfig(settings) {
	for (const key of Object.keys(overrides)) delete overrides[key];
	Object.assign(overrides, settings || {});
	const config = getConfig();
	return {
		commitAuthors: config.commitAuthors,
		commitDetailsView: config.commitDetailsView,
		commitOrdering: config.commitOrder,
		contextMenuActionsVisibility: config.contextMenuActionsVisibility,
		customBranchGlobPatterns: config.customBranchGlobPatterns,
		customEmojiShortcodeMappings: config.customEmojiShortcodeMappings,
		customPullRequestProviders: config.customPullRequestProviders,
		dateFormat: config.dateFormat,
		dateType: config.dateType,
		defaultColumnVisibility: config.defaultColumnVisibility,
		enableLog: config.enableLog,
		stickyHeader: config.stickyHeader,
		dialogDefaults: config.dialogDefaults,
		enhancedAccessibility: config.enhancedAccessibility,
		fetchAndPrune: config.fetchAndPrune,
		fetchAndPruneTags: config.fetchAndPruneTags,
		fetchAvatars: false,
		gerrit: config.gerrit,
		graph: config.graph,
		// The resolved interface language: config.ts's interfaceLanguage getter defers "auto"
		// to vscode.env.language, which the stub resolves to the workbench's locale — so "auto"
		// follows the app's display language.
		interfaceLanguage: config.interfaceLanguage,
		interfaceLanguageSetting: config.interfaceLanguageSetting,
		includeCommitsMentionedByReflogs: config.includeCommitsMentionedByReflogs,
		initialLoadCommits: config.initialLoadCommits,
		keybindings: config.keybindings,
		loadMoreCommits: config.loadMoreCommits,
		loadMoreCommitsAutomatically: config.loadMoreCommitsAutomatically,
		markdown: config.markdown,
		mute: config.muteCommits,
		showBodyInline: config.showCommitBodyInline,
		onlyFollowFirstParent: config.onlyFollowFirstParent,
		onRepoLoad: config.onRepoLoad,
		pullRequests: config.pullRequests,
		referenceLabels: config.referenceLabels,
		repoDropdownOrder: config.repoDropdownOrder,
		showCommitBodyInline: config.showCommitBodyInline,
		showRemoteBranches: config.showRemoteBranches,
		showRemoteHeads: config.showRemoteHeads,
		showStashes: config.showStashes,
		showTags: config.showTags,
		showUncommittedChanges: config.showUncommittedChanges,
		showUntrackedFiles: config.showUntrackedFiles,
		trackRemoteTags: config.trackRemoteTags,
		// The git-side settings the backend's write path reads (the view never does).
		signCommits: config.signCommits,
		signTags: config.signTags,
		squashMergeMessageFormat: config.squashMergeMessageFormat,
		squashPullMessageFormat: config.squashPullMessageFormat
	};
};
