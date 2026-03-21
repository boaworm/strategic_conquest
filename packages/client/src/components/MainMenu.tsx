import { useState, useEffect } from 'react';
import { useGameStore } from '../store/gameStore';
import type { CreateGameResponse } from '@sc/shared';

const WORLD_SIZES = [
  { label: 'Tiny', width: 30, height: 10 },
  { label: 'Small', width: 50, height: 20 },
  { label: 'Medium', width: 65, height: 25 },
  { label: 'Large', width: 80, height: 30 },
  { label: 'Extra Large', width: 120, height: 40 },
] as const;

const AI_DIFFICULTIES = [
  { label: 'Easy', value: 'easy' },
  { label: 'Medium', value: 'medium' },
  { label: 'Hard', value: 'hard' },
] as const;

export function MainMenu() {
  const createGame = useGameStore((s) => s.createGame);
  const joinGame = useGameStore((s) => s.joinGame);
  const storeError = useGameStore((s) => s.error);
  const connected = useGameStore((s) => s.connected);

  const [mode, setMode] = useState<'menu' | 'create' | 'join' | 'ai-select'>('menu');
  const [tokenInput, setTokenInput] = useState('');
  const [createdGame, setCreatedGame] = useState<CreateGameResponse | null>(null);
  const [localError, setLocalError] = useState('');
  const [isConnecting, setIsConnecting] = useState(false);
  const [worldSize, setWorldSize] = useState(2); // default: Medium
  const [aiDifficulty, setAiDifficulty] = useState('medium'); // default: Medium

  const error = localError || storeError;

  // Reset connecting state if error occurs or if we finish connecting
  useEffect(() => {
    if (error || connected) {
      setIsConnecting(false);
    }
  }, [error, connected]);

  async function handleCreate() {
    try {
      setLocalError('');
      const size = WORLD_SIZES[worldSize];
      const result = await createGame(size.width, size.height, 'pvp');
      setCreatedGame(result);
      setMode('create');
    } catch {
      setLocalError('Failed to create game');
    }
  }

  async function handleCreateAI() {
    try {
      setLocalError('');
      const size = WORLD_SIZES[worldSize];
      const result = await createGame(size.width, size.height, 'pve', aiDifficulty);
      setCreatedGame(result);
      setMode('create');
    } catch {
      setLocalError('Failed to create game');
    }
  }

  function handleJoin() {
    const token = tokenInput.trim();
    if (!token) return;
    setLocalError('');
    setIsConnecting(true);
    joinGame(token);
  }

  function joinAsPlayer(token: string) {
    setLocalError('');
    setIsConnecting(true);
    joinGame(token);
  }

  if (mode === 'create' && createdGame) {
    return (
      <div className="max-w-lg mx-auto mt-20 bg-gray-800 text-white rounded-lg p-6 space-y-4">
        <h2 className="text-xl font-bold">Game Created!</h2>
        <p className="text-gray-300 text-sm">Share tokens with players. Keep admin token safe.</p>
        <div className="space-y-2 text-sm font-mono">
          <div>
            <span className="text-gray-400">Game ID: </span>
            <span className="select-all">{createdGame.gameId}</span>
          </div>
          <div>
            <span className="text-gray-400">Admin Token: </span>
            <span className="select-all">{createdGame.adminToken}</span>
          </div>
          <div>
            <span className="text-gray-400">Player 1 Token: </span>
            <span className="select-all text-blue-400">{createdGame.p1Token}</span>
          </div>
          <div>
            <span className="text-gray-400">Player 2 Token: </span>
            <span className="select-all text-red-400">{createdGame.p2Token}</span>
          </div>
        </div>
        <div className="flex gap-2 pt-2">
          <button
            className="px-4 py-2 bg-blue-700 rounded hover:bg-blue-600"
            onClick={() => joinAsPlayer(createdGame.p1Token)}
          >
            Join as Player 1
          </button>
          <button
            className="px-4 py-2 bg-red-700 rounded hover:bg-red-600"
            onClick={() => joinAsPlayer(createdGame.p2Token)}
          >
            Join as Player 2
          </button>
        </div>
      </div>
    );
  }

  if (mode === 'join') {
    return (
      <div className="max-w-lg mx-auto mt-20 bg-gray-800 text-white rounded-lg p-6 space-y-4">
        <h2 className="text-xl font-bold">Join Game</h2>
        <input
          className="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-sm font-mono"
          placeholder="Paste your player token here..."
          value={tokenInput}
          onChange={(e) => setTokenInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleJoin()}
        />
        <div className="flex gap-2">
          <button
            className="px-4 py-2 bg-green-700 rounded hover:bg-green-600 disabled:opacity-50"
            onClick={handleJoin}
            disabled={isConnecting}
          >
            {isConnecting ? 'Connecting...' : 'Connect'}
          </button>
          <button
            className="px-4 py-2 bg-gray-600 rounded hover:bg-gray-500"
            onClick={() => setMode('menu')}
          >
            Back
          </button>
        </div>
      </div>
    );
  }

  if (mode === 'ai-select') {
    return (
      <div className="max-w-lg mx-auto mt-20 bg-gray-800 text-white rounded-lg p-6 space-y-6">
        <h2 className="text-xl font-bold">Play vs AI</h2>
        <p className="text-gray-300 text-sm">Select difficulty level</p>
        {error && <p className="text-red-400">{error}</p>}

        <div className="text-left space-y-2">
          <label className="text-sm text-gray-300 block">World Size</label>
          <div className="flex gap-2 justify-center flex-wrap">
            {WORLD_SIZES.map((s, i) => (
              <button
                key={s.label}
                className={`px-3 py-1.5 rounded text-sm ${i === worldSize
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                  }`}
                onClick={() => setWorldSize(i)}
              >
                {s.label}
                <span className="block text-xs text-gray-400">{s.width}×{s.height}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="text-left space-y-2">
          <label className="text-sm text-gray-300 block">AI Difficulty</label>
          <div className="flex gap-2 justify-center">
            {AI_DIFFICULTIES.map((diff) => (
              <button
                key={diff.value}
                className={`px-4 py-2 rounded ${diff.value === aiDifficulty
                  ? 'bg-purple-600 text-white'
                  : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                  }`}
                onClick={() => setAiDifficulty(diff.value)}
              >
                {diff.label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-col gap-3">
          <button
            className="px-6 py-3 bg-purple-700 rounded-lg text-lg hover:bg-purple-600"
            onClick={handleCreateAI}
          >
            Start Game vs AI
          </button>
          <button
            className="px-4 py-2 bg-gray-600 rounded hover:bg-gray-500"
            onClick={() => setMode('menu')}
          >
            Back
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-lg mx-auto mt-20 bg-gray-800 text-white rounded-lg p-6 space-y-6 text-center">
      <h1 className="text-3xl font-bold">Strategic Conquest</h1>
      <p className="text-gray-400">A classic turn-based wargame</p>
      {error && <p className="text-red-400">{error}</p>}
      <div className="flex flex-col gap-3">
        <div className="text-left space-y-2">
          <label className="text-sm text-gray-300 block">World Size</label>
          <div className="flex gap-2 justify-center flex-wrap">
            {WORLD_SIZES.map((s, i) => (
              <button
                key={s.label}
                className={`px-3 py-1.5 rounded text-sm ${i === worldSize
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                  }`}
                onClick={() => setWorldSize(i)}
              >
                {s.label}
                <span className="block text-xs text-gray-400">{s.width}×{s.height}</span>
              </button>
            ))}
          </div>
        </div>
        <button
          className="px-6 py-3 bg-blue-700 rounded-lg text-lg hover:bg-blue-600"
          onClick={handleCreate}
        >
          Create New Game
        </button>
        <button
          className="px-6 py-3 bg-purple-700 rounded-lg text-lg hover:bg-purple-600"
          onClick={() => setMode('ai-select')}
        >
          Play vs AI
        </button>
        <button
          className="px-6 py-3 bg-green-700 rounded-lg text-lg hover:bg-green-600"
          onClick={() => setMode('join')}
        >
          Join Existing Game
        </button>
      </div>
    </div>
  );
}
