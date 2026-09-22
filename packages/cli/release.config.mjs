export default {
  extends: '@discordservers/semantic-release-monorepo',
  branches: ['main'],
  plugins: [
    [
      '@semantic-release/commit-analyzer',
      {
        // angular cuts nothing for a refactor, and a refactor here still ships changed code
        releaseRules: [{ type: 'refactor', release: 'patch' }],
      },
    ],
    '@semantic-release/release-notes-generator',
    '@semantic-release/npm',
    '@semantic-release/github',
  ],
};
