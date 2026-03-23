import net from 'net';
import { 
  createGameState, 
  applyAction, 
  getPlayerView, 
  BasicAgent,
  playerViewToTensor,
  NUM_CHANNELS
} from '@sc/shared';

const UDS_PATH = process.env.UDS_PATH || '/tmp/ai_training.sock';
const MAX_TURNS = 1000;

/**
 * Headless simulator that plays a game vs BasicAgent.
 * When it's the NN's turn, it serializes the state tensor to a Unix Domain Socket 
 * and waits for an action response.
 */
async function runHeadlessGame() {
  console.log(`Connecting to Python training loop at ${UDS_PATH}...`);
  
  const client = net.createConnection({ path: UDS_PATH });

  client.on('connect', async () => {
    console.log('Connected to Python NN!');
    
    // Start game
    const state = createGameState({
      width: 30, // Tiny map size for faster training initially
      height: 10,
    });
    
    const oppAgent = new BasicAgent();
    oppAgent.init({ playerId: 'player2', mapWidth: state.mapWidth, mapHeight: state.mapHeight });

    let msgQueue: Buffer = Buffer.alloc(0);

    const checkWinAndUpdate = () => {
      if (state.winner !== null || state.turn >= MAX_TURNS) {
        console.log(`Game over! Winner: ${state.winner ?? 'Draw (max turns)'}`);
        client.destroy();
        process.exit(0);
      }
    };

    const processOpponentTurn = () => {
      while (state.currentPlayer === 'player2' && state.winner === null && state.turn < MAX_TURNS) {
        const view = getPlayerView(state, 'player2');
        const action = oppAgent.act({ ...view, myPlayerId: 'player2' } as any);
        const res = applyAction(state, action, 'player2');
        
        // If the AI somehow attempts an illegal action, force an END_TURN 
        // to prevent an infinite 100% CPU lock in the while loop.
        if (!res.success) {
          applyAction(state, { type: 'END_TURN' }, 'player2');
        }
      }
      checkWinAndUpdate();
    };

    const promptNNTurn = () => {
      if (state.currentPlayer === 'player1') {
        const view = getPlayerView(state, 'player1');
        
        // Convert to tensor buffer [15, H, W]
        const tensorArray = playerViewToTensor(view);
        // We'll send the raw byte buffer over the socket 
        // Python expects a header (size/types) but for now let's just send the raw bytes
        // In a real implementation we'd probably frame this with a 4-byte length prefix
        const bytes = Buffer.from(tensorArray.buffer);
        
        // 4-byte length prefix
        const header = Buffer.alloc(4);
        header.writeUInt32LE(bytes.byteLength, 0);
        
        client.write(Buffer.concat([header, bytes]));
      }
    };

    // Handle responses from Python (the action)
    client.on('data', (data) => {
      // In reality, this needs a proper framing protocol where we read chunks 
      // until we have a full JSON or protobuf message.
      msgQueue = Buffer.concat([msgQueue, Buffer.isBuffer(data) ? data : Buffer.from(data)]);
      
      // Let's assume Python sends back simple JSON strings separated by \n for the action
      // Like {"type":"MOVE","unitId":"...","to":{"x":1,"y":2}}\n
      let newlineIdx;
      while ((newlineIdx = msgQueue.indexOf('\n')) !== -1) {
        const msgStr = msgQueue.slice(0, newlineIdx).toString('utf-8');
        msgQueue = msgQueue.slice(newlineIdx + 1);
        
        try {
          const action = JSON.parse(msgStr);
          if (action.type) {
            applyAction(state, action, 'player1');
            checkWinAndUpdate();
            
            // If it's still player1's turn, prompt again. If it flipped to player2, run their turn.
            if (state.currentPlayer === 'player1') {
              promptNNTurn();
            } else {
              processOpponentTurn();
              promptNNTurn();
            }
          }
        } catch (e) {
          console.error("Failed to parse action from Python:", msgStr, e);
        }
      }
    });

    // Kickoff the first turn
    if (state.currentPlayer === 'player1') {
      promptNNTurn();
    } else {
      processOpponentTurn();
      promptNNTurn();
    }
  });

  client.on('error', (err) => {
    console.error(`Socket error: ${err.message}. Is the Python script listening on ${UDS_PATH}?`);
    process.exit(1);
  });
}

runHeadlessGame();
