# Quickstart

## Prerequisites

- Node.js 18+
- npm 9+

## Install

```bash
npm install
```

## Start the server (build + run)

```bash
npm start
```

This builds the shared library and client, then starts the server on **http://localhost:4000**.

## Development mode (auto-rebuild on change)

```bash
npm run dev
```

## Custom port

```bash
npx tsx packages/server/src/index.ts --port 8080
```

## Play a game

1. Open http://localhost:4000
2. Click **Create Game** — you'll receive three tokens (admin, player 1, player 2)
3. Copy the **Player 2 token** and share it with your opponent
4. Both players enter their token and click **Join**
5. Game starts when both players are connected

## Train an AI

```bash
# Quick test run
npx tsx packages/trainer/src/index.ts --pop 20 --gens 10

# Full training
npx tsx packages/trainer/src/index.ts --pop 200 --gens 500 --out champion.json

# See all options
npx tsx packages/trainer/src/index.ts --help
```
