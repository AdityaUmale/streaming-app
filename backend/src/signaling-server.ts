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
    producers: Set<string>; // Track producer IDs for this client
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
    producers: Map<string, { producerId: string; clientId: string; kind: string }>; // Track all producers
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
        producers: new Map(), // NEW: Track all producers globally
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
            producers: new Set(), // NEW: Track this client's producers
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
    //   function handleMessage(clientId: string, message: WebSocketMessage): void {
    //     const handler = messageHandlers[message.type as keyof typeof messageHandlers];

    //     if (handler) {
    //       handler(clientId, message.data || {});
    //     } else {
    //       console.log(`❓ Unknown message type: ${message.type} from ${clientId}`);
    //       sendToClient(clientId, {
    //         type: MESSAGE_TYPES.ERROR,
    //         data: { message: `Unknown message type: ${message.type}` }
    //       });
    //     }
    //   }

    // FIXED: Enhanced streamer join handler
    async function handleJoinAsStreamer(clientId: string, data: any): Promise<void> {
        const client = state.clients.get(clientId);
        if (!client) return;

        client.type = 'streamer';
        console.log(`🎥 ${clientId} joined as streamer`);

        // Send join confirmation
        sendToClient(clientId, {
            type: MESSAGE_TYPES.JOINED,
            data: { clientId, role: 'streamer' }
        });

        // CRITICAL FIX: Notify the new streamer about existing producers
        console.log(`📢 Notifying ${clientId} about ${state.producers.size} existing producers`);
        for (const [producerId, producerInfo] of state.producers) {
            if (producerInfo.clientId !== clientId) { // Don't notify about own producers
                console.log(`📡 Sending existing producer ${producerId} to new streamer ${clientId}`);
                sendToClient(clientId, {
                    type: MESSAGE_TYPES.NEW_PRODUCER,
                    data: {
                        producerId,
                        peerId: producerInfo.clientId,
                        kind: producerInfo.kind
                    }
                });
            }
        }

        // CRITICAL FIX: Notify existing streamers about the new client
        console.log(`📢 Notifying existing streamers about new streamer ${clientId}`);
        broadcastToStreamers({
            type: MESSAGE_TYPES.NEW_PRODUCER,
            data: { streamerId: clientId, peerId: clientId }
        }, clientId);

        // CRITICAL FIX: Notify the new streamer about existing producers
        console.log(`📢 Notifying ${clientId} about ${state.producers.size} existing producers`);
        for (const [producerId, producerInfo] of state.producers) {
            if (producerInfo.clientId !== clientId) { // Don't notify about own producers
                console.log(`📡 Sending existing producer ${producerId} to new streamer ${clientId}`);
                sendToClient(clientId, {
                    type: MESSAGE_TYPES.NEW_PRODUCER,
                    data: {
                        producerId,
                        peerId: producerInfo.clientId,
                        kind: producerInfo.kind
                    }
                });
            }
        }

        // Add a small delay to ensure transports are ready before notifying about producers
        setTimeout(() => {
            console.log(`📢 (Delayed) Notifying ${clientId} about existing producers again`);
            for (const [producerId, producerInfo] of state.producers) {
                if (producerInfo.clientId !== clientId) {
                    sendToClient(clientId, {
                        type: MESSAGE_TYPES.NEW_PRODUCER,
                        data: {
                            producerId,
                            peerId: producerInfo.clientId,
                            kind: producerInfo.kind
                        }
                    });
                }
            }
        }, 1000); // 1 second delay
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

        // CRITICAL FIX: Notify viewer about all existing producers
        console.log(`📢 Notifying viewer ${clientId} about ${state.producers.size} existing producers`);
        for (const [producerId, producerInfo] of state.producers) {
            console.log(`📡 Sending existing producer ${producerId} to viewer ${clientId}`);
            sendToClient(clientId, {
                type: MESSAGE_TYPES.NEW_PRODUCER,
                data: {
                    producerId,
                    peerId: producerInfo.clientId,
                    kind: producerInfo.kind
                }
            });
        }
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

    // FIXED: Handle message structure properly for transport creation
    function handleMessage(clientId: string, message: WebSocketMessage): void {
        const handler = messageHandlers[message.type as keyof typeof messageHandlers];

        if (handler) {
            // SPECIAL CASE: For create-transport, pass the entire message (including direction)
            if (message.type === MESSAGE_TYPES.CREATE_TRANSPORT) {
                handler(clientId, message); // Pass full message, not just data
            } else {
                handler(clientId, message.data || {});
            }
        } else {
            console.log(`❓ Unknown message type: ${message.type} from ${clientId}`);
            sendToClient(clientId, {
                type: MESSAGE_TYPES.ERROR,
                data: { message: `Unknown message type: ${message.type}` }
            });
        }
    }

    async function handleCreateTransport(clientId: string, messageData: any): Promise<void> {
        try {
            console.log(`🚛 Backend: Creating transport for client ${clientId}`);
            console.log(`🚛 Backend: Full message:`, messageData);

            // FIXED: Extract direction from the message level, not data level
            const direction = messageData.direction || messageData.data?.direction;
            console.log(`🚛 Backend: Direction:`, direction);

            const transportInfo = await state.mediasoupServer.createWebRtcTransport(clientId);

            console.log(`🚛 Backend: Created transport info:`, transportInfo);

            const responseData = {
                transportOptions: transportInfo,
                direction: direction // Now properly preserved
            };

            console.log(`🚛 Backend: Sending response:`, responseData);

            sendToClient(clientId, {
                type: MESSAGE_TYPES.TRANSPORT_CREATED,
                data: responseData
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
        console.log(`🔗 Backend: Connecting transport for client ${clientId}`);
        console.log(`🔗 Backend: Connect data:`, data);
        
        // Add validation for dtlsParameters
        if (!data.dtlsParameters) {
            console.error('❌ Missing dtlsParameters in connect transport request');
            sendToClient(clientId, {
                type: MESSAGE_TYPES.ERROR,
                data: { message: 'Missing dtlsParameters' }
            });
            return;
        }

        console.log(`🔗 Backend: DTLS Parameters:`, data.dtlsParameters);

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

    // FIXED: Enhanced producer creation handler
    async function handleCreateProducer(clientId: string, data: any): Promise<void> {
    try {
        const { rtpParameters, kind, transportId } = data;
        
        console.log(`🎬 Backend: Creating producer for client ${clientId}`);
        console.log(`🎬 Backend: Producer data:`, { kind, transportId, hasRtpParameters: !!rtpParameters });
        
        // Add validation
        if (!kind) {
            console.error('❌ Missing kind in create producer request');
            sendToClient(clientId, {
                type: MESSAGE_TYPES.ERROR,
                data: { message: 'Missing producer kind' }
            });
            return;
        }

        if (!rtpParameters) {
            console.error('❌ Missing rtpParameters in create producer request');
            sendToClient(clientId, {
                type: MESSAGE_TYPES.ERROR,
                data: { message: 'Missing rtpParameters' }
            });
            return;
        }

        console.log(`🎬 Creating ${kind} producer for client ${clientId}`);
        
        const producerId = await state.mediasoupServer.createProducer(clientId, rtpParameters, kind);
        
        // CRITICAL FIX: Track the producer globally
        state.producers.set(producerId, {
            producerId,
            clientId,
            kind
        });

        // CRITICAL FIX: Track producer for this client
        const client = state.clients.get(clientId);
        if (client) {
            client.producers.add(producerId);
        }

        console.log(`✅ Producer ${producerId} created for client ${clientId}`);
        console.log(`📊 Total producers: ${state.producers.size}`);
        
        // Send confirmation to producer
        sendToClient(clientId, {
            type: MESSAGE_TYPES.PRODUCER_CREATED,
            data: { producerId, transportId }
        });

        // CRITICAL FIX: Notify ALL other clients (both streamers and viewers) about new producer
        console.log(`📢 Broadcasting new producer ${producerId} to all other clients`);
        broadcastToOthers({
            type: MESSAGE_TYPES.NEW_PRODUCER,
            data: { producerId, kind, peerId: clientId }
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
        console.log(`👀 Creating consumer for client ${clientId}, producer ${producerId}`);
        
        // ADD: Verify the producer exists
        const producerInfo = state.producers.get(producerId);
        if (!producerInfo) {
            console.error(`❌ Producer ${producerId} not found in global tracking`);
            sendToClient(clientId, {
                type: MESSAGE_TYPES.ERROR,
                data: { message: `Producer ${producerId} not found` }
            });
            return;
        }
        
        console.log(`✅ Found producer info:`, producerInfo);
        
        const consumerInfo = await state.mediasoupServer.createConsumer(clientId, producerId, rtpCapabilities);
        
        if (consumerInfo) {
            const responseData = {
                ...consumerInfo,
                peerId: producerInfo.clientId
            };
            
            console.log(`✅ Consumer created for client ${clientId}, sending:`, responseData);
            
            sendToClient(clientId, {
                type: MESSAGE_TYPES.CONSUMER_CREATED,
                data: responseData
            });
        } else {
            console.log(`❌ Cannot create consumer for producer ${producerId}`);
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

    // FIXED: Enhanced client disconnection handler
    function handleClientDisconnect(clientId: string): void {
        console.log(`👋 Client disconnected: ${clientId}`);

        const client = state.clients.get(clientId);

        // CRITICAL FIX: Clean up this client's producers from global tracking
        if (client) {
            console.log(`🧹 Cleaning up ${client.producers.size} producers for client ${clientId}`);
            for (const producerId of client.producers) {
                state.producers.delete(producerId);
                console.log(`🗑️ Removed producer ${producerId} from global tracking`);
            }
        }

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
                    handleClientDisconnect(clientId); // FIXED: Proper cleanup
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
        producers: state.producers.size, // NEW: Include producer count
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