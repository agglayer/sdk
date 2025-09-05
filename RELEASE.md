# Release Guide

This document outlines the release process for the AggLayer SDK package.

## Branching Strategy

### 🌿 **Two-Branch Model**

- **`main`**: Production-ready code, stable releases only
- **`develop`**: Integration branch, prerelease versions only

### 🚫 **Stable Release Restrictions**

- **ONLY `main` branch** can create stable releases (`latest` channel)
- **`develop` branch** is restricted to prerelease channels only
- **No other branches** can create any releases

## Release Channels

### 🚀 **Latest** (Stable)

- **Channel**: `latest`
- **Branch**: `main` ONLY
- **Usage**: `npm install @agglayer/sdk`
- **Purpose**: Production-ready, stable releases
- **Trigger**: Manual workflow dispatch ONLY (no auto-release)
- **GitHub Tags**: ✅ Creates version tags (v1.0.0)

### 🧪 **Beta** (Prerelease)

- **Channel**: `beta`
- **Branch**: `develop` or `main`
- **Usage**: `npm install @agglayer/sdk@beta`
- **Purpose**: Feature-complete, testing phase
- **Trigger**: Auto-release from develop branch or manual workflow dispatch
- **GitHub Tags**: ✅ Creates prerelease tags (v1.0.0-beta.1)

### 🔧 **Dev** (Development)

- **Channel**: `dev`
- **Branch**: `develop` or `main`
- **Usage**: `npm install @agglayer/sdk@dev`
- **Purpose**: Development builds with experimental features
- **Trigger**: Manual workflow dispatch only
- **GitHub Tags**: ✅ Creates prerelease tags (v1.0.0-dev.1)

### ⚡ **Alpha** (Early Access)

- **Channel**: `alpha`
- **Branch**: `develop` or `main`
- **Usage**: `npm install @agglayer/sdk@alpha`
- **Purpose**: Early access to cutting-edge features
- **Trigger**: Manual workflow dispatch only
- **GitHub Tags**: ✅ Creates prerelease tags (v1.0.0-alpha.1)

## GitHub Tags

### 🏷️ **Automatic Tag Creation**

All releases automatically create GitHub tags:

- **Stable releases**: `v1.0.0`, `v1.1.0`, `v2.0.0`
- **Prerelease versions**: `v1.0.0-beta.1`, `v1.0.0-alpha.1`, `v1.0.0-dev.1`

### 📦 **Tag-Based Releases**

You can also trigger releases by creating tags manually:

```bash
# Create a tag
git tag v1.0.0
git push origin v1.0.0

# This automatically triggers the tag-release workflow
```

### 🔄 **Tag Workflow Benefits**

- **Version Control**: Clear version history in GitHub
- **Release Notes**: Automatic changelog generation
- **Rollback**: Easy to identify and revert to specific versions
- **CI/CD**: Triggers automated builds and deployments

## Release Workflows

### 1. Manual Release (`release.yml`)

**Trigger**: GitHub Actions → Release Packages → Run workflow

**Options**:

- **Channel**: alpha, dev, beta, latest
- **Branch**: main, develop (default: main)
- **Force**: Override version existence check (default: false)

**Process**:

1. ✅ Input validation
2. 🔍 Working directory check
3. 📦 Dependency installation
4. 🔍 Quality checks (typecheck, lint, format)
5. 🏗️ Build packages
6. 🧪 Run tests
7. 🔍 Version existence check (unless forced)
8. 🚀 Release with Lerna
9. ✅ Release verification

### 2. Auto Release (`auto-release.yml`)

**Triggers**:

- **Push to `develop`** → Auto-prerelease to `beta` (creates GitHub tag)
- **Pull Requests** → Run tests only

**Note**: Stable releases (`latest` channel) are **manual only** - no auto-release from main branch

### 3. Tag Release (`tag-release.yml`)

**Triggers**:

