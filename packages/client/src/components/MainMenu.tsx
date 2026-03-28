import { useState, useEffect } from 'react';
import { useGameStore } from '../store/gameStore';
import type { CreateGameResponse } from '@sc/shared';

function QuickstartGuide() {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <div className="mt-6 border-t border-gray-700 pt-4">
      <button
        className="text-sm text-blue-400 hover:text-blue-300 underline"
        onClick={() => setIsOpen(!isOpen)}
      >
        {isOpen ? 'Hide' : 'Show'} Quickstart Guide
      </button>
      {isOpen && (
        <div className="mt-4 p-4 bg-gray-900 rounded text-sm text-gray-300 space-y-2">
          <h3 className="font-bold text-white mb-2">How to Play</h3>
          <ul className="space-y-1 list-disc pl-5">
            <li><strong>Right-click/drag</strong> to pan the map</li>
            <li><strong>Left click</strong> to select a unit or city</li>
            <li><strong>Left-shift-click</strong> to cycle through units/cities on the same spot</li>
            <li><strong>Left-click</strong> on a unit or city in the right menu to select them</li>
          </ul>
          <div className="mt-3 pt-3 border-t border-gray-700">
            <p className="font-bold text-white mb-1">Unit Actions</p>
            <ul className="space-y-1 list-disc pl-5">
              <li>Select a unit to see its move range (highlighted tiles)</li>
              <li>Click a highlighted tile to move the unit</li>
              <li>Select an adjacent enemy to attack</li>
              <li>Click "End Turn" when ready for the opponent</li>
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}

const WORLD_SIZES = [
  { label: 'Tiny', width: 30, height: 10 },
  { label: 'Small', width: 50, height: 20 },
  { label: 'Medium', width: 65, height: 25 },
  { label: 'Large', width: 80, height: 30 },
  { label: 'Extra Large', width: 120, height: 40 },
] as const;

const AI_PLAYERS = [
  { label: 'Basic (Greedy)', value: 'basic', description: 'Aggressive expansion and combat' },
] as const;

export function MainMenu({ onViewReplay }: { onViewReplay?: () => void }) {
  const createGame = useGameStore((s) => s.createGame);
  const joinGame = useGameStore((s) => s.joinGame);
  const storeError = useGameStore((s) => s.error);
  const connected = useGameStore((s) => s.connected);

  const [mode, setMode] = useState<'menu' | 'create' | 'join' | 'ai-select'>('menu');
  const [tokenInput, setTokenInput] = useState('');
  const [createdGame, setCreatedGame] = useState<CreateGameResponse | null>(null);
  const [localError, setLocalError] = useState('');
  const [isConnecting, setIsConnecting] = useState(false);
  const [mainWorldSize, setMainWorldSize] = useState(2); // default: Medium
  const [aiPlayer, setAiPlayer] = useState('basic'); // default: Basic

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
      const size = WORLD_SIZES[mainWorldSize];
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
      const size = WORLD_SIZES[mainWorldSize];
      // Map AI player name to type and pass to server
      const aiType = 'ai' as const;
      const result = await createGame(size.width, size.height, 'pve', 'human', aiType, undefined, aiPlayer as 'adam' | 'basic');
      // Automatically join as player 1 (AI joins automatically via server)
      console.log('Created AI game, joining as player 1...');
      joinGame(result.p1Token);
    } catch (e) {
      console.error('Failed to create AI game:', e);
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
        <p className="text-gray-300 text-sm">Select your AI opponent</p>
        {error && <p className="text-red-400">{error}</p>}

        <div className="text-left space-y-2">
          <label className="text-sm text-gray-300 block">World Size (selected)</label>
          <div className="flex gap-2 justify-center flex-wrap">
            {WORLD_SIZES.map((s, i) => (
              <button
                key={s.label}
                className={`px-3 py-1.5 rounded text-sm ${i === mainWorldSize
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                  }`}
                onClick={() => setMainWorldSize(i)}
              >
                {s.label}
                <span className="block text-xs text-gray-400">{s.width}×{s.height}</span>
              </button>
            ))}
          </div>
          <p className="text-xs text-gray-400 mt-1">Map: {WORLD_SIZES[mainWorldSize].width}×{WORLD_SIZES[mainWorldSize].height}</p>
        </div>

        <div className="text-left space-y-2">
          <label className="text-sm text-gray-300 block">AI Opponent</label>
          <div className="flex gap-2 justify-center flex-wrap">
            {AI_PLAYERS.map((ai) => (
              <button
                key={ai.value}
                className={`px-4 py-2 rounded ${ai.value === aiPlayer
                  ? 'bg-purple-600 text-white'
                  : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                  }`}
                onClick={() => setAiPlayer(ai.value)}
              >
                {ai.label}
              </button>
            ))}
          </div>
          <p className="text-xs text-gray-400 mt-1">{AI_PLAYERS.find(a => a.value === aiPlayer)?.description}</p>
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
      <QuickstartGuide />
      <div className="flex flex-col gap-3">
        <div className="text-left space-y-2">
          <label className="text-sm text-gray-300 block">World Size</label>
          <div className="flex gap-2 justify-center flex-wrap">
            {WORLD_SIZES.map((s, i) => (
              <button
                key={s.label}
                className={`px-3 py-1.5 rounded text-sm ${i === mainWorldSize
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                  }`}
                onClick={() => setMainWorldSize(i)}
              >
                {s.label}
                <span className="block text-xs text-gray-400">{s.width}×{s.height}</span>
              </button>
            ))}
          </div>
          <p className="text-xs text-gray-400 mt-1">Selected: {WORLD_SIZES[mainWorldSize].width}×{WORLD_SIZES[mainWorldSize].height}</p>
        </div>
        <button
          className="px-6 py-3 bg-blue-700 rounded-lg text-lg hover:bg-blue-600"
          onClick={handleCreate}
        >
          Create New Game
        </button>
        <button
          className="px-6 py-3 bg-purple-700 rounded-lg text-lg hover:bg-purple-600"
          onClick={() => {
            setMode('ai-select');
          }}
        >
          Play vs AI
        </button>
        <button
          className="px-6 py-3 bg-green-700 rounded-lg text-lg hover:bg-green-600"
          onClick={() => setMode('join')}
        >
          Join Existing Game
        </button>
        {onViewReplay && (
          <button
            className="px-6 py-3 bg-gray-600 rounded-lg text-lg hover:bg-gray-500"
            onClick={onViewReplay}
          >
            View Replay
          </button>
        )}
      </div>
    </div>
  );
}
