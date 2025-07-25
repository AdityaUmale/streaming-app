'use client';

import { useEffect, useRef, useState } from 'react';
import Hls from 'hls.js';

export default function WatchPage() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const [streamStatus, setStreamStatus] = useState('Waiting...');
  const [sessions, setSessions] = useState<string[]>([]);
  const [selectedSession, setSelectedSession] = useState<string>('');

  // Fetch available sessions
  const fetchSessions = async () => {
    try {
      const response = await fetch('http://localhost:3001/api/hls/sessions');
      if (response.ok) {
        const data = await response.json();
        const sessionIds = data.sessions?.map((s: any) => s.sessionId) || [];
        setSessions(sessionIds);
        
        // Auto-select first session
        if (sessionIds.length > 0 && !selectedSession) {
          setSelectedSession(sessionIds[0]);
        }
      }
    } catch (err) {
      console.error('Failed to fetch sessions:', err);
      setStreamStatus('Error fetching sessions');
    }
  };

  // Initialize HLS player
  const initHLS = (sessionId: string) => {
    if (!videoRef.current || !sessionId) return;

    const video = videoRef.current;
    const hlsUrl = `http://localhost:3001/hls/${sessionId}/playlist.m3u8`;

    // Clean up existing HLS
    if (hlsRef.current) {
      hlsRef.current.destroy();
    }

    setStreamStatus('Connecting...');

    if (Hls.isSupported()) {
      const hls = new Hls({
        debug: true,
        enableWorker: true,
        lowLatencyMode: true,
      });

      hlsRef.current = hls;
      hls.loadSource(hlsUrl);
      hls.attachMedia(video);

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        setStreamStatus('Connected - Playing');
        video.play().catch(console.error);
      });

      hls.on(Hls.Events.ERROR, (event, data) => {
        console.error('HLS Error:', data);
        setStreamStatus(`Error: ${data.details}`);
      });

    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      // Safari support
      video.src = hlsUrl;
      setStreamStatus('Connected - Playing');
    } else {
      setStreamStatus('HLS not supported');
    }
  };

  // Load sessions on mount
  useEffect(() => {
    fetchSessions();
    const interval = setInterval(fetchSessions, 5000);
    return () => clearInterval(interval);
  }, []);

  // Initialize HLS when session selected
  useEffect(() => {
    if (selectedSession) {
      initHLS(selectedSession);
    }
  }, [selectedSession]);

  // Cleanup
  useEffect(() => {
    return () => {
      if (hlsRef.current) {
        hlsRef.current.destroy();
      }
    };
  }, []);

  return (
    <div className="min-h-screen bg-gray-900 text-white">
      <div className="container mx-auto p-4">
        <h1 className="text-3xl font-bold mb-8">Watch Live Stream</h1>
        
        {/* Session Selector */}
        {sessions.length > 0 && (
          <div className="mb-4">
            <label className="block text-sm font-medium mb-2">Select Session:</label>
            <select 
              value={selectedSession}
              onChange={(e) => setSelectedSession(e.target.value)}
              className="bg-gray-800 text-white px-3 py-2 rounded border border-gray-600"
            >
              {sessions.map(sessionId => (
                <option key={sessionId} value={sessionId}>
                  Session: {sessionId}
                </option>
              ))}
            </select>
          </div>
        )}

        <div className="max-w-4xl mx-auto">
          <div className="bg-gray-800 rounded-lg p-4">
            <video
              ref={videoRef}
              className="w-full bg-black rounded"
              controls
              autoPlay
              muted
            />
          </div>
          <div className="mt-4 p-4 bg-gray-800 rounded">
            <p className="text-sm text-gray-400">
              Stream Status: <span className="text-green-400">{streamStatus}</span>
            </p>
            {sessions.length === 0 && (
              <p className="text-sm text-yellow-400 mt-2">
                No active sessions. Start streaming on /stream first.
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}