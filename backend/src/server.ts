import express from 'express';
import cors from 'cors';
import { createServer as createHttpServer } from 'http'; // Renamed import
import path from 'path';
import { createMediasoupServer } from './mediasoup-server';
import { createSignalingServer } from './signaling-server';
import { createHLSTranscoder } from './hls-transcoder';

// Types
interface ServerState {
  mediasoupServer: ReturnType<typeof createMediasoupServer>;
  signalingServer: ReturnType<typeof createSignalingServer>;
  hlsTranscoder: ReturnType<typeof createHLSTranscoder>;
}

// Configuration
const CONFIG = {
  HTTP_PORT: process.env.HTTP_PORT ? parseInt(process.env.HTTP_PORT) : 3001,
  NODE_ENV: process.env.NODE_ENV || 'development',
  HLS_OUTPUT_DIR: './hls-output',
} as const;

// Create Express app and HTTP server
const app = express();
const httpServer = createHttpServer(app); // Fixed: using renamed import

// Middleware
app.use(cors({
  origin: process.env.NODE_ENV === 'production' 
    ? ['https://yourdomain.com'] 
    : ['http://localhost:3000', 'http://127.0.0.1:3000'],
  credentials: true,
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Request logging middleware
app.use((req, res, next) => {
  const timestamp = new Date().toISOString();
  console.log(`📝 ${timestamp} - ${req.method} ${req.path}`);
  next();
});

// Main server initialization function (renamed to avoid conflict)
const initializeServer = async (): Promise<ServerState> => {
  try {
    console.log('🚀 Starting Fermion Streaming Server...\n');

    // Initialize all components
    console.log('1️⃣ Initializing Mediasoup server...');
    const mediasoupServer = createMediasoupServer();
    await mediasoupServer.init();

    console.log('2️⃣ Initializing HLS transcoder...');
    const hlsTranscoder = createHLSTranscoder({
      outputDir: CONFIG.HLS_OUTPUT_DIR,
    });
    await hlsTranscoder.init();

    console.log('3️⃣ Initializing signaling server...');
    const signalingServer = createSignalingServer(httpServer, mediasoupServer);
    signalingServer.init();

    const state: ServerState = {
      mediasoupServer,
      signalingServer,
      hlsTranscoder,
    };

    // Setup routes
    setupRoutes(app, state);

    console.log('✅ All components initialized successfully!\n');
    return state;

  } catch (error) {
    console.error('❌ Failed to initialize server:', error);
    process.exit(1);
  }
};

// Setup API routes
const setupRoutes = (app: express.Application, state: ServerState) => {
  // Health check endpoint
  app.get('/api/health', (req, res) => {
    const clientsInfo = state.signalingServer.getClientsInfo();
    const hlsHealth = state.hlsTranscoder.healthCheck();
    
    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      clients: clientsInfo,
      hls: hlsHealth,
      version: '1.0.0',
    });
  });

  // Get router RTP capabilities (needed by frontend)
  app.get('/api/mediasoup/router-capabilities', (req, res) => {
    try {
      const capabilities = state.mediasoupServer.getRouterRtpCapabilities();
      res.json({ capabilities });
    } catch (error) {
      console.error('❌ Error getting router capabilities:', error);
      res.status(500).json({ 
        error: 'Failed to get router capabilities',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

  // Start HLS streaming session
  app.post('/api/hls/start/:sessionId', async (req, res) => {
    try {
      const { sessionId } = req.params;
      const producers = state.mediasoupServer.getAllProducers();
      
      if (producers.length === 0) {
        return res.status(400).json({
          error: 'No active producers found',
          message: 'Start streaming first before creating HLS session'
        });
      }

      const playlistUrl = await state.hlsTranscoder.startTranscoding(sessionId, producers);
      
      res.json({
        success: true,
        sessionId,
        playlistUrl,
        message: 'HLS transcoding started'
      });

    } catch (error) {
      console.error('❌ Error starting HLS session:', error);
      res.status(500).json({ 
        error: 'Failed to start HLS session',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

  // Stop HLS streaming session
  app.delete('/api/hls/stop/:sessionId', async (req, res) => {
    try {
      const { sessionId } = req.params;
      await state.hlsTranscoder.stopTranscoding(sessionId);
      
      res.json({
        success: true,
        sessionId,
        message: 'HLS transcoding stopped'
      });

    } catch (error) {
      console.error('❌ Error stopping HLS session:', error);
      res.status(500).json({ 
        error: 'Failed to stop HLS session',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

  // Get HLS session info
  app.get('/api/hls/session/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const sessionInfo = state.hlsTranscoder.getSessionInfo(sessionId);
    
    if (!sessionInfo) {
      return res.status(404).json({
        error: 'Session not found',
        sessionId
      });
    }

    res.json({
      success: true,
      session: sessionInfo
    });
  });

  // List active HLS sessions
  app.get('/api/hls/sessions', (req, res) => {
    const activeSessions = state.hlsTranscoder.getActiveSessions();
    res.json({
      success: true,
      sessions: activeSessions,
      count: activeSessions.length
    });
  });

  // Serve HLS files (playlist and segments)
  app.use('/hls', express.static(CONFIG.HLS_OUTPUT_DIR, {
    setHeaders: (res, filePath) => {
      // Set CORS headers for HLS files
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET');
      res.setHeader('Access-Control-Allow-Headers', 'Range');
      
      // Set appropriate content types
      if (filePath.endsWith('.m3u8')) {
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      } else if (filePath.endsWith('.ts')) {
        res.setHeader('Content-Type', 'video/mp2t');
      }
    }
  }));

  // WebSocket info endpoint
  app.get('/api/ws/info', (req, res) => {
    const clientsInfo = state.signalingServer.getClientsInfo();
    res.json({
      success: true,
      websocket: {
        url: `ws://localhost:${CONFIG.HTTP_PORT}`,
        clients: clientsInfo,
      }
    });
  });

  // Debug endpoints (only in development)
  if (CONFIG.NODE_ENV === 'development') {
    app.get('/api/debug/producers', (req, res) => {
      const producers = state.mediasoupServer.getAllProducers();
      res.json({
        success: true,
        producers: producers.map(p => ({
          id: p.id,
          kind: p.kind,
          type: p.type,
          paused: p.paused,
        }))
      });
    });

    app.post('/api/debug/broadcast', (req, res) => {
      const { message } = req.body;
      state.signalingServer.broadcastToAll({
        type: 'debug-message',
        data: { message, timestamp: Date.now() }
      });
      res.json({ success: true, message: 'Message broadcasted' });
    });
  }

  // Catch-all for undefined routes
  app.use('/api/*catchAll', (req, res) => {
    res.status(404).json({
      error: 'API endpoint not found',
      path: req.path,
      method: req.method
    });
  });
};

// Graceful shutdown handler
const setupGracefulShutdown = (state: ServerState) => {
  const shutdown = async (signal: string) => {
    console.log(`\n🛑 Received ${signal}, shutting down gracefully...`);
    
    try {
      // Stop accepting new connections
      httpServer.close(() => {
        console.log('📡 HTTP server closed');
      });

      // Cleanup HLS transcoder
      await state.hlsTranscoder.cleanup();
      
      console.log('✅ Graceful shutdown complete');
      process.exit(0);
    } catch (error) {
      console.error('❌ Error during shutdown:', error);
      process.exit(1);
    }
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  
  // Handle uncaught exceptions
  process.on('uncaughtException', (error) => {
    console.error('💥 Uncaught Exception:', error);
    shutdown('uncaughtException');
  });

  process.on('unhandledRejection', (reason, promise) => {
    console.error('💥 Unhandled Rejection at:', promise, 'reason:', reason);
    shutdown('unhandledRejection');
  });
};

// Start the server
const startServer = async () => {
  try {
    const state = await initializeServer(); // Fixed: now returns ServerState
    setupGracefulShutdown(state);

    httpServer.listen(CONFIG.HTTP_PORT, () => {
      console.log('🌟 ================================');
      console.log(`🚀 Fermion Streaming Server is running!`);
      console.log(`📡 HTTP Server: http://localhost:${CONFIG.HTTP_PORT}`);
      console.log(`🔌 WebSocket: ws://localhost:${CONFIG.HTTP_PORT}`);
      console.log(`📺 HLS Endpoint: http://localhost:${CONFIG.HTTP_PORT}/hls/`);
      console.log(`❣️  Health Check: http://localhost:${CONFIG.HTTP_PORT}/api/health`);
      console.log('🌟 ================================\n');
      
      if (CONFIG.NODE_ENV === 'development') {
        console.log('🛠️  Development mode - Debug endpoints available');
        console.log(`🔍 Debug Producers: http://localhost:${CONFIG.HTTP_PORT}/api/debug/producers`);
        console.log('');
      }
    });

  } catch (error) {
    console.error('💥 Failed to start server:', error);
    process.exit(1);
  }
};

// Start the server
startServer();