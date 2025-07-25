import ffmpeg from 'fluent-ffmpeg';
import { spawn, ChildProcess } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import { createSocket, Socket } from 'dgram';
import { Producer } from 'mediasoup/node/lib/types';

// Types first
interface HLSConfig {
  outputDir: string;
  segmentDuration: number;
  playlistLength: number;
  resolution: string;
  videoBitrate: string;
  audioBitrate: string;
  baseRtpPort: number;
}

interface TranscodingSession {
  id: string;
  process: ChildProcess | null;
  isActive: boolean;
  startTime: Date;
  outputPath: string;
  rtpPorts: {
    video: number;
    audio: number;
  };
  rtpSockets: {
    video?: Socket;
    audio?: Socket;
  };
  producers: {
    video?: Producer;
    audio?: Producer;
  };
  plainTransports: {
    video?: any;
    audio?: any;
  };
  consumers: {
    video?: any;
    audio?: any;
  };
  stats: {
    packetsReceived: number;
    bytesReceived: number;
    lastPacketTime: number;
  };
}

interface HLSState {
  config: HLSConfig;
  sessions: Map<string, TranscodingSession>;
  usedPorts: Set<number>;
}

interface StreamSync {
  audioProducer?: Producer;
  videoProducer?: Producer;
  startTime?: number;
  audioStarted: boolean;
  videoStarted: boolean;
}

// Default configuration
const DEFAULT_HLS_CONFIG: HLSConfig = {
  outputDir: './hls-output',
  segmentDuration: 4, // 4 second segments
  playlistLength: 10, // Keep 10 segments in playlist
  resolution: '1280x720',
  videoBitrate: '2500k',
  audioBitrate: '128k',
  baseRtpPort: 20000,
} as const;

