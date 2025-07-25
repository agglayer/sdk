# AggLayer SDK

A TypeScript SDK for interacting with AggLayer.

## Installation

```bash
npm install agglayer-sdk
```

## Usage

```typescript
import { AggLayerSDK } from 'agglayer-sdk';

const sdk = new AggLayerSDK();
```

## Development

### Prerequisites

- Node.js 18+
- npm

### Setup

```bash
npm install
```

### Available Scripts

- `npm run build` - Build the library
- `npm run dev` - Build in watch mode
- `npm run test` - Run tests
- `npm run test:coverage` - Run tests with coverage
- `npm run lint` - Run ESLint
- `npm run lint:fix` - Fix ESLint issues
- `npm run format` - Format code with Prettier
- `npm run typecheck` - Type check with TypeScript

### Code Quality

This project uses:

- **ESLint** for code linting with strict TypeScript rules
- **Prettier** for code formatting
- **Vitest** for testing
- **Husky** for git hooks
- **TypeScript** with strict configuration

### Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Run tests: `npm run test`
5. Run linting: `npm run lint`
6. Submit a pull request

## License

ISC
