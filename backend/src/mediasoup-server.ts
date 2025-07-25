import * as mediasoup from 'mediasoup';
import { Worker, Router, WebRtcTransport, Producer, Consumer, RtpCodecCapability } from 'mediasoup/node/lib/types';

// Types first (very TypeScript-idiomatic)
interface MediasoupState {
  worker: Worker | null;
  router: Router | null;
  transports: Map<string, WebRtcTransport>;
  producers: Map<string, Producer>;
  consumers: Map<string, Consumer>;
}

interface TransportInfo {
  id: string;
  iceParameters: any;
  iceCandidates: any;
  dtlsParameters: any;
}

interface ConsumerInfo {
  id: string;
  kind: string;
  rtpParameters: any;
}

// Media codecs configuration
const MEDIA_CODECS: RtpCodecCapability[] = [
  {
    kind: 'audio',
    mimeType: 'audio/opus',
    clockRate: 48000,
    channels: 2,
  },
  {
    kind: 'video',
    mimeType: 'video/VP8',
    clockRate: 90000,
    parameters: { 'x-google-start-bitrate': 1000 },
  },
  {
    kind: 'video',
    mimeType: 'video/VP9',
    clockRate: 90000,
    parameters: { 'profile-id': 2 },
  },
  {
    kind: 'video',
    mimeType: 'video/h264',
    clockRate: 90000,
    parameters: {
      'packetization-mode': 1,
      'profile-level-id': '4d0032',
      'level-asymmetry-allowed': 1,
    },
  },
] as const;

// Factory function to create mediasoup server
export const createMediasoupServer = () => {
  const state: MediasoupState = {
    worker: null,
    router: null,
    transports: new Map(),
    producers: new Map(),
    consumers: new Map(),
  };

  // Initialize mediasoup
  const init = async (): Promise<void> => {
    try {
      state.worker = await mediasoup.createWorker({
        logLevel: 'warn',
        rtcMinPort: 10000,
        rtcMaxPort: 10100,
      });

      console.log('🚀 Mediasoup worker created');

      state.worker.on('died', (error) => {
        console.error('💀 Mediasoup worker died:', error);
        setTimeout(() => process.exit(1), 2000);
      });

      state.router = await state.worker.createRouter({ 
        mediaCodecs: MEDIA_CODECS 
      });
      
      console.log('🎯 Mediasoup router created');
    } catch (error) {
      console.error('❌ Failed to initialize Mediasoup:', error);
      throw error;
    }
  };

  // Create WebRTC transport
  const createWebRtcTransport = async (clientId: string): Promise<TransportInfo> => {
    if (!state.router) throw new Error('Router not initialized');

    const transport = await state.router.createWebRtcTransport({
      listenIps: [{ ip: '127.0.0.1', announcedIp: undefined }],
      enableUdp: true,
      enableTcp: true,
      preferUdp: true,
    });

    // Set up transport cleanup
    transport.on('dtlsstatechange', (dtlsState) => {
      if (dtlsState === 'closed') {
        transport.close();
        state.transports.delete(clientId);
      }
    });

    state.transports.set(clientId, transport);

    return {
      id: transport.id,
      iceParameters: transport.iceParameters,
      iceCandidates: transport.iceCandidates,
      dtlsParameters: transport.dtlsParameters,
    };
  };

  // Connect transport
  const connectTransport = async (clientId: string, dtlsParameters: any): Promise<void> => {
    const transport = state.transports.get(clientId);
    if (!transport) throw new Error(`Transport not found for client: ${clientId}`);
    
    await transport.connect({ dtlsParameters });
  };

  // Create producer
  const createProducer = async (
    clientId: string, 
    rtpParameters: any, 
    kind: 'audio' | 'video'
  ): Promise<string> => {
    const transport = state.transports.get(clientId);
    if (!transport) throw new Error(`Transport not found for client: ${clientId}`);

    const producer = await transport.produce({ kind, rtpParameters });
    
    // Auto-cleanup on transport close
    producer.on('transportclose', () => {
      console.log(`🔌 Producer ${producer.id} closed due to transport close`);
      state.producers.delete(producer.id);
    });

    state.producers.set(producer.id, producer);
    return producer.id;
  };

  // Create consumer
  const createConsumer = async (
    clientId: string, 
    producerId: string, 
    rtpCapabilities: any
  ): Promise<ConsumerInfo | null> => {
    if (!state.router) throw new Error('Router not initialized');

    const transport = state.transports.get(clientId);
    const producer = state.producers.get(producerId);
    
    if (!transport) throw new Error(`Transport not found for client: ${clientId}`);
    if (!producer) throw new Error(`Producer not found: ${producerId}`);

    if (!state.router.canConsume({ producerId, rtpCapabilities })) {
      console.log(`❌ Cannot consume producer ${producerId}`);
      return null;
    }

    const consumer = await transport.consume({
      producerId,
      rtpCapabilities,
      paused: true,
    });

    // Auto-cleanup
    consumer.on('transportclose', () => {
      console.log(`🔌 Consumer ${consumer.id} closed due to transport close`);
      state.consumers.delete(consumer.id);
    });

    state.consumers.set(consumer.id, consumer);

    return {
      id: consumer.id,
      kind: consumer.kind,
      rtpParameters: consumer.rtpParameters,
    };
  };

  // Resume consumer
  const resumeConsumer = async (consumerId: string): Promise<void> => {
    const consumer = state.consumers.get(consumerId);
    if (!consumer) throw new Error(`Consumer not found: ${consumerId}`);
    
    await consumer.resume();
  };

  // Get router capabilities
  const getRouterRtpCapabilities = () => {
    if (!state.router) throw new Error('Router not initialized');
    return state.router.rtpCapabilities;
  };

  // Get all producers (for HLS transcoding)
  const getAllProducers = (): Producer[] => Array.from(state.producers.values());

  // Get specific producer
  const getProducer = (producerId: string): Producer | undefined => 
    state.producers.get(producerId);

  // Cleanup client resources
  const cleanupClient = (clientId: string): void => {
    const transport = state.transports.get(clientId);
    if (transport) {
      transport.close();
      state.transports.delete(clientId);
      console.log(`🧹 Cleaned up client: ${clientId}`);
    }
  };

  // Return public API (composition over inheritance)
  return {
    init,
    createWebRtcTransport,
    connectTransport,
    createProducer,
    createConsumer,
    resumeConsumer,
    getRouterRtpCapabilities,
    getAllProducers,
    getProducer,
    cleanupClient,
  } as const;
};

// Export type for the server instance
export type MediasoupServer = ReturnType<typeof createMediasoupServer>;