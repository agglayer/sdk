# 🚀 Release Guide

This document provides comprehensive instructions for releasing the AggLayer SDK package to npm and creating GitHub releases.

## 📋 Release Channels

| Channel  | Description                      | Stability           | Usage                             | Auto-Detected Branch | Trigger  |
| -------- | -------------------------------- | ------------------- | --------------------------------- | -------------------- | -------- |
| `latest` | Stable releases (v1.0.0, v2.0.0) | ✅ Production Ready | `npm install @agglayer/sdk`       | `main`               | Tag push |
| `beta`   | Beta releases (v1.0.0-beta.1)    | ⚠️ Testing          | `npm install @agglayer/sdk@beta`  | `develop`            | Tag push |
| `alpha`  | Alpha releases (v1.0.0-alpha.1)  | 🚧 Experimental     | `npm install @agglayer/sdk@alpha` | `develop`            | Tag push |
| `dev`    | Development releases             | 🔧 Development      | `npm install @agglayer/sdk@dev`   | `develop`            | Tag push |

## 🏷️ GitHub Tags

**Primary Method**: Tag-based releases are the recommended approach for all releases.

### Tag Format

- **Stable**: `v1.0.0`, `v2.1.0` (semantic versioning)
- **Beta**: `v1.0.0-beta.1`, `v1.0.0-beta.2`
- **Alpha**: `v1.0.0-alpha.1`, `v1.0.0-alpha.2`
- **Dev**: `v1.0.0-dev.1`, `v1.0.0-dev.2`

### Benefits of Tag-Based Releases

- ✅ **Automatic channel detection** from tag format
- ✅ **Automatic branch detection** (main for stable, develop for prereleases)
- ✅ **Version synchronization** with package.json
- ✅ **Repository updates** with version changes
- ✅ **Quality checks** before release
- ✅ **GitHub release creation** with release notes

## 🔄 Release Workflows

### 1. Tag Release (`tag-release.yml`) - **Primary Method**

**Trigger**:

- **Automatic**: Push a Git tag (e.g., `git push origin v1.0.0-beta.1`)
- **Manual**: GitHub Actions → "Tag Release" → Run workflow

**Smart Features**:

- **Auto Channel Detection**: Detects npm dist-tag from Git tag format
  - `v1.0.0-beta.1` → `beta` channel
  - `v1.0.0-alpha.1` → `alpha` channel
  - `v1.0.0-dev.1` → `dev` channel
  - `v1.0.0` → `latest` channel

- **Auto Branch Detection**: Detects target branch from release type
  - Beta/Alpha/Dev tags → `develop` branch
  - Stable tags → `main` branch

**Process**:

1. ✅ Tag validation and format checking
2. 🔍 Working directory validation
3. 📦 Dependency installation
4. 🔍 Quality checks (typecheck, lint, format)
5. 🏗️ Build packages
6. 🧪 Run tests
7. 🔍 Tag existence verification
8. 🌿 Checkout appropriate branch (main/develop)
9. 📝 Update package.json version to match tag
10. 📤 Commit and push version changes
11. 📦 Publish to NPM with correct channel
12. 🏷️ Create GitHub release with simple release notes
13. ✅ Release verification

### 2. Manual Release (`release.yml`) - **Alternative Method**

**Trigger**: GitHub Actions → "Release Packages" → Run workflow

**Options**:

- **Channel**: alpha, dev, beta, latest
- **Branch**: main, develop (default: main)
- **Force**: Override version existence check (default: false)
- **Release Notes**: Custom release notes for GitHub release

**Smart Features**:

- **Auto Branch Detection**: Detects target branch from channel
  - Beta/Alpha/Dev channels → `develop` branch
  - Latest channel → `main` branch

**Process**:

1. ✅ Input validation
2. 🔍 Working directory check
3. 📦 Dependency installation
4. 🔍 Quality checks (typecheck, lint, format)
5. 🏗️ Build packages
6. 🧪 Run tests
7. 🔍 Version existence check (unless forced)
8. 🌿 Checkout appropriate branch (main/develop)
9. 📦 Publish to NPM with specified channel
10. 📤 Push changes to repository
11. 🏷️ Create GitHub release with custom release notes
12. ✅ Release verification

## 🚀 Release Process

