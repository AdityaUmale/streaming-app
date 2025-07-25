import { WebSocketServer, WebSocket } from 'ws';
import { Server as HttpServer } from 'http';
import { v4 as uuidv4 } from 'uuid';
import { MediasoupServer } from './mediasoup-server';

// Types first
interface Client {
  id: string;
  ws: WebSocket;
  type: 'streamer' | 'viewer';
  isAlive: boolean;
}

interface WebSocketMessage {
  type: string;
  data?: any;
  clientId?: string;
  from?: string;
}

interface SignalingState {
  wss: WebSocketServer;
  clients: Map<string, Client>;
  mediasoupServer: MediasoupServer;
}

// Message type constants (better than magic strings)
const MESSAGE_TYPES = {
  // Connection
  JOIN_AS_STREAMER: 'join-as-streamer',
  JOIN_AS_VIEWER: 'join-as-viewer',
  JOINED: 'joined',
  CLIENT_DISCONNECTED: 'client-disconnected',
  
  // Mediasoup
  GET_ROUTER_CAPABILITIES: 'get-router-capabilities',
  ROUTER_CAPABILITIES: 'router-capabilities',
  CREATE_TRANSPORT: 'create-transport',
  TRANSPORT_CREATED: 'transport-created',
  CONNECT_TRANSPORT: 'connect-transport',
  TRANSPORT_CONNECTED: 'transport-connected',
  
  // Producers/Consumers
  CREATE_PRODUCER: 'create-producer',
  PRODUCER_CREATED: 'producer-created',
  NEW_PRODUCER: 'new-producer',
  CREATE_CONSUMER: 'create-consumer',
  CONSUMER_CREATED: 'consumer-created',
  RESUME_CONSUMER: 'resume-consumer',
  CONSUMER_RESUMED: 'consumer-resumed',
  
  // WebRTC signaling
  WEBRTC_OFFER: 'webrtc-offer',
  WEBRTC_ANSWER: 'webrtc-answer',
  WEBRTC_ICE_CANDIDATE: 'webrtc-ice-candidate',
  
  // Error handling
  ERROR: 'error',
} as const;

