module.exports = {
  types: [
    { type: 'feat', section: 'Features' },
    { type: 'fix', section: 'Bug Fixes' },
    { type: 'chore', section: 'Maintenance' },
    { type: 'docs', section: 'Documentation' },
    { type: 'style', section: 'Styling' },
    { type: 'refactor', section: 'Code Refactoring' },
    { type: 'perf', section: 'Performance Improvements' },
    { type: 'test', section: 'Tests' },
    { type: 'build', section: 'Build System' },
    { type: 'ci', section: 'Continuous Integration' },
  ],
  commitUrlFormat: 'https://github.com/agglayer/sdk/commit/{{hash}}',
  compareUrlFormat:
    'https://github.com/agglayer/sdk/compare/{{previousTag}}...{{currentTag}}',
  issueUrlFormat: 'https://github.com/agglayer/sdk/issues/{{id}}',
  userUrlFormat: 'https://github.com/{{user}}',
  releaseCommitMessageFormat: 'chore(release): {{currentTag}}',
  header:
    '# Changelog\n\nAll notable changes to this project will be documented in this file. See [Conventional Commits](https://conventionalcommits.org) for commit guidelines.\n',
  skip: {
    bump: false,
    commit: false,
    tag: false,
  },
};