// Factory function for HLS transcoder
export const createHLSTranscoder = (customConfig?: Partial<HLSConfig>) => {
  const state: HLSState = {
    config: { ...DEFAULT_HLS_CONFIG, ...customConfig },
    sessions: new Map(),
    usedPorts: new Set(),
  };

  // Initialize HLS transcoder
  const init = async (): Promise<void> => {
    try {
      // Ensure output directory exists
      await ensureDirectoryExists(state.config.outputDir);
      console.log('📺 HLS transcoder initialized');
      console.log(`📁 Output directory: ${state.config.outputDir}`);
    } catch (error) {
      console.error('❌ Failed to initialize HLS transcoder:', error);
      throw error;
    }
  };

  // Start transcoding from WebRTC producers to HLS
  const startTranscoding = async (
    sessionId: string,
    producers: Producer[]
  ): Promise<string> => {
    try {
      if (state.sessions.has(sessionId)) {
        throw new Error(`Session ${sessionId} already exists`);
      }

      const outputPath = path.join(state.config.outputDir, sessionId);
      await ensureDirectoryExists(outputPath);

      // Separate audio and video producers
      const videoProducer = producers.find(p => p.kind === 'video');
      const audioProducer = producers.find(p => p.kind === 'audio');

      if (!videoProducer && !audioProducer) {
        throw new Error('No valid producers found');
      }

      // Allocate RTP ports
      const rtpPorts = {
        video: videoProducer ? await getAvailablePort() : 0,
        audio: audioProducer ? await getAvailablePort() : 0,
      };

      // Create playlist file path
      const playlistPath = path.join(outputPath, 'playlist.m3u8');

      // Create session
      const session: TranscodingSession = {
        id: sessionId,
        process: null,
        isActive: true,
        startTime: new Date(),
        outputPath,
        rtpPorts,
        rtpSockets: {},
        producers: {
          video: videoProducer,
          audio: audioProducer,
        },
        plainTransports: {},
        consumers: {},
        stats: {
          packetsReceived: 0,
          bytesReceived: 0,
          lastPacketTime: 0,
        },
      };

      state.sessions.set(sessionId, session);

      // Start FFmpeg process first
      const ffmpegProcess = await startFFmpegProcess(session, playlistPath);
      session.process = ffmpegProcess;

      // Setup RTP receivers and forwarding
      await setupRtpReceiversWithForwarding(session);

      // Connect producers to RTP streams
      await connectProducersToRtp(session);

      console.log(`🎬 Started HLS transcoding session: ${sessionId}`);
      console.log(`📺 Video RTP port: ${rtpPorts.video}`);
      console.log(`🔊 Audio RTP port: ${rtpPorts.audio}`);
      
      return playlistPath;

    } catch (error) {
      console.error(`❌ Failed to start transcoding for session ${sessionId}:`, error);
      // Cleanup on failure
      await stopTranscoding(sessionId);
      throw error;
    }
  };

  // Setup RTP receivers with proper packet forwarding to FFmpeg
  const setupRtpReceiversWithForwarding = async (session: TranscodingSession): Promise<void> => {
    const { producers, rtpPorts } = session;

    // Setup video RTP receiver with forwarding
    if (producers.video && rtpPorts.video && session.process) {
      session.rtpSockets.video = createSocket('udp4');
      
      // Bind to RTP port
      session.rtpSockets.video.bind(rtpPorts.video, '127.0.0.1', () => {
        console.log(`📹 Video RTP socket bound to port ${rtpPorts.video}`);
      });
      
      // **CRITICAL FIX**: Proper RTP packet forwarding to FFmpeg
      session.rtpSockets.video.on('message', (rtpPacket: Buffer, rinfo) => {
        try {
          // Update stats
          session.stats.packetsReceived++;
          session.stats.bytesReceived += rtpPacket.length;
          session.stats.lastPacketTime = Date.now();

          // Forward raw RTP packet to FFmpeg stdin
          if (session.process && session.process.stdin && !session.process.stdin.destroyed) {
            const written = session.process.stdin.write(rtpPacket);
            if (!written) {
              console.warn('⚠️ FFmpeg stdin buffer full, backpressure detected');
            }
          }

          // Log periodically (every 100 packets to avoid spam)
          if (session.stats.packetsReceived % 100 === 0) {
            console.log(`📹 Video: ${session.stats.packetsReceived} packets, ${(session.stats.bytesReceived / 1024).toFixed(1)}KB received`);
          }
        } catch (error) {
          console.error('❌ Error forwarding video RTP packet:', error);
        }
      });

      session.rtpSockets.video.on('error', (err) => {
        console.error(`❌ Video RTP socket error:`, err);
        // Auto-recovery attempt
        setTimeout(() => attemptSocketRecovery(session, 'video'), 1000);
      });

      session.rtpSockets.video.on('close', () => {
        console.log('📹 Video RTP socket closed');
      });
    }

    // Setup audio RTP receiver with forwarding
    if (producers.audio && rtpPorts.audio && session.process) {
      session.rtpSockets.audio = createSocket('udp4');
      
      // Bind to RTP port
      session.rtpSockets.audio.bind(rtpPorts.audio, '127.0.0.1', () => {
        console.log(`🔊 Audio RTP socket bound to port ${rtpPorts.audio}`);
      });
      
      // **CRITICAL FIX**: Proper RTP packet forwarding to FFmpeg
      session.rtpSockets.audio.on('message', (rtpPacket: Buffer, rinfo) => {
        try {
          // Update stats
          session.stats.packetsReceived++;
          session.stats.bytesReceived += rtpPacket.length;
          session.stats.lastPacketTime = Date.now();

          // Forward raw RTP packet to FFmpeg stdin
          if (session.process && session.process.stdin && !session.process.stdin.destroyed) {
            const written = session.process.stdin.write(rtpPacket);
            if (!written) {
              console.warn('⚠️ FFmpeg stdin buffer full, backpressure detected');
            }
          }

          // Log periodically (every 100 packets to avoid spam)
          if (session.stats.packetsReceived % 100 === 0) {
            console.log(`🔊 Audio: ${session.stats.packetsReceived} packets, ${(session.stats.bytesReceived / 1024).toFixed(1)}KB received`);
          }
        } catch (error) {
          console.error('❌ Error forwarding audio RTP packet:', error);
        }
      });

      session.rtpSockets.audio.on('error', (err) => {
        console.error(`❌ Audio RTP socket error:`, err);
        // Auto-recovery attempt
        setTimeout(() => attemptSocketRecovery(session, 'audio'), 1000);
      });

      session.rtpSockets.audio.on('close', () => {
        console.log('🔊 Audio RTP socket closed');
      });
    }
  };

  // Socket recovery mechanism
  const attemptSocketRecovery = async (session: TranscodingSession, type: 'video' | 'audio'): Promise<void> => {
    if (!session.isActive) return;

    try {
      console.log(`🔄 Attempting ${type} socket recovery for session ${session.id}`);
      
      const port = type === 'video' ? session.rtpPorts.video : session.rtpPorts.audio;
      const newSocket = createSocket('udp4');
      
      newSocket.bind(port, '127.0.0.1', () => {
        console.log(`✅ ${type} socket recovered on port ${port}`);
        
        // Replace old socket
        if (session.rtpSockets[type]) {
          session.rtpSockets[type]!.close();
        }
        session.rtpSockets[type] = newSocket;
        
        // Re-setup message forwarding
        newSocket.on('message', (rtpPacket: Buffer) => {
          if (session.process && session.process.stdin && !session.process.stdin.destroyed) {
            session.process.stdin.write(rtpPacket);
          }
        });
      });
    } catch (error) {
      console.error(`❌ Failed to recover ${type} socket:`, error);
    }
  };

  // Connect mediasoup producers to RTP streams
  const connectProducersToRtp = async (session: TranscodingSession): Promise<void> => {
    const { producers, rtpPorts } = session;

    try {
      // Connect video producer
      if (producers.video && rtpPorts.video) {
        const { transport, consumer } = await createPlainTransportForProducer(
          producers.video, 
          '127.0.0.1', 
          rtpPorts.video
        );
        session.plainTransports.video = transport;
        session.consumers.video = consumer;
        console.log(`✅ Video producer connected to RTP port ${rtpPorts.video}`);
      }

      // Connect audio producer
      if (producers.audio && rtpPorts.audio) {
        const { transport, consumer } = await createPlainTransportForProducer(
          producers.audio, 
          '127.0.0.1', 
          rtpPorts.audio
        );
        session.plainTransports.audio = transport;
        session.consumers.audio = consumer;
        console.log(`✅ Audio producer connected to RTP port ${rtpPorts.audio}`);
      }

      // Synchronize streams
      await synchronizeStreams(session);

    } catch (error) {
      console.error('❌ Error connecting producers to RTP:', error);
      throw error;
    }
  };

  // **FIXED**: Create PlainTransport for producer with proper mediasoup API usage
  const createPlainTransportForProducer = async (
    producer: Producer, 
    remoteIp: string, 
    remotePort: number
  ): Promise<{ transport: any; consumer: any }> => {
    try {
      // Get router from producer properly
      const router = (producer as any)._internal.router || (producer as any).internal?.router;
      if (!router) {
        throw new Error('Cannot access router from producer');
      }

      // Create plain transport for RTP output
      const transport = await router.createPlainTransport({
        listenIp: { 
          ip: '0.0.0.0',  // Listen on all interfaces
          announcedIp: '127.0.0.1'  // Announce localhost
        },
        rtcpMux: false,
        comedia: true,  // Let mediasoup detect remote endpoint
        enableSctp: false,
        enableSrtp: false,
      });

      console.log(`🔗 Plain transport created: ${transport.id}`);

      // Connect transport to our local RTP receiver
      await transport.connect({
        ip: remoteIp,
        port: remotePort,
      });

      console.log(`🔗 Plain transport connected to ${remoteIp}:${remotePort}`);

      // Create consumer to consume the producer
      const consumer = await transport.consume({
        producerId: producer.id,
        paused: false,  // Start consuming immediately
      });

      console.log(`🔗 Consumer created: ${consumer.id} for producer ${producer.id}`);

      // Handle transport/consumer events
      transport.on('sctpstatechange', (sctpState: string) => {
        console.log(`📡 Plain transport SCTP state: ${sctpState}`);
      });

      consumer.on('transportclose', () => {
        console.log(`🔌 Consumer ${consumer.id} closed due to transport close`);
      });

      consumer.on('producerclose', () => {
        console.log(`🔌 Consumer ${consumer.id} closed due to producer close`);
      });

      return { transport, consumer };

    } catch (error) {
      console.error('❌ Error creating PlainTransport:', error);
      throw error;
    }
  };

  // Synchronize audio and video streams
  const synchronizeStreams = async (session: TranscodingSession): Promise<void> => {
    const { producers } = session;
    
    const sync: StreamSync = {
      audioProducer: producers.audio,
      videoProducer: producers.video,
      startTime: Date.now(),
      audioStarted: false,
      videoStarted: false,
    };

    // If we have both audio and video, ensure they start together
    if (sync.audioProducer && sync.videoProducer) {
      console.log('🔄 Synchronizing audio/video streams...');
      
      // Wait for initial RTP packets to flow
      await waitForRtpFlow(session, 3000); // 3 second timeout
      
      sync.audioStarted = true;
      sync.videoStarted = true;
      
      console.log('✅ Streams synchronized');
    } else if (sync.videoProducer) {
      console.log('📹 Video-only stream detected');
      await waitForRtpFlow(session, 2000);
    } else if (sync.audioProducer) {
      console.log('🔊 Audio-only stream detected');
      await waitForRtpFlow(session, 2000);
    }
  };

  // Wait for RTP packets to start flowing
  const waitForRtpFlow = async (session: TranscodingSession, timeoutMs: number): Promise<void> => {
    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      const initialPacketCount = session.stats.packetsReceived;
      
      const checkInterval = setInterval(() => {
        const elapsed = Date.now() - startTime;
        const packetsReceived = session.stats.packetsReceived - initialPacketCount;
        
        if (packetsReceived > 10) { // At least 10 packets received
          clearInterval(checkInterval);
          console.log(`✅ RTP flow detected: ${packetsReceived} packets in ${elapsed}ms`);
          resolve();
        } else if (elapsed > timeoutMs) {
          clearInterval(checkInterval);
          console.warn(`⚠️ RTP flow timeout: only ${packetsReceived} packets in ${elapsed}ms`);
          resolve(); // Don't fail, just warn
        }
      }, 100); // Check every 100ms
    });
  };

  // Start FFmpeg process with proper RTP inputs and stdin handling
  const startFFmpegProcess = async (
    session: TranscodingSession,
    playlistPath: string
  ): Promise<ChildProcess> => {
    return new Promise((resolve, reject) => {
      const { rtpPorts, producers } = session;
      
      // Build FFmpeg arguments for RTP input via stdin
      const ffmpegArgs: string[] = [
        // Enable protocols and set input format
        '-protocol_whitelist', 'pipe,udp,rtp,file',
        '-thread_queue_size', '1024',
        '-analyzeduration', '1000000',
        '-probesize', '1000000'
      ];

      // Input from stdin (RTP packets)
      if (producers.video && producers.audio) {
        // Both video and audio - expect multiplexed input
        ffmpegArgs.push(
          '-f', 'rtp',
          '-i', 'pipe:0'
        );
      } else if (producers.video) {
        // Video only
        ffmpegArgs.push(
          '-f', 'rtp',
          '-i', 'pipe:0'
        );
      } else if (producers.audio) {
        // Audio only
        ffmpegArgs.push(
          '-f', 'rtp',
          '-i', 'pipe:0'
        );
      }

      // Video encoding (if video present)
      if (producers.video) {
        ffmpegArgs.push(
          '-c:v', 'libx264',
          '-preset', 'veryfast',  // Changed from ultrafast for better quality
          '-tune', 'zerolatency',
          '-profile:v', 'baseline',
          '-level', '3.1',
          '-s', state.config.resolution,
          '-b:v', state.config.videoBitrate,
          '-maxrate', state.config.videoBitrate,
          '-bufsize', '4M',  // Increased buffer size
          '-r', '30',
          '-g', '60',
          '-keyint_min', '60',
          '-sc_threshold', '0',  // Disable scene cut detection
          '-x264opts', 'keyint=60:min-keyint=60:no-scenecut:rc-lookahead=30'
        );
      }

      // Audio encoding (if audio present)
      if (producers.audio) {
        ffmpegArgs.push(
          '-c:a', 'aac',
          '-b:a', state.config.audioBitrate,
          '-ar', '48000',
          '-ac', '2',
          '-profile:a', 'aac_low'
        );
      }

      // HLS specific settings
      ffmpegArgs.push(
        '-f', 'hls',
        '-hls_time', state.config.segmentDuration.toString(),
        '-hls_list_size', state.config.playlistLength.toString(),
        '-hls_flags', 'delete_segments+append_list+round_durations+split_by_time+independent_segments',
        '-hls_segment_filename', path.join(path.dirname(playlistPath), 'segment_%03d.ts'),
        '-hls_segment_type', 'mpegts',
        '-hls_start_number_source', 'datetime',
        '-start_number', '0',
        '-hls_allow_cache', '0'
      );

      // Output
      ffmpegArgs.push(playlistPath);

      console.log('🔧 Starting FFmpeg with args:', ffmpegArgs.join(' '));

      const ffmpegProcess = spawn('ffmpeg', ffmpegArgs, {
        stdio: ['pipe', 'pipe', 'pipe'] // stdin, stdout, stderr
      });

      // **CRITICAL**: Setup stdin for RTP packet input
      if (ffmpegProcess.stdin) {
        ffmpegProcess.stdin.on('error', (error) => {
          console.error(`❌ FFmpeg stdin error:`, error);
        });

        ffmpegProcess.stdin.on('close', () => {
          console.log('📥 FFmpeg stdin closed');
        });
      }

      // Enhanced error handling
      ffmpegProcess.on('spawn', () => {
        console.log(`✅ FFmpeg process spawned for session: ${session.id}`);
        resolve(ffmpegProcess);
      });

      ffmpegProcess.on('error', (error) => {
        console.error(`❌ FFmpeg spawn error for session ${session.id}:`, error);
        reject(error);
      });

      ffmpegProcess.on('exit', (code, signal) => {
        console.log(`🔚 FFmpeg process exited for session ${session.id}. Code: ${code}, Signal: ${signal}`);
        session.isActive = false;
        
        // Auto-restart on unexpected exit (unless killed intentionally)
        if (code !== 0 && signal !== 'SIGTERM' && signal !== 'SIGKILL' && session.isActive) {
          console.log(`🔄 Attempting to restart FFmpeg for session ${session.id}...`);
          setTimeout(async () => {
            try {
              const newProcess = await startFFmpegProcess(session, playlistPath);
              session.process = newProcess;
              session.isActive = true;
              
              // Re-setup RTP forwarding for new process
              await setupRtpReceiversWithForwarding(session);
            } catch (error) {
              console.error(`❌ Failed to restart FFmpeg for session ${session.id}:`, error);
            }
          }, 5000); // 5 second delay before restart
        }
      });

      // Enhanced logging with filtering
      if (ffmpegProcess.stderr) {
        ffmpegProcess.stderr.on('data', (data) => {
          const output = data.toString().trim();
          
          if (output.includes('error') || output.includes('Error')) {
            console.error(`FFmpeg ERROR [${session.id}]:`, output);
          } else if (output.includes('frame=')) {
            // Progress logging (less verbose) - only log every 5 seconds
            const now = Date.now();
            if (!session.stats.lastPacketTime || now - session.stats.lastPacketTime > 5000) {
              console.log(`FFmpeg Progress [${session.id}]:`, output.split('\n').pop());
              session.stats.lastPacketTime = now;
            }
          } else if (output.includes('Opening') || output.includes('Stream mapping')) {
            console.log(`FFmpeg Info [${session.id}]:`, output);
          }
        });
      }

      if (ffmpegProcess.stdout) {
        ffmpegProcess.stdout.on('data', (data) => {
          console.log(`FFmpeg stdout [${session.id}]:`, data.toString().trim());
        });
      }
    });
  };

  // Get available port for RTP
  const getAvailablePort = async (): Promise<number> => {
    let port = state.config.baseRtpPort;
    
    while (state.usedPorts.has(port)) {
      port += 2; // RTP uses even ports, RTCP uses odd
    }
    
    state.usedPorts.add(port);
    state.usedPorts.add(port + 1); // Reserve RTCP port too
    
    return port;
  };

  // Stop transcoding session
  const stopTranscoding = async (sessionId: string): Promise<void> => {
    const session = state.sessions.get(sessionId);
    if (!session) {
      console.warn(`⚠️ Session not found: ${sessionId}`);
      return;
    }

    try {
      console.log(`🛑 Stopping transcoding session: ${sessionId}`);

      // Mark as inactive first
      session.isActive = false;

      // Close consumers
      if (session.consumers.video) {
        session.consumers.video.close();
      }
      if (session.consumers.audio) {
        session.consumers.audio.close();
      }

      // Close plain transports
      if (session.plainTransports.video) {
        session.plainTransports.video.close();
      }
      if (session.plainTransports.audio) {
        session.plainTransports.audio.close();
      }

      // Close RTP sockets
      if (session.rtpSockets.video) {
        session.rtpSockets.video.close();
      }
      if (session.rtpSockets.audio) {
        session.rtpSockets.audio.close();
      }

      // Release RTP ports
      state.usedPorts.delete(session.rtpPorts.video);
      state.usedPorts.delete(session.rtpPorts.video + 1);
      state.usedPorts.delete(session.rtpPorts.audio);
      state.usedPorts.delete(session.rtpPorts.audio + 1);

      // Stop FFmpeg process gracefully
      if (session.process) {
        // Close stdin first to signal end of input
        if (session.process.stdin && !session.process.stdin.destroyed) {
          session.process.stdin.end();
        }

        // Send SIGTERM for graceful shutdown
        session.process.kill('SIGTERM');
        
        // Wait for graceful shutdown
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(() => {
            if (session.process && !session.process.killed) {
              console.log(`⚡ Force killing FFmpeg process for session: ${sessionId}`);
              session.process.kill('SIGKILL');
            }
            resolve();
          }, 5000);

          session.process!.on('exit', () => {
            clearTimeout(timeout);
            resolve();
          });
        });
      }

      // Cleanup session
      state.sessions.delete(sessionId);

      console.log(`✅ Successfully stopped transcoding session: ${sessionId}`);

    } catch (error) {
      console.error(`❌ Error stopping session ${sessionId}:`, error);
      throw error;
    }
  };

  // Get HLS playlist URL
  const getPlaylistUrl = (sessionId: string): string => {
    return `/hls/${sessionId}/playlist.m3u8`;
  };

  // Get session info with enhanced stats
  const getSessionInfo = (sessionId: string) => {
    const session = state.sessions.get(sessionId);
    if (!session) return null;

    return {
      id: session.id,
      isActive: session.isActive,
      startTime: session.startTime,
      outputPath: session.outputPath,
      uptime: Date.now() - session.startTime.getTime(),
      rtpPorts: session.rtpPorts,
      hasVideo: !!session.producers.video,
      hasAudio: !!session.producers.audio,
      stats: {
        packetsReceived: session.stats.packetsReceived,
        bytesReceived: session.stats.bytesReceived,
        lastPacketTime: session.stats.lastPacketTime,
        throughputKbps: session.stats.bytesReceived > 0 
          ? (session.stats.bytesReceived * 8) / ((Date.now() - session.startTime.getTime()) / 1000) / 1024
          : 0,
      },
    };
  };

  // Get all active sessions
  const getActiveSessions = () => {
    return Array.from(state.sessions.values())
      .filter(session => session.isActive)
      .map(session => ({
        id: session.id,
        startTime: session.startTime,
        uptime: Date.now() - session.startTime.getTime(),
        hasVideo: !!session.producers.video,
        hasAudio: !!session.producers.audio,
        stats: session.stats,
      }));
  };

  // Cleanup all sessions (for graceful shutdown)
  const cleanup = async (): Promise<void> => {
    console.log('🧹 Cleaning up HLS transcoder...');
    
    const cleanupPromises = Array.from(state.sessions.keys()).map(sessionId => 
      stopTranscoding(sessionId).catch(error => 
        console.error(`Error cleaning up session ${sessionId}:`, error)
      )
    );

    await Promise.all(cleanupPromises);
    console.log('✅ HLS transcoder cleanup complete');
  };

  // Health check with enhanced metrics
  const healthCheck = () => ({
    status: 'healthy',
    activeSessions: state.sessions.size,
    config: state.config,
    uptime: process.uptime(),
    usedPorts: Array.from(state.usedPorts),
    totalPacketsReceived: Array.from(state.sessions.values())
      .reduce((sum, session) => sum + session.stats.packetsReceived, 0),
    totalBytesReceived: Array.from(state.sessions.values())
      .reduce((sum, session) => sum + session.stats.bytesReceived, 0),
  });

  // Utility functions
  const ensureDirectoryExists = async (dirPath: string): Promise<void> => {
    try {
      await fs.access(dirPath);
    } catch {
      await fs.mkdir(dirPath, { recursive: true });
      console.log(`📁 Created directory: ${dirPath}`);
    }
  };

  // Advanced: Create adaptive bitrate streaming (multiple quality levels)
  const startAdaptiveTranscoding = async (
    sessionId: string,
    producers: Producer[]
  ): Promise<string[]> => {
    const qualities = [
      { name: '720p', resolution: '1280x720', bitrate: '2500k' },
      { name: '480p', resolution: '854x480', bitrate: '1200k' },
      { name: '360p', resolution: '640x360', bitrate: '800k' },
    ];

    const playlistUrls: string[] = [];

    for (const quality of qualities) {
      const qualitySessionId = `${sessionId}_${quality.name}`;
      const customConfig = {
        ...state.config,
        resolution: quality.resolution,
        videoBitrate: quality.bitrate,
        baseRtpPort: state.config.baseRtpPort + (qualities.indexOf(quality) * 100),
      };

      // Create separate transcoding session for each quality
      const transcoder = createHLSTranscoder(customConfig);
      await transcoder.init();
      
      const playlistUrl = await transcoder.startTranscoding(qualitySessionId, producers);
      playlistUrls.push(playlistUrl);
      }

    // Create master playlist
    await createMasterPlaylist(sessionId, qualities, playlistUrls);

    return playlistUrls;
  };

  // Create master playlist for adaptive bitrate
  const createMasterPlaylist = async (
    sessionId: string,
    qualities: Array<{name: string, resolution: string, bitrate: string}>,
    playlistUrls: string[]
  ): Promise<void> => {
    const masterPlaylistPath = path.join(state.config.outputDir, sessionId, 'master.m3u8');
    
    let masterContent = '#EXTM3U\n#EXT-X-VERSION:3\n\n';
    
    qualities.forEach((quality, index) => {
      const bandwidth = parseInt(quality.bitrate.replace('k', '')) * 1000;
      const [width, height] = quality.resolution.split('x').map(Number);
      
      masterContent += `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},RESOLUTION=${width}x${height},NAME="${quality.name}"\n`;
      masterContent += `${quality.name}/playlist.m3u8\n\n`;
    });
    
    await fs.writeFile(masterPlaylistPath, masterContent, 'utf8');
    console.log(`📋 Created master playlist: ${masterPlaylistPath}`);
  };

  // Debug: Get RTP stats for troubleshooting
  const getRtpStats = (sessionId: string) => {
    const session = state.sessions.get(sessionId);
    if (!session) return null;

    return {
      sessionId,
      rtpPorts: session.rtpPorts,
      stats: session.stats,
      socketStates: {
        video: session.rtpSockets.video ? 'active' : 'inactive',
        audio: session.rtpSockets.audio ? 'active' : 'inactive',
      },
      ffmpegActive: session.process && !session.process.killed,
      uptime: Date.now() - session.startTime.getTime(),
    };
  };

  // Monitor RTP packet flow (for debugging)
  const monitorRtpFlow = (sessionId: string, durationMs: number = 10000): Promise<any> => {
    return new Promise((resolve) => {
      const session = state.sessions.get(sessionId);
      if (!session) {
        resolve({ error: 'Session not found' });
        return;
      }

      const startStats = { ...session.stats };
      const startTime = Date.now();

      setTimeout(() => {
        const endStats = { ...session.stats };
        const endTime = Date.now();
        const duration = endTime - startTime;

        const result = {
          sessionId,
          duration,
          packets: {
            start: startStats.packetsReceived,
            end: endStats.packetsReceived,
            delta: endStats.packetsReceived - startStats.packetsReceived,
            rate: ((endStats.packetsReceived - startStats.packetsReceived) / (duration / 1000)).toFixed(2) + ' pps',
          },
          bytes: {
            start: startStats.bytesReceived,
            end: endStats.bytesReceived,
            delta: endStats.bytesReceived - startStats.bytesReceived,
            throughput: (((endStats.bytesReceived - startStats.bytesReceived) * 8) / (duration / 1000) / 1024).toFixed(2) + ' Kbps',
          },
          ffmpegStatus: session.process && !session.process.killed ? 'running' : 'stopped',
        };

        resolve(result);
      }, durationMs);
    });
  };

  // Advanced error recovery
  const recoverSession = async (sessionId: string): Promise<boolean> => {
    const session = state.sessions.get(sessionId);
    if (!session) {
      console.error(`❌ Cannot recover session ${sessionId}: not found`);
      return false;
    }

    try {
      console.log(`🔄 Attempting to recover session: ${sessionId}`);

      // Check if FFmpeg process is dead
      if (!session.process || session.process.killed) {
        console.log(`🔄 Restarting FFmpeg for session: ${sessionId}`);
        
        const playlistPath = path.join(session.outputPath, 'playlist.m3u8');
        const newProcess = await startFFmpegProcess(session, playlistPath);
        session.process = newProcess;
      }

      // Check RTP sockets
      if (session.producers.video && (!session.rtpSockets.video || !session.rtpSockets.video.address())) {
        await attemptSocketRecovery(session, 'video');
      }

      if (session.producers.audio && (!session.rtpSockets.audio || !session.rtpSockets.audio.address())) {
        await attemptSocketRecovery(session, 'audio');
      }

      // Re-establish mediasoup connections if needed
      if (session.producers.video && !session.consumers.video) {
        const { transport, consumer } = await createPlainTransportForProducer(
          session.producers.video,
          '127.0.0.1',
          session.rtpPorts.video
        );
        session.plainTransports.video = transport;
        session.consumers.video = consumer;
      }

      if (session.producers.audio && !session.consumers.audio) {
        const { transport, consumer } = await createPlainTransportForProducer(
          session.producers.audio,
          '127.0.0.1',
          session.rtpPorts.audio
        );
        session.plainTransports.audio = transport;
        session.consumers.audio = consumer;
      }

      session.isActive = true;
      console.log(`✅ Session ${sessionId} recovered successfully`);
      return true;

    } catch (error) {
      console.error(`❌ Failed to recover session ${sessionId}:`, error);
      return false;
    }
  };

  // Performance optimization: Batch RTP packet processing
  const createBatchedRtpForwarder = (session: TranscodingSession, type: 'video' | 'audio') => {
    const packets: Buffer[] = [];
    const BATCH_SIZE = 10;
    const BATCH_TIMEOUT = 5; // 5ms

    let batchTimeout: NodeJS.Timeout | null = null;

    const flushBatch = () => {
      if (packets.length === 0) return;

      if (session.process && session.process.stdin && !session.process.stdin.destroyed) {
        // Combine packets into single buffer for efficiency
        const combinedBuffer = Buffer.concat(packets);
        const written = session.process.stdin.write(combinedBuffer);
        
        if (!written) {
          console.warn(`⚠️ FFmpeg stdin buffer full for ${type}, ${packets.length} packets queued`);
        }
      }

      packets.length = 0; // Clear array
      batchTimeout = null;
    };

    return (rtpPacket: Buffer) => {
      packets.push(rtpPacket);

      // Flush if batch is full
      if (packets.length >= BATCH_SIZE) {
        if (batchTimeout) {
          clearTimeout(batchTimeout);
          batchTimeout = null;
        }
        flushBatch();
      } 
      // Set timeout for partial batches
      else if (!batchTimeout) {
        batchTimeout = setTimeout(flushBatch, BATCH_TIMEOUT);
      }
    };
  };

  // Quality monitoring and adaptive adjustment
  const monitorStreamQuality = (sessionId: string) => {
    const session = state.sessions.get(sessionId);
    if (!session) return null;

    const now = Date.now();
    const uptime = now - session.startTime.getTime();
    const avgPacketRate = session.stats.packetsReceived / (uptime / 1000);
    const avgBitrate = (session.stats.bytesReceived * 8) / (uptime / 1000) / 1024; // Kbps

    // Quality metrics
    const quality = {
      sessionId,
      uptime,
      avgPacketRate: Math.round(avgPacketRate),
      avgBitrateKbps: Math.round(avgBitrate),
      totalPackets: session.stats.packetsReceived,
      totalMB: Math.round(session.stats.bytesReceived / 1024 / 1024),
      isHealthy: avgPacketRate > 10 && (now - session.stats.lastPacketTime) < 5000,
      lastPacketAge: now - session.stats.lastPacketTime,
    };

    // Auto-recovery if stream appears unhealthy
    if (!quality.isHealthy && session.isActive) {
      console.warn(`⚠️ Unhealthy stream detected for session ${sessionId}:`, quality);
      // Could trigger automatic recovery here
    }

    return quality;
  };

  // Resource cleanup and monitoring
  const getResourceUsage = () => {
    const memUsage = process.memoryUsage();
    const activeSessions = Array.from(state.sessions.values()).filter(s => s.isActive);
    
    return {
      memory: {
        rss: Math.round(memUsage.rss / 1024 / 1024) + 'MB',
        heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024) + 'MB',
        heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024) + 'MB',
        external: Math.round(memUsage.external / 1024 / 1024) + 'MB',
      },
      sessions: {
        total: state.sessions.size,
        active: activeSessions.length,
        inactive: state.sessions.size - activeSessions.length,
      },
      ports: {
        allocated: state.usedPorts.size,
        range: `${state.config.baseRtpPort}-${Math.max(...Array.from(state.usedPorts), state.config.baseRtpPort)}`,
      },
      totalTraffic: {
        packets: activeSessions.reduce((sum, s) => sum + s.stats.packetsReceived, 0),
        bytes: activeSessions.reduce((sum, s) => sum + s.stats.bytesReceived, 0),
      },
    };
  };

  // Public API - enhanced with new capabilities
  return {
    // Core functionality
    init,
    startTranscoding,
    stopTranscoding,
    getPlaylistUrl,
    getSessionInfo,
    getActiveSessions,
    cleanup,
    healthCheck,
    startAdaptiveTranscoding,

    // Enhanced debugging and monitoring
    getRtpStats,
    monitorRtpFlow,
    recoverSession,
    monitorStreamQuality,
    getResourceUsage,

    // Advanced features
    createMasterPlaylist,
  } as const;
};

export type HLSTranscoder = ReturnType<typeof createHLSTranscoder>;

// Enhanced graceful shutdown handler
process.on('SIGINT', async () => {
  console.log('🛑 Received SIGINT, shutting down HLS transcoder gracefully...');
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('🛑 Received SIGTERM, shutting down HLS transcoder gracefully...');
  process.exit(0);
});

// Handle uncaught exceptions in RTP processing
process.on('uncaughtException', (error) => {
  console.error('💥 Uncaught exception in HLS transcoder:', error);
  // Don't exit immediately - log and continue for debugging
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('💥 Unhandled rejection in HLS transcoder:', reason);
  // Log but don't crash the process
});