- **Push tags** → `git push origin v1.0.0`
- **Manual dispatch** → Specify tag and channel

**Options**:

- **Tag**: Version tag (e.g., v1.0.0, v1.0.0-beta.1)
- **Channel**: latest, beta, alpha, dev

**Process**:

1. ✅ Tag format validation
2. 🔍 Quality checks
3. 🏗️ Build packages
4. 🧪 Run tests
5. 📦 Publish from existing tag
6. ✅ Release verification

## Release Process

### Manual Release Steps

1. **Prepare Release**

   ```bash
   # Ensure you're on the correct branch
   git checkout main  # or develop

   # Ensure working directory is clean
   git status

   # Run tests locally
   bun run test:run
   ```

2. **Trigger Release**
   - Go to GitHub Actions
   - Select "Release Packages" workflow
   - Click "Run workflow"
   - Choose channel and branch
   - Click "Run workflow"

3. **Monitor Release**
   - Watch the workflow progress
   - Check for any failures
   - Verify package is published to NPM

### Auto Release Process

1. **Push to Main** (Stable Release)

   ```bash
   git push origin main
   # Automatically triggers release to 'latest' channel
   ```

2. **Push to Develop** (Beta Release)
   ```bash
   git push origin develop
   # Automatically triggers prerelease to 'beta' channel
   ```

## Version Management

### Semantic Versioning

- **Major** (1.0.0): Breaking changes
- **Minor** (0.1.0): New features, backward compatible
- **Patch** (0.0.1): Bug fixes, backward compatible

### Conventional Commits

The release process uses conventional commits to determine version bumps:

- `feat:` → Minor version bump
- `fix:` → Patch version bump
- `BREAKING CHANGE:` → Major version bump

### Prerelease Versions

- **Alpha**: `1.0.0-alpha.1`
- **Beta**: `1.0.0-beta.1`
- **RC**: `1.0.0-rc.1`

## Quality Gates

All releases must pass:

1. **Type Checking**: `bun run typecheck`
2. **Linting**: `bun run lint`
3. **Formatting**: `bun run format:check`
4. **Building**: `bun run build`
5. **Testing**: `bun run test:run`

## Troubleshooting

### Common Issues

1. **Version Already Exists**

   ```
   Error: Version 1.0.0 already exists on latest channel
   ```

   **Solution**: Use `force: true` option or bump version

2. **Working Directory Not Clean**

   ```
   Error: Working directory is not clean
   ```

   **Solution**: Commit or stash changes before release

3. **Tests Failing**

   ```
   Error: Tests failed
   ```

   **Solution**: Fix failing tests before release

4. **Build Failing**
   ```
   Error: Build output directory 'dist' not found
   ```
   **Solution**: Check build configuration and dependencies

### Rollback Process

If a release fails or needs to be rolled back:

1. **Check NPM Registry**

   ```bash
   npm view @agglayer/sdk@latest version
   ```

2. **Unpublish (if necessary)**

   ```bash
   npm unpublish @agglayer/sdk@1.0.0 --force
   ```

3. **Revert Git Changes**
   ```bash
   git revert <commit-hash>
   git push origin main
   ```

## Security

### Required Secrets

- `SEMANTIC_RELEASE_BOT_APP_ID`: GitHub App ID
- `SEMANTIC_RELEASE_BOT_APP_PRIVATE_KEY`: GitHub App private key
- `NPM_TOKEN`: NPM authentication token

### Permissions

- GitHub App: Repository and release permissions
- NPM Token: Publish permissions for `@agglayer` scope

## Best Practices

1. **Always test locally** before triggering a release
2. **Use appropriate channels** for different release types
3. **Follow conventional commits** for automatic versioning
4. **Monitor release progress** and verify success
5. **Keep release notes** updated and descriptive
6. **Use force option sparingly** and with caution

## Support

For release-related issues:

1. Check the GitHub Actions logs
2. Verify NPM package status
3. Review this documentation
4. Contact the development team