### Tag-Based Release Steps

#### 1. **Create and Push Tag**

```bash
# For beta release
git tag v1.0.0-beta.1
git push origin v1.0.0-beta.1

# For stable release
git tag v1.0.0
git push origin v1.0.0
```

#### 2. **Automatic Workflow Execution**

- Workflow automatically detects channel from tag format
- Workflow automatically detects target branch from release type
- Quality checks, build, and tests run automatically
- Package is published to correct npm channel
- GitHub release is created with simple release notes

#### 3. **Verification**

- Check npm registry: `npm view @agglayer/sdk@beta`
- Check GitHub releases page
- Verify package installation: `npm install @agglayer/sdk@beta`

### Manual Release Steps

#### 1. **Trigger Manual Release**

1. Go to GitHub Actions → "Release Packages"
2. Click "Run workflow"
3. Fill in the required fields:
   - **Channel**: Select appropriate channel (beta, alpha, dev, latest)
   - **Branch**: Select target branch (auto-detected based on channel)
   - **Force**: Check if you want to override version existence check
   - **Release Notes**: Enter custom release notes

#### 2. **Workflow Execution**

- Workflow runs quality checks and builds
- Package is published to specified npm channel
- GitHub release is created with your custom release notes

#### 3. **Verification**

- Check npm registry for the published package
- Verify GitHub release was created
- Test package installation

## 📦 Package Management

### Version Bumping

- **Tag Release**: Version is automatically updated to match the Git tag
- **Manual Release**: Uses current version in package.json

### Repository Synchronization

- **Tag Release**: Commits version changes to appropriate branch (main/develop)
- **Manual Release**: Pushes any changes to the target branch

### Release Notes

- **Tag Release**: Uses simple template: `"🚀 Release from tag $TAG_NAME"`
- **Manual Release**: Uses user-provided release notes from workflow input

## 🔧 Development Workflow

### For Beta/Alpha/Dev Releases

1. Work on `develop` branch
2. Create appropriate tag: `v1.0.0-beta.1`
3. Push tag: `git push origin v1.0.0-beta.1`
4. Workflow automatically publishes to `develop` branch and `beta` channel

### For Stable Releases

1. Merge `develop` to `main` branch
2. Create stable tag: `v1.0.0`
3. Push tag: `git push origin v1.0.0`
4. Workflow automatically publishes to `main` branch and `latest` channel

## 🚨 Troubleshooting

### Common Issues

#### 1. **Version Already Exists**

```
Error: You cannot publish over the previously published versions: 1.0.0-beta.1
```

**Solution**: Use a new version number or check the `Force` option in manual release

#### 2. **Tag Doesn't Exist**

```
Error: Tag v1.0.0-beta.1 does not exist
```

**Solution**: Create and push the tag first:

```bash
git tag v1.0.0-beta.1
git push origin v1.0.0-beta.1
```

#### 3. **Quality Checks Fail**

**Solution**: Fix the issues locally first:

```bash
bun run typecheck
bun run lint
bun run test:run
bun run build
```

#### 4. **Permission Denied**

**Solution**: Ensure you have:

- Write access to the repository
- NPM_TOKEN secret configured
- SEMANTIC_RELEASE_BOT_APP_ID and SEMANTIC_RELEASE_BOT_APP_PRIVATE_KEY secrets configured

### Verification Commands

```bash
# Check published package
npm view @agglayer/sdk@beta

# Install and test
npm install @agglayer/sdk@beta

# Check GitHub releases
gh release list
```

## 📚 Additional Resources

- [Semantic Versioning](https://semver.org/)
- [npm Publishing Guide](https://docs.npmjs.com/cli/v8/commands/npm-publish)
- [GitHub Actions Documentation](https://docs.github.com/en/actions)
- [Conventional Commits](https://www.conventionalcommits.org/)

## 🔄 Workflow Status

| Workflow          | Status    | Purpose                    |
| ----------------- | --------- | -------------------------- |
| `tag-release.yml` | ✅ Active | Primary release method     |
| `release.yml`     | ✅ Active | Alternative manual release |
| `test.yml`        | ✅ Active | Quality checks and testing |

---

**Note**: Changelog generation is currently disabled in all workflows. To re-enable, uncomment the changelog-related sections in the workflow files.