// Factory function for creating signaling server
export const createSignalingServer = (
  httpServer: HttpServer, 
  mediasoupServer: MediasoupServer
) => {
  const state: SignalingState = {
    wss: new WebSocketServer({ server: httpServer }),
    clients: new Map(),
    mediasoupServer,
  };

  // Message handlers (functional approach)
  const messageHandlers = {
    [MESSAGE_TYPES.JOIN_AS_STREAMER]: handleJoinAsStreamer,
    [MESSAGE_TYPES.JOIN_AS_VIEWER]: handleJoinAsViewer,
    [MESSAGE_TYPES.GET_ROUTER_CAPABILITIES]: handleGetRouterCapabilities,
    [MESSAGE_TYPES.CREATE_TRANSPORT]: handleCreateTransport,
    [MESSAGE_TYPES.CONNECT_TRANSPORT]: handleConnectTransport,
    [MESSAGE_TYPES.CREATE_PRODUCER]: handleCreateProducer,
    [MESSAGE_TYPES.CREATE_CONSUMER]: handleCreateConsumer,
    [MESSAGE_TYPES.RESUME_CONSUMER]: handleResumeConsumer,
    [MESSAGE_TYPES.WEBRTC_OFFER]: handleWebRTCOffer,
    [MESSAGE_TYPES.WEBRTC_ANSWER]: handleWebRTCAnswer,
    [MESSAGE_TYPES.WEBRTC_ICE_CANDIDATE]: handleWebRTCIceCandidate,
  };

  // Initialize WebSocket server
  const init = (): void => {
    state.wss.on('connection', handleConnection);
    setupHeartbeat();
    console.log('🔌 Signaling server initialized');
  };

  // Handle new WebSocket connections
  function handleConnection(ws: WebSocket): void {
    const clientId = uuidv4();
    console.log(`👋 New connection: ${clientId}`);

    // Setup client
    const client: Client = {
      id: clientId,
      ws,
      type: 'viewer', // Default, will be updated
      isAlive: true,
    };

    state.clients.set(clientId, client);

    // Message handling
    ws.on('message', (message: string) => {
      try {
        const parsed: WebSocketMessage = JSON.parse(message);
        handleMessage(clientId, parsed);
      } catch (error) {
        console.error('❌ Invalid message from', clientId, error);
        sendToClient(clientId, {
          type: MESSAGE_TYPES.ERROR,
          data: { message: 'Invalid message format' }
        });
      }
    });

    // Connection lifecycle
    ws.on('close', () => handleClientDisconnect(clientId));
    ws.on('pong', () => {
      const client = state.clients.get(clientId);
      if (client) client.isAlive = true;
    });

    // Send initial connection success
    sendToClient(clientId, {
      type: MESSAGE_TYPES.JOINED,
      data: { clientId, message: 'Connected to signaling server' }
    });
  }

  // Route messages to appropriate handlers
  function handleMessage(clientId: string, message: WebSocketMessage): void {
    const handler = messageHandlers[message.type as keyof typeof messageHandlers];
    
    if (handler) {
      handler(clientId, message.data || {});
    } else {
      console.log(`❓ Unknown message type: ${message.type} from ${clientId}`);
      sendToClient(clientId, {
        type: MESSAGE_TYPES.ERROR,
        data: { message: `Unknown message type: ${message.type}` }
      });
    }
  }

  // Message handler functions
  async function handleJoinAsStreamer(clientId: string, data: any): Promise<void> {
    const client = state.clients.get(clientId);
    if (!client) return;

    client.type = 'streamer';
    console.log(`🎥 ${clientId} joined as streamer`);

    sendToClient(clientId, {
      type: MESSAGE_TYPES.JOINED,
      data: { clientId, role: 'streamer' }
    });

    // Notify other streamers about new streamer
    broadcastToStreamers({
      type: MESSAGE_TYPES.NEW_PRODUCER,
      data: { streamerId: clientId }
    }, clientId);
  }

  async function handleJoinAsViewer(clientId: string, data: any): Promise<void> {
    const client = state.clients.get(clientId);
    if (!client) return;

    client.type = 'viewer';
    console.log(`👀 ${clientId} joined as viewer`);

    sendToClient(clientId, {
      type: MESSAGE_TYPES.JOINED,
      data: { clientId, role: 'viewer' }
    });
  }

  async function handleGetRouterCapabilities(clientId: string, data: any): Promise<void> {
    try {
      const capabilities = state.mediasoupServer.getRouterRtpCapabilities();
      sendToClient(clientId, {
        type: MESSAGE_TYPES.ROUTER_CAPABILITIES,
        data: { capabilities }
      });
    } catch (error) {
      console.error('❌ Error getting router capabilities:', error);
      sendToClient(clientId, {
        type: MESSAGE_TYPES.ERROR,
        data: { message: 'Failed to get router capabilities' }
      });
    }
  }

  async function handleCreateTransport(clientId: string, data: any): Promise<void> {
    try {
      const transportInfo = await state.mediasoupServer.createWebRtcTransport(clientId);
      sendToClient(clientId, {
        type: MESSAGE_TYPES.TRANSPORT_CREATED,
        data: transportInfo
      });
    } catch (error) {
      console.error('❌ Error creating transport:', error);
      sendToClient(clientId, {
        type: MESSAGE_TYPES.ERROR,
        data: { message: 'Failed to create transport' }
      });
    }
  }

  async function handleConnectTransport(clientId: string, data: any): Promise<void> {
    try {
      await state.mediasoupServer.connectTransport(clientId, data.dtlsParameters);
      sendToClient(clientId, {
        type: MESSAGE_TYPES.TRANSPORT_CONNECTED,
        data: { success: true }
      });
    } catch (error) {
      console.error('❌ Error connecting transport:', error);
      sendToClient(clientId, {
        type: MESSAGE_TYPES.ERROR,
        data: { message: 'Failed to connect transport' }
      });
    }
  }

  async function handleCreateProducer(clientId: string, data: any): Promise<void> {
    try {
      const { rtpParameters, kind } = data;
      const producerId = await state.mediasoupServer.createProducer(clientId, rtpParameters, kind);
      
      sendToClient(clientId, {
        type: MESSAGE_TYPES.PRODUCER_CREATED,
        data: { producerId }
      });

      // Notify other clients about new producer
      broadcastToOthers({
        type: MESSAGE_TYPES.NEW_PRODUCER,
        data: { producerId, kind, streamerId: clientId }
      }, clientId);

    } catch (error) {
      console.error('❌ Error creating producer:', error);
      sendToClient(clientId, {
        type: MESSAGE_TYPES.ERROR,
        data: { message: 'Failed to create producer' }
      });
    }
  }

  async function handleCreateConsumer(clientId: string, data: any): Promise<void> {
    try {
      const { producerId, rtpCapabilities } = data;
      const consumerInfo = await state.mediasoupServer.createConsumer(clientId, producerId, rtpCapabilities);
      
      if (consumerInfo) {
        sendToClient(clientId, {
          type: MESSAGE_TYPES.CONSUMER_CREATED,
          data: consumerInfo
        });
      } else {
        sendToClient(clientId, {
          type: MESSAGE_TYPES.ERROR,
          data: { message: 'Cannot consume this producer' }
        });
      }
    } catch (error) {
      console.error('❌ Error creating consumer:', error);
      sendToClient(clientId, {
        type: MESSAGE_TYPES.ERROR,
        data: { message: 'Failed to create consumer' }
      });
    }
  }

  async function handleResumeConsumer(clientId: string, data: any): Promise<void> {
    try {
      await state.mediasoupServer.resumeConsumer(data.consumerId);
      sendToClient(clientId, {
        type: MESSAGE_TYPES.CONSUMER_RESUMED,
        data: { consumerId: data.consumerId }
      });
    } catch (error) {
      console.error('❌ Error resuming consumer:', error);
      sendToClient(clientId, {
        type: MESSAGE_TYPES.ERROR,
        data: { message: 'Failed to resume consumer' }
      });
    }
  }

  // WebRTC signaling handlers (relay between streamers)
  function handleWebRTCOffer(clientId: string, data: any): void {
    relayToStreamers({ type: MESSAGE_TYPES.WEBRTC_OFFER, data, from: clientId }, clientId);
  }

  function handleWebRTCAnswer(clientId: string, data: any): void {
    relayToStreamers({ type: MESSAGE_TYPES.WEBRTC_ANSWER, data, from: clientId }, clientId);
  }

  function handleWebRTCIceCandidate(clientId: string, data: any): void {
    relayToStreamers({ type: MESSAGE_TYPES.WEBRTC_ICE_CANDIDATE, data, from: clientId }, clientId);
  }

  // Handle client disconnection
  function handleClientDisconnect(clientId: string): void {
    console.log(`👋 Client disconnected: ${clientId}`);
    
    // Cleanup mediasoup resources
    state.mediasoupServer.cleanupClient(clientId);
    
    // Remove from clients
    state.clients.delete(clientId);
    
    // Notify others
    broadcastToAll({
      type: MESSAGE_TYPES.CLIENT_DISCONNECTED,
      data: { clientId }
    });
  }

  // Utility functions for sending messages
  const sendToClient = (clientId: string, message: WebSocketMessage): void => {
    const client = state.clients.get(clientId);
    if (client && client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(JSON.stringify(message));
    }
  };

  const broadcastToStreamers = (message: WebSocketMessage, excludeClientId?: string): void => {
    for (const [clientId, client] of state.clients) {
      if (client.type === 'streamer' && 
          clientId !== excludeClientId && 
          client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(JSON.stringify(message));
      }
    }
  };

  const broadcastToOthers = (message: WebSocketMessage, excludeClientId: string): void => {
    for (const [clientId, client] of state.clients) {
      if (clientId !== excludeClientId && client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(JSON.stringify(message));
      }
    }
  };

  const broadcastToAll = (message: WebSocketMessage): void => {
    for (const client of state.clients.values()) {
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(JSON.stringify(message));
      }
    }
  };

  const relayToStreamers = (message: WebSocketMessage, excludeClientId: string): void => {
    broadcastToStreamers(message, excludeClientId);
  };

  // Heartbeat to detect dead connections
  const setupHeartbeat = (): void => {
    const interval = setInterval(() => {
      for (const [clientId, client] of state.clients) {
        if (!client.isAlive) {
          console.log(`💀 Terminating dead connection: ${clientId}`);
          client.ws.terminate();
          state.clients.delete(clientId);
          continue;
        }
        
        client.isAlive = false;
        if (client.ws.readyState === WebSocket.OPEN) {
          client.ws.ping();
        }
      }
    }, 30000); // 30 seconds

    // Cleanup on server shutdown
    process.on('SIGINT', () => {
      clearInterval(interval);
    });
  };

  // Get connected clients info
  const getClientsInfo = () => ({
    total: state.clients.size,
    streamers: Array.from(state.clients.values()).filter(c => c.type === 'streamer').length,
    viewers: Array.from(state.clients.values()).filter(c => c.type === 'viewer').length,
  });

  // Public API
  return {
    init,
    getClientsInfo,
    // Expose for testing/debugging
    sendToClient,
    broadcastToAll,
  } as const;
};

export type SignalingServer = ReturnType<typeof createSignalingServer>;