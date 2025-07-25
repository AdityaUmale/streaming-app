import ffmpeg from 'fluent-ffmpeg';
import { spawn, ChildProcess } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import { Producer } from 'mediasoup/node/lib/types';

// Types first
interface HLSConfig {
  outputDir: string;
  segmentDuration: number;
  playlistLength: number;
  resolution: string;
  videoBitrate: string;
  audioBitrate: string;
}

interface TranscodingSession {
  id: string;
  process: ChildProcess | null;
  isActive: boolean;
  startTime: Date;
  outputPath: string;
}

interface HLSState {
  config: HLSConfig;
  sessions: Map<string, TranscodingSession>;
  rtmpPort: number;
}

// Default configuration
const DEFAULT_HLS_CONFIG: HLSConfig = {
  outputDir: './hls-output',
  segmentDuration: 4, // 4 second segments
  playlistLength: 10, // Keep 10 segments in playlist
  resolution: '1280x720',
  videoBitrate: '2500k',
  audioBitrate: '128k',
} as const;

// Factory function for HLS transcoder
export const createHLSTranscoder = (customConfig?: Partial<HLSConfig>) => {
  const state: HLSState = {
    config: { ...DEFAULT_HLS_CONFIG, ...customConfig },
    sessions: new Map(),
    rtmpPort: 1935,
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

      // Create playlist file path
      const playlistPath = path.join(outputPath, 'playlist.m3u8');

      // Start FFmpeg process for transcoding
      const ffmpegProcess = await startFFmpegProcess(sessionId, producers, playlistPath);

      // Create session
      const session: TranscodingSession = {
        id: sessionId,
        process: ffmpegProcess,
        isActive: true,
        startTime: new Date(),
        outputPath,
      };

      state.sessions.set(sessionId, session);

      console.log(`🎬 Started HLS transcoding session: ${sessionId}`);
      return playlistPath;

    } catch (error) {
      console.error(`❌ Failed to start transcoding for session ${sessionId}:`, error);
      throw error;
    }
  };

  // Start FFmpeg process using pipe from mediasoup
  const startFFmpegProcess = async (
    sessionId: string,
    producers: Producer[],
    playlistPath: string
  ): Promise<ChildProcess> => {
    return new Promise((resolve, reject) => {
      // FFmpeg command for HLS transcoding
      const ffmpegArgs = [
        '-f', 'webm', // Input format from WebRTC
        '-i', 'pipe:0', // Read from stdin
        
        // Video encoding
        '-c:v', 'libx264',
        '-preset', 'ultrafast', // Fast encoding for live streaming
        '-tune', 'zerolatency',
        '-profile:v', 'baseline',
        '-level', '3.0',
        '-s', state.config.resolution,
        '-b:v', state.config.videoBitrate,
        '-maxrate', state.config.videoBitrate,
        '-bufsize', '3000k',
        '-r', '30', // 30 FPS
        '-g', '60', // GOP size
        
        // Audio encoding
        '-c:a', 'aac',
        '-b:a', state.config.audioBitrate,
        '-ar', '48000',
        '-ac', '2',
        
        // HLS specific settings
        '-f', 'hls',
        '-hls_time', state.config.segmentDuration.toString(),
        '-hls_list_size', state.config.playlistLength.toString(),
        '-hls_flags', 'delete_segments+append_list',
        '-hls_segment_filename', path.join(path.dirname(playlistPath), 'segment_%03d.ts'),
        
        // Output
        playlistPath
      ];

      console.log('🔧 Starting FFmpeg with args:', ffmpegArgs.join(' '));

      const ffmpegProcess = spawn('ffmpeg', ffmpegArgs, {
        stdio: ['pipe', 'pipe', 'pipe']
      });

      // Handle FFmpeg events
      ffmpegProcess.on('spawn', () => {
        console.log(`✅ FFmpeg process spawned for session: ${sessionId}`);
        resolve(ffmpegProcess);
      });

      ffmpegProcess.on('error', (error) => {
        console.error(`❌ FFmpeg spawn error for session ${sessionId}:`, error);
        reject(error);
      });

      ffmpegProcess.on('exit', (code, signal) => {
        console.log(`🔚 FFmpeg process exited for session ${sessionId}. Code: ${code}, Signal: ${signal}`);
        const session = state.sessions.get(sessionId);
        if (session) {
          session.isActive = false;
        }
      });

      // Log FFmpeg output
      if (ffmpegProcess.stderr) {
        ffmpegProcess.stderr.on('data', (data) => {
          console.log(`FFmpeg [${sessionId}]:`, data.toString().trim());
        });
      }

      if (ffmpegProcess.stdout) {
        ffmpegProcess.stdout.on('data', (data) => {
          console.log(`FFmpeg stdout [${sessionId}]:`, data.toString().trim());
        });
      }
    });
  };

  // Pipe producer data to FFmpeg
  const pipeProducerToFFmpeg = (sessionId: string, producer: Producer): void => {
    const session = state.sessions.get(sessionId);
    if (!session || !session.process) {
      console.error(`❌ No active session found: ${sessionId}`);
      return;
    }

    // This is a simplified approach - in real implementation,
    // you'd need to get RTP streams from mediasoup and convert to WebM
    console.log(`🔗 Piping producer ${producer.id} to FFmpeg for session ${sessionId}`);
    
    // Note: This is where you'd implement the actual RTP-to-WebM conversion
    // For now, this is a placeholder showing the architecture
  };

  // Stop transcoding session
  const stopTranscoding = async (sessionId: string): Promise<void> => {
    const session = state.sessions.get(sessionId);
    if (!session) {
      console.warn(`⚠️ Session not found: ${sessionId}`);
      return;
    }

    try {
      if (session.process && session.isActive) {
        session.process.kill('SIGTERM');
        
        // Wait for graceful shutdown
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(() => {
            if (session.process) {
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
      session.isActive = false;
      state.sessions.delete(sessionId);

      console.log(`🛑 Stopped transcoding session: ${sessionId}`);

    } catch (error) {
      console.error(`❌ Error stopping session ${sessionId}:`, error);
      throw error;
    }
  };

  // Get HLS playlist URL
  const getPlaylistUrl = (sessionId: string): string => {
    return `/hls/${sessionId}/playlist.m3u8`;
  };

  // Get session info
  const getSessionInfo = (sessionId: string) => {
    const session = state.sessions.get(sessionId);
    if (!session) return null;

    return {
      id: session.id,
      isActive: session.isActive,
      startTime: session.startTime,
      outputPath: session.outputPath,
      uptime: Date.now() - session.startTime.getTime(),
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

  // Health check
  const healthCheck = () => ({
    status: 'healthy',
    activeSessions: state.sessions.size,
    config: state.config,
    uptime: process.uptime(),
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
      };

      // Create separate transcoding session for each quality
      const transcoder = createHLSTranscoder(customConfig);
      await transcoder.init();
      
      const playlistUrl = await transcoder.startTranscoding(qualitySessionId, producers);
      playlistUrls.push(playlistUrl);
    }

    return playlistUrls;
  };

  // Public API
  return {
    init,
    startTranscoding,
    stopTranscoding,
    pipeProducerToFFmpeg,
    getPlaylistUrl,
    getSessionInfo,
    getActiveSessions,
    cleanup,
    healthCheck,
    startAdaptiveTranscoding,
  } as const;
};

export type HLSTranscoder = ReturnType<typeof createHLSTranscoder>;

// Graceful shutdown handler
process.on('SIGINT', async () => {
  console.log('🛑 Received SIGINT, shutting down gracefully...');
  // Note: You'd call cleanup() on your transcoder instance here
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('🛑 Received SIGTERM, shutting down gracefully...');
  // Note: You'd call cleanup() on your transcoder instance here
  process.exit(0);
});