'use client';

import { useCallback, useRef, useState } from 'react';
import * as mediasoupClient from 'mediasoup-client';

type ProducerType = 'audio' | 'video';

interface MediaSoupState {
  device: mediasoupClient.types.Device | null;
  sendTransport: mediasoupClient.types.Transport | null;
  recvTransport: mediasoupClient.types.Transport | null;
  producers: Map<ProducerType, mediasoupClient.types.Producer>;
  consumers: Map<string, mediasoupClient.types.Consumer>;
}

export const useMediaSoup = () => {
  const [isInitialized, setIsInitialized] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  const stateRef = useRef<MediaSoupState>({
    device: null,
    sendTransport: null,
    recvTransport: null,
    producers: new Map(),
    consumers: new Map()
  });

  const initializeDevice = useCallback(async (routerRtpCapabilities: any) => {
    try {
      console.log('🎛️ Initializing MediaSoup device...');
      
      const device = new mediasoupClient.Device();
      await device.load({ routerRtpCapabilities });
      
      stateRef.current.device = device;
      setIsInitialized(true);
      setError(null);
      
      console.log('✅ MediaSoup device initialized');
      console.log('📱 Device capabilities:', {
        canProduce: device.canProduce('video'),
        canConsume: device.rtpCapabilities
      });
      
      return device;
    } catch (err) {
      const errorMsg = `Failed to initialize MediaSoup device: ${err}`;
      console.error('❌', errorMsg);
      setError(errorMsg);
      throw err;
    }
  }, []);

  const createSendTransport = useCallback(async (
    transportOptions: any, 
    onConnect: (dtlsParameters: any) => Promise<void>, 
    onProduce: (parameters: any) => Promise<{ id: string }>
  ) => {
    try {
      console.log('🚛 Creating send transport...');
      
      const transport = stateRef.current.device!.createSendTransport(transportOptions);
      
      transport.on('connect', async ({ dtlsParameters }: any, callback: () => void, errback: (error: any) => void) => {
        try {
          await onConnect(dtlsParameters);
          callback();
        } catch (error) {
          errback(error);
        }
      });

      transport.on('produce', async (parameters: any, callback: (params: { id: string }) => void, errback: (error: any) => void) => {
        try {
          const { id } = await onProduce(parameters);
          callback({ id });
        } catch (error) {
          errback(error);
        }
      });

      stateRef.current.sendTransport = transport;
      console.log('✅ Send transport created');
      
      return transport;
    } catch (err) {
      console.error('❌ Failed to create send transport:', err);
      throw err;
    }
  }, []);

  const createRecvTransport = useCallback(async (
    transportOptions: any, 
    onConnect: (dtlsParameters: any) => Promise<void>
  ) => {
    try {
      console.log('📡 Creating receive transport...');
      
      const transport = stateRef.current.device!.createRecvTransport(transportOptions);
      
      transport.on('connect', async ({ dtlsParameters }: any, callback: () => void, errback: (error: any) => void) => {
        try {
          await onConnect(dtlsParameters);
          callback();
        } catch (error) {
          errback(error);
        }
      });

      stateRef.current.recvTransport = transport;
      console.log('✅ Receive transport created');
      
      return transport;
    } catch (err) {
      console.error('❌ Failed to create receive transport:', err);
      throw err;
    }
  }, []);

  const produce = useCallback(async (type: ProducerType, track: MediaStreamTrack) => {
    try {
      console.log(`🎥 Producing ${type}...`);
      
      const producer = await stateRef.current.sendTransport!.produce({ track });
      stateRef.current.producers.set(type, producer);
      
      console.log(`✅ ${type} producer created:`, producer.id);
      return producer;
    } catch (err) {
      console.error(`❌ Failed to produce ${type}:`, err);
      throw err;
    }
  }, []);

  const consume = useCallback(async (consumerOptions: any, peerId: string) => {
    try {
      console.log(`👀 Consuming from peer ${peerId}...`);
      
      const consumer = await stateRef.current.recvTransport!.consume(consumerOptions);
      stateRef.current.consumers.set(peerId, consumer);
      
      console.log(`✅ Consumer created for peer ${peerId}:`, consumer.id);
      return consumer;
    } catch (err) {
      console.error(`❌ Failed to consume from peer ${peerId}:`, err);
      throw err;
    }
  }, []);

  const getDevice = useCallback(() => stateRef.current.device, []);
  const getProducers = useCallback(() => stateRef.current.producers, []);
  const getConsumers = useCallback(() => stateRef.current.consumers, []);

  const cleanup = useCallback(() => {
    console.log('🧹 Cleaning up MediaSoup...');
    
    // Close all producers
    stateRef.current.producers.forEach(producer => producer.close());
    stateRef.current.producers.clear();
    
    // Close all consumers
    stateRef.current.consumers.forEach(consumer => consumer.close());
    stateRef.current.consumers.clear();
    
    // Close transports
    stateRef.current.sendTransport?.close();
    stateRef.current.recvTransport?.close();
    
    // Reset state
    stateRef.current = {
      device: null,
      sendTransport: null,
      recvTransport: null,
      producers: new Map(),
      consumers: new Map()
    };
    
    setIsInitialized(false);
  }, []);

  return {
    isInitialized,
    error,
    initializeDevice,
    createSendTransport,
    createRecvTransport,
    produce,
    consume,
    getDevice,
    getProducers,
    getConsumers,
    cleanup
  };
};