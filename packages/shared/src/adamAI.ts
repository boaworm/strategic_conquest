import {
  type Agent,
  type AgentAction,
  type AgentConfig,
  type AgentObservation,
} from '@sc/shared';

/**
 * Adam - The simplest AI possible.
 * Adam does nothing but end their turn immediately.
 * Useful for testing and as a baseline.
 */
export class AdamAI implements Agent {
  private playerId!: string;
  private mapWidth!: number;
  private mapHeight!: number;

  init(config: AgentConfig): void {
    this.playerId = config.playerId;
    this.mapWidth = config.mapWidth;
    this.mapHeight = config.mapHeight;
  }

  act(_obs: AgentObservation): AgentAction {
    // Adam always ends turn immediately
    return { type: 'END_TURN' };
  }
}
