'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useWebSocket } from './useWebSocket';
import { useMediaSoup } from './useMediaSoup';
import { useMediaStream } from './useMediaStream';

interface RemotePeer {
    id: string;
    stream?: MediaStream;
    videoElement?: HTMLVideoElement;
}
interface StreamingConfig {
    role: 'streamer' | 'viewer';
    sessionId?: string;
}

const WS_URL = 'ws://localhost:3001';
const API_BASE = 'http://localhost:3001/api';

export const useStreaming = (config: StreamingConfig) => {
    const [isJoined, setIsJoined] = useState(false);
    const [remotePeers, setRemotePeers] = useState<Map<string, RemotePeer>>(new Map());
    const [error, setError] = useState<string | null>(null);
    const [isLoading, setIsLoading] = useState(false);

    const localVideoRef = useRef<HTMLVideoElement>(null);
    const remoteVideoRefs = useRef<Map<string, HTMLVideoElement>>(new Map());

    const ws = useWebSocket(WS_URL);
    const mediaSoup = useMediaSoup();
    const mediaStream = useMediaStream();

    // Get router capabilities and initialize device
    const initializeMediaSoup = useCallback(async () => {
        try {
            console.log('🚀 Initializing MediaSoup...');

            const response = await fetch(`${API_BASE}/mediasoup/router-capabilities`);
            if (!response.ok) throw new Error('Failed to get router capabilities');

            const { routerRtpCapabilities } = await response.json();
            await mediaSoup.initializeDevice(routerRtpCapabilities);

            console.log('✅ MediaSoup initialized');
        } catch (err) {
            console.error('❌ Failed to initialize MediaSoup:', err);
            setError('Failed to initialize streaming');
            throw err;
        }
    }, [mediaSoup]);

    // Handle transport creation
    const handleCreateTransport = useCallback(async (data: any) => {
        try {
            const { transportOptions, direction } = data;

            if (direction === 'send') {
                const onConnect = async (dtlsParameters: any) => {
                    ws.send({
                        type: 'connect-transport',
                        transportId: transportOptions.id,
                        dtlsParameters
                    });
                };
                const onProduce = async (parameters: any): Promise<{ id: string }> => {
                    return new Promise((resolve) => {
                        ws.send({
                            type: 'create-producer',
                            transportId: transportOptions.id,
                            kind: parameters.kind,
                            rtpParameters: parameters.rtpParameters
                        });

                        const unsubscribe = ws.subscribe('producer-created', (msg) => {
                            if (msg.transportId === transportOptions.id) {
                                unsubscribe();
                                resolve({ id: msg.producerId });
                            }
                        });
                    });
                };

                await mediaSoup.createSendTransport(transportOptions, onConnect, onProduce);
            } else {
                const onConnect = async (dtlsParameters: any) => {
                    ws.send({
                        type: 'connect-transport',
                        transportId: transportOptions.id,
                        dtlsParameters
                    });
                };

                await mediaSoup.createRecvTransport(transportOptions, onConnect);
            }
        } catch (err) {
            console.error('❌ Failed to create transport:', err);
            setError('Failed to create transport');
        }
    }, [ws, mediaSoup]);

    // Handle new producer (from remote peer)
    const handleNewProducer = useCallback(async (data: any) => {
        try {
            const { producerId, peerId, kind } = data;

            console.log(`👀 New ${kind} producer from peer ${peerId}`);

            // Request to consume this producer
            ws.send({
                type: 'create-consumer',
                producerId,
                rtpCapabilities: mediaSoup.getDevice()?.rtpCapabilities
            });

        } catch (err) {
            console.error('❌ Failed to handle new producer:', err);
        }
    }, [ws, mediaSoup]);

    // Handle consumer creation
    const handleCreateConsumer = useCallback(async (data: any) => {
        try {
            const { consumerOptions, peerId } = data;

            console.log(`🎬 Creating consumer for peer ${peerId}`);

            const consumer = await mediaSoup.consume(consumerOptions, peerId);

            // Resume the consumer
            ws.send({
                type: 'resume-consumer',
                consumerId: consumer.id
            });

            // Create stream from consumer track
            const stream = new MediaStream([consumer.track]);

            setRemotePeers(prev => {
                const newPeers = new Map(prev);
                const existingPeer = newPeers.get(peerId);
                const peer: RemotePeer = existingPeer || { id: peerId };
                peer.stream = stream;
                newPeers.set(peerId, peer);
                return newPeers;
            });

        } catch (err) {
            console.error('❌ Failed to create consumer:', err);
        }
    }, [ws, mediaSoup]);

    // Join as streamer
    const joinAsStreamer = useCallback(async () => {
        try {
            setIsLoading(true);
            setError(null);

            console.log('🎭 Joining as streamer...');

            // Initialize MediaSoup
            await initializeMediaSoup();

            // Start media stream
            await mediaStream.startStream({ video: true, audio: true });

            // Join the session
            ws.send({ type: 'join-as-streamer' });

            setIsJoined(true);
            console.log('✅ Joined as streamer');

        } catch (err) {
            console.error('❌ Failed to join as streamer:', err);
            setError('Failed to join streaming session');
        } finally {
            setIsLoading(false);
        }
    }, [ws, mediaSoup, mediaStream, initializeMediaSoup]);

    // Join as viewer
    const joinAsViewer = useCallback(async () => {
        try {
            setIsLoading(true);
            setError(null);

            console.log('👀 Joining as viewer...');

            // Initialize MediaSoup
            await initializeMediaSoup();

            // Join the session
            ws.send({ type: 'join-as-viewer' });

            setIsJoined(true);
            console.log('✅ Joined as viewer');

        } catch (err) {
            console.error('❌ Failed to join as viewer:', err);
            setError('Failed to join viewing session');
        } finally {
            setIsLoading(false);
        }
    }, [ws, mediaSoup, initializeMediaSoup]);

    // Start producing media
    const startProducing = useCallback(async () => {
        try {
            if (!mediaStream.stream) {
                throw new Error('No media stream available');
            }

            console.log('🎬 Starting to produce media...');

            const videoTrack = mediaStream.getVideoTrack();
            const audioTrack = mediaStream.getAudioTrack();

            if (videoTrack) {
                await mediaSoup.produce('video', videoTrack);
            }

            if (audioTrack) {
                await mediaSoup.produce('audio', audioTrack);
            }

            console.log('✅ Started producing media');
        } catch (err) {
            console.error('❌ Failed to start producing:', err);
            setError('Failed to start producing media');
        }
    }, [mediaStream, mediaSoup]);

    // Set up WebSocket message handlers
    useEffect(() => {
        if (!ws.isConnected) return;

        const unsubscribes = [
            ws.subscribe('transport-created', handleCreateTransport),
            ws.subscribe('new-producer', handleNewProducer),
            ws.subscribe('consumer-created', handleCreateConsumer),
            ws.subscribe('joined', (data) => {
                console.log('🎉 Successfully joined:', data);
                if (config.role === 'streamer') {
                    // Request transports after joining
                    ws.send({ type: 'create-transport', direction: 'send' });
                    ws.send({ type: 'create-transport', direction: 'recv' });
                } else {
                    ws.send({ type: 'create-transport', direction: 'recv' });
                }
            }),
            ws.subscribe('transports-ready', () => {
                if (config.role === 'streamer') {
                    startProducing();
                }
            })
        ];

        return () => {
            unsubscribes.forEach(unsub => unsub());
        };
    }, [ws.isConnected, handleCreateTransport, handleNewProducer, handleCreateConsumer, config.role, startProducing]);

    // Update local video element
    useEffect(() => {
        if (localVideoRef.current && mediaStream.stream) {
            localVideoRef.current.srcObject = mediaStream.stream;
        }
    }, [mediaStream.stream]);

    // Update remote video elements
    useEffect(() => {
        remotePeers.forEach((peer, peerId) => {
            const videoElement = remoteVideoRefs.current.get(peerId);
            if (videoElement && peer.stream) {
                videoElement.srcObject = peer.stream;
            }
        });
    }, [remotePeers]);

    const cleanup = useCallback(() => {
        console.log('🧹 Cleaning up streaming...');

        mediaStream.stopStream();
        mediaSoup.cleanup();
        ws.disconnect();

        setIsJoined(false);
        setRemotePeers(new Map());
        setError(null);
    }, [mediaStream, mediaSoup, ws]);

    return {
        // State
        isJoined,
        remotePeers,
        error,
        isLoading,
        isConnected: ws.isConnected,

        // Media stream controls
        streamState: mediaStream.streamState,
        devices: mediaStream.devices,

        // Actions
        joinAsStreamer,
        joinAsViewer,
        cleanup,
        toggleVideo: mediaStream.toggleVideo,
        toggleAudio: mediaStream.toggleAudio,
        switchCamera: mediaStream.switchCamera,

        // Refs for video elements
        localVideoRef,
        remoteVideoRefs
    };
};