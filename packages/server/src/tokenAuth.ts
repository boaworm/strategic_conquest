import crypto from 'node:crypto';

export interface GameTokens {
  adminToken: string;
  p1Token: string;
  p2Token: string;
}

/**
 * Generate a random 4-digit PIN.
 */
function pin4(): string {
  return String(crypto.randomInt(0, 10000)).padStart(4, '0');
}

/**
 * Generate three short PIN tokens for a game.
 */
export function generateTokens(): GameTokens {
  return {
    adminToken: pin4(),
    p1Token: pin4(),
    p2Token: pin4(),
  };
}